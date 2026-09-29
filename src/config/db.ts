import { Pool, type PoolClient } from 'pg';
import { env } from './env.js';

// 애플리케이션 전역에서 공유하는 커넥션 풀.
export const pool = new Pool({ connectionString: env.DATABASE_URL });

// repository 함수가 트랜잭션(PoolClient) 밖에서도(단순 조회) 재사용될 수 있도록
// 둘 다 지원하는 공통 타입.
export type Queryable = Pool | PoolClient;

// BEGIN/COMMIT/ROLLBACK을 관리하는 헬퍼. 도메인 서비스는 반드시 이 함수를 통해서만
// 쓰기 트랜잭션을 수행해야 한다 (상태 변경 + appendEvent가 항상 같은 트랜잭션에 묶이도록).
export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
