import pg from 'pg';

// bigint(int8) を number へ（金額は安全整数範囲に制限しているため）
pg.types.setTypeParser(20, (v) => Number(v));
// date はタイムゾーン変換せず 'YYYY-MM-DD' 文字列のまま扱う
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): pg.Pool {
  const needsSsl = /sslmode=require/.test(databaseUrl);
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}

/** トランザクション内で fn を実行。例外時はロールバック */
export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(sql, params as any[]);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params as any[]);
  return r.rows as T[];
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && (!constraint || err.constraint === constraint);
}

/** 同一 requestId の同時実行を直列化する（二重クリック・通信再送対策。トランザクション終了で解放） */
export async function lockRequest(tx: pg.PoolClient, accountId: string, requestId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${accountId}:${requestId}`]);
}
