import pg from 'pg';
import { migrate } from '../server/src/migrate';

// テスト用DBを空にしてからマイグレーションを適用
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/freelance_desk_test';
  const pool = new pg.Pool({ connectionString: url });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await pool.end();
}
