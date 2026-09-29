import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import type { Queryable } from '../config/db.js';
import { findExampleIds } from './examples.js';

// 손으로 쓴 문서다. 코드와 자동 동기화되지 않으므로 어긋나면 코드가 맞다.
// 자동 생성(zod-to-openapi)은 나중 과제.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// dev(tsx, src/openapi/)와 build 후(dist/openapi/) 모두에서 같은 파일을 찾는다.
const CANDIDATES = [
  path.resolve(HERE, '../../docs/openapi.yaml'),
  path.resolve(process.cwd(), 'docs/openapi.yaml'),
];

let cached: unknown | undefined;

function baseSpec(): unknown {
  if (cached !== undefined) return cached;
  for (const candidate of CANDIDATES) {
    try {
      cached = load(readFileSync(candidate, 'utf-8'));
      return cached;
    } catch {
      // 다음 후보를 본다
    }
  }
  throw new Error(`docs/openapi.yaml을 찾을 수 없습니다 (${CANDIDATES.join(', ')})`);
}

// {{PROJECT_ID}} 같은 자리표를 실제 id로 바꿔서 돌려준다.
// 시드를 다시 돌려도 브라우저를 새로고침하면 맞는 값이 들어오게 하기 위해 요청마다 채운다.
// 값이 없으면(시드 전) 자리표를 그대로 남긴다 — 엉뚱한 uuid를 넣으면 눌러도 404만 난다.
export async function openApiSpec(db: Queryable, options: { includeInviteToken: boolean }): Promise<unknown> {
  const found = await findExampleIds(db);
  // 초대 토큰은 id가 아니라 조직 가입 자격이다. 켜지 않으면 자리표를 그대로 둔다.
  const ids = options.includeInviteToken ? found : { ...found, INVITE_TOKEN: null };
  const filled = Object.entries(ids).reduce(
    (json, [key, value]) => (value === null ? json : json.replaceAll(`{{${key}}}`, value)),
    JSON.stringify(baseSpec()),
  );
  return JSON.parse(filled);
}
