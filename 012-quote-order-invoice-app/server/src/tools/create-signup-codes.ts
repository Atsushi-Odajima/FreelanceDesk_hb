// 購入者コード（登録用）を発行します。表示されたコードは再表示できないため控えてください。
// 使い方: npm run codes:create -- 10 "2026年10月販売分"
import crypto from 'node:crypto';
import { createPool } from '../db';
import { migrate } from '../migrate';
import { normalizeCode, sha256 } from '../auth/password';

const count = Math.min(Math.max(Number(process.argv[2] ?? 1), 1), 1000);
const note = process.argv[3] ?? '';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL が必要です');
const pool = createPool(url);
await migrate(pool);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
for (let i = 0; i < count; i++) {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let j = 0; j < 16; j++) raw += alphabet[bytes[j] % alphabet.length];
  const code = `FD-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  await pool.query('INSERT INTO signup_codes (code_hash, note) VALUES ($1,$2)', [sha256(normalizeCode(code)), note]);
  console.log(code);
}
await pool.end();
