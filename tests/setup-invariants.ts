import { afterAll, afterEach } from 'vitest';
import { assertInvariants, closeInvariantPool } from './helpers/assert-invariants.js';

// 테스트마다 DB 불변식을 확인한다. afterAll로 몰면 "어느 테스트가 깼는지"를 잃는다 —
// 그걸 잃으면 검사기가 있어도 원인 추적에 드는 시간이 거의 줄지 않는다.
afterEach(async () => {
  await assertInvariants();
});

afterAll(async () => {
  await closeInvariantPool();
});
