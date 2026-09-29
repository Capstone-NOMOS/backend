import express from 'express';
import { afterAll, afterEach, expect } from 'vitest';
import { assertInvariants, closeInvariantPool } from './helpers/assert-invariants.js';
import { checkResponse } from './helpers/openapi-contract.js';

// 테스트마다 DB 불변식을 확인한다. afterAll로 몰면 "어느 테스트가 깼는지"를 잃는다 —
// 그걸 잃으면 검사기가 있어도 원인 추적에 드는 시간이 거의 줄지 않는다.
afterEach(async () => {
  await assertInvariants();
});

afterAll(async () => {
  await closeInvariantPool();
});

// 테스트가 HTTP로 받는 모든 /api 응답을 docs/openapi.yaml로 검사한다(tests/helpers/openapi-contract.ts).
// 문서는 손으로 쓰므로, 코드만 고치고 문서를 잊으면 그 응답을 받은 테스트가 여기서 실패한다.
// 응답 경로에서 던지면 서버가 500을 내 원인이 가려지므로, 모아 두었다가 테스트가 끝날 때 확인한다.
const contractViolations: string[] = [];
const originalJson = express.response.json;
express.response.json = function patchedJson(this: express.Response, body: unknown) {
  const req = this.req;
  if (req.baseUrl === '/api') {
    // 라우트에 닿기 전에 끝난 응답(없는 경로의 404 등)은 route가 없다 — 경로 대신 원래 URL로 적는다.
    const routePath = (req.route as { path?: string } | undefined)?.path ?? req.path;
    try {
      // 직렬화된 모양으로 본다 — Date 등은 JSON에서 문자열이 된다.
      const sent: unknown = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
      const violation = checkResponse(req.method, routePath, this.statusCode, sent);
      if (violation) contractViolations.push(violation);
    } catch (err) {
      contractViolations.push(`${req.method} /api${routePath}: 계약 검사 자체가 실패했다 — ${String(err)}`);
    }
  }
  return originalJson.call(this, body);
};

afterEach(() => {
  const found = contractViolations.splice(0);
  expect(found, 'docs/openapi.yaml과 다른 응답').toEqual([]);
});
