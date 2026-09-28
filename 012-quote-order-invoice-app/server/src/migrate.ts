import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(here, '../migrations'), path.join(here, '../../server/src/migrations'), path.resolve('server/src/migrations')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('migrations ディレクトリが見つかりません');
}

/** 未適用のSQLマイグレーションを順に適用（アドバイザリロックで多重実行を防止） */
export async function migrate(pool: pg.Pool, log: (m: string) => void = () => undefined): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(912012)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const dir = migrationsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migration applied: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(912012)').catch(() => undefined);
    client.release();
  }
}
