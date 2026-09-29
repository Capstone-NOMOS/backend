import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { load as loadYaml } from 'js-yaml';

// docs/openapi.yaml을 "응답이 실제로 이렇게 나간다"는 계약으로 쓴다.
// 손으로 쓴 문서라 코드와 어긋날 수 있다 — 그래서 테스트가 내는 모든 /api 응답을 이 문서로 검사한다
// (setup-invariants.ts가 res.json을 감싼다). 어긋나면 그 응답을 낸 테스트가 실패한다.
//
// 검사 규칙
//   - 성공(2xx) 응답은 그 경로·메서드·상태 코드에 schema가 **있어야** 하고, 그 schema에 맞아야 한다.
//     문서에 없는 필드가 오면 실패다(additionalProperties 기본 false) — "문서엔 id, 실제는 userId" 같은 어긋남을 잡는다.
//   - 실패(4xx·5xx) 응답은 경로별로 적지 않아도 되지만 공통 Error 형태여야 한다.
//   - /api 밖(/health, /docs)은 검사하지 않는다.

type Oas = {
  paths: Record<string, Record<string, { responses?: Record<string, OasResponse> }>>;
  components: { schemas: Record<string, unknown> };
};
type OasResponse = { content?: { 'application/json'?: { schema?: unknown } } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(HERE, '../../docs/openapi.yaml');

let spec: Oas | undefined;
export function loadSpec(): Oas {
  spec ??= loadYaml(readFileSync(SPEC_PATH, 'utf8')) as Oas;
  return spec;
}

// OpenAPI 3.0 스키마 → JSON Schema(draft-07, ajv). 다른 점은 둘뿐이다:
//   nullable: true  → null 허용
//   $ref            → #/definitions/<이름>
// 그리고 properties가 있는 객체는 additionalProperties를 명시하지 않았으면 false로 본다.
function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (typeof node !== 'object' || node === null) return node;
  const src = node as Record<string, unknown>;

  if (typeof src.$ref === 'string') {
    const ref = { $ref: src.$ref.replace('#/components/schemas/', '#/definitions/') };
    return src.nullable === true ? { anyOf: [ref, { type: 'null' }] } : ref;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === 'nullable' || key === 'example' || key === 'examples' || key === 'description') continue;
    if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSchema(v)]),
      );
    } else if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      out[key] = typeof value === 'boolean' ? value : toJsonSchema(value);
    } else if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
      out[key] = (value as unknown[]).map(toJsonSchema);
    } else {
      out[key] = value;
    }
  }
  if (out.properties !== undefined && out.additionalProperties === undefined && out.allOf === undefined) {
    out.additionalProperties = false;
  }
  if (src.nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  }
  return out;
}

let ajv: Ajv | undefined;
function getAjv(): Ajv {
  if (ajv) return ajv;
  ajv = new Ajv({ allErrors: true, strict: false });
  // ajv-formats는 CJS라 ESM에서 default가 한 번 더 감싸여 올 수 있다.
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv) => void;
  addFormats(ajv);
  return ajv;
}

const compiled = new Map<string, ValidateFunction>();
function compile(key: string, schema: unknown): ValidateFunction {
  let fn = compiled.get(key);
  if (!fn) {
    const definitions = Object.fromEntries(
      Object.entries(loadSpec().components.schemas).map(([k, v]) => [k, toJsonSchema(v)]),
    );
    fn = getAjv().compile({ ...(toJsonSchema(schema) as object), definitions });
    compiled.set(key, fn);
  }
  return fn;
}

// Express 라우트 경로(/tasks/:taskId/claim) → OpenAPI 경로(/tasks/{taskId}/claim)
export function toOasPath(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

// 지금까지 검사를 통과한 (메서드 경로 상태) — 커버리지 확인용.
export const seenOperations = new Set<string>();

export function checkResponse(method: string, routePath: string, status: number, body: unknown): string | null {
  const oasPath = toOasPath(routePath);
  const m = method.toLowerCase();
  const where = `${method.toUpperCase()} /api${routePath} → ${status}`;

  if (status >= 400) {
    const validate = compile('#Error', { $ref: '#/components/schemas/Error' });
    return validate(body) ? null : `${where}: 에러 응답이 공통 Error 형태가 아니다 ${getAjv().errorsText(validate.errors, { dataVar: 'body' })}`;
  }

  const op = loadSpec().paths[oasPath]?.[m];
  if (!op) return `${where}: docs/openapi.yaml에 이 경로·메서드가 없다`;
  const response = op.responses?.[String(status)];
  if (!response) return `${where}: docs/openapi.yaml에 이 상태 코드의 응답이 없다`;
  const schema = response.content?.['application/json']?.schema;
  if (schema === undefined) return `${where}: 성공 응답에 schema가 없다 (example만으로는 타입을 만들 수 없다)`;

  const validate = compile(`${m} ${oasPath} ${status}`, schema);
  if (!validate(body)) {
    return `${where}: 응답이 docs/openapi.yaml과 다르다\n  ${getAjv().errorsText(validate.errors, { separator: '\n  ' })}`;
  }
  seenOperations.add(`${m} ${oasPath} ${status}`);
  return null;
}
