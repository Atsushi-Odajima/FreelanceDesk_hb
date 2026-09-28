import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const exe = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.E2E_PORT ?? 3200);
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/freelance_desk_e2e';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    launchOptions: fs.existsSync(exe) ? { executablePath: exe } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-reset-db.mjs && node dist/server/index.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'production', SECURE_COOKIES: 'false', TRUST_PROXY: 'false', RATE_LIMIT_RELAXED_FOR_TESTS: 'true' },
  },
  projects: [{ name: 'chromium' }],
});
