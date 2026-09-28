import { serve } from '@hono/node-server';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { createPool } from './db';
import { migrate } from './migrate';
import { createApp } from './app';
import { makeServices } from './context';
import { purgeExpiredDemos } from './routes/auth';

async function main() {
  const config = loadConfig();
  if (!config.staticDir) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '../client');
    if (fs.existsSync(path.join(candidate, 'index.html'))) config.staticDir = candidate;
  }
  const pool = createPool(config.databaseUrl);
  await migrate(pool, (m) => console.log(m));
  const app = createApp({ pool, config });
  const s = makeServices({ pool, config });

  // 期限切れセッション・デモアカウントの定期掃除
  const cleanup = async () => {
    try {
      await pool.query('DELETE FROM sessions WHERE expires_at < now()');
      await pool.query('DELETE FROM password_reset_tokens WHERE expires_at < now()');
      await purgeExpiredDemos(s);
    } catch (e) {
      console.error('cleanup failed:', (e as Error).message);
    }
  };
  setInterval(cleanup, 60 * 60 * 1000).unref();
  void cleanup();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`Freelance Desk listening on :${info.port}${config.staticDir ? '' : ' (API only)'}`);
  });
  const shutdown = () => {
    server.close();
    void pool.end().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('起動に失敗しました:', (e as Error).message);
  process.exit(1);
});
