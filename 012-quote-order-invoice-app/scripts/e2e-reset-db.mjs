// E2E用DBを作り直す（Playwright の webServer 起動前に実行）
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
const name = url.pathname.slice(1);
if (!/_e2e$/.test(name)) throw new Error('E2E用DB（名前が _e2e で終わる）以外は初期化しません');
url.pathname = '/postgres';
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [name]);
await c.query(`DROP DATABASE IF EXISTS ${name}`);
await c.query(`CREATE DATABASE ${name}`);
await c.end();
