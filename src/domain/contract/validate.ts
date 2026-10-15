import { load } from 'js-yaml';

// API 계약(OpenAPI 조각)의 형식 검사 — 판정은 코드가 한다(P2). 내용이 좋은 계약인지는 BE 개발자가 본다.
// 여기서 보는 것은 "기계가 읽을 수 있는 계약인가"뿐이다: 나중에 V1A(계약 대조)가 이 조각과 실제 응답을 비교한다.
//
// - YAML(또는 JSON)로 읽혀야 한다. 객체여야 한다.
// - paths가 비어 있지 않고, 경로는 '/'로 시작하며, 경로마다 HTTP 메서드(get·post·put·patch·delete)가 하나 이상 있다.
// - 메서드마다 responses가 있고, 응답 키는 상태 코드(100~599) 또는 default다.
// - components는 있으면 객체다.

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
// 경로 항목에 메서드 말고 올 수 있는 키(OpenAPI Path Item).
const PATH_ITEM_EXTRAS = new Set(['parameters', 'summary', 'description', 'servers']);
export const CONTRACT_YAML_MAX = 100_000;

export type ContractCheck =
  | { ok: true; doc: Record<string, unknown>; operations: string[] }
  | { ok: false; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function checkContractYaml(text: string): ContractCheck {
  if (text.length > CONTRACT_YAML_MAX) return { ok: false, problems: [`계약이 너무 길다(${text.length}자, 최대 ${CONTRACT_YAML_MAX}자)`] };
  let doc: unknown;
  try {
    doc = load(text);
  } catch (err) {
    return { ok: false, problems: [`YAML로 읽을 수 없다: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`] };
  }
  if (!isObject(doc)) return { ok: false, problems: ['계약은 객체(paths·components)여야 한다'] };

  const problems: string[] = [];
  const operations: string[] = [];
  const paths = doc.paths;
  if (!isObject(paths) || Object.keys(paths).length === 0) {
    problems.push('paths가 비어 있다 — 경로가 하나 이상 있어야 한다');
  } else {
    for (const [path, item] of Object.entries(paths)) {
      if (!path.startsWith('/')) problems.push(`paths["${path}"] 경로는 '/'로 시작한다`);
      if (!isObject(item)) {
        problems.push(`paths["${path}"] 객체가 아니다`);
        continue;
      }
      const methods = Object.keys(item).filter((k) => METHODS.has(k.toLowerCase()));
      for (const key of Object.keys(item)) {
        if (!METHODS.has(key.toLowerCase()) && !PATH_ITEM_EXTRAS.has(key)) problems.push(`paths["${path}"].${key} 알 수 없는 키 — 메서드는 get·post·put·patch·delete`);
      }
      if (methods.length === 0) problems.push(`paths["${path}"] HTTP 메서드가 없다`);
      for (const method of methods) {
        const op = item[method];
        const where = `paths["${path}"].${method}`;
        if (!isObject(op)) {
          problems.push(`${where} 객체가 아니다`);
          continue;
        }
        const responses = op.responses;
        if (!isObject(responses) || Object.keys(responses).length === 0) {
          problems.push(`${where}.responses가 없다 — 응답 상태 코드를 하나 이상 적는다`);
          continue;
        }
        for (const code of Object.keys(responses)) {
          if (code !== 'default' && !/^[1-5][0-9]{2}$/.test(code)) problems.push(`${where}.responses["${code}"] 상태 코드가 아니다`);
        }
        operations.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  if (doc.components !== undefined && !isObject(doc.components)) problems.push('components는 객체여야 한다');
  return problems.length > 0 ? { ok: false, problems } : { ok: true, doc, operations };
}
