// 復旧コードを紛失した利用者のため、運営者が本人確認後にパスワード再設定リンクを発行します（有効期限24時間・1回限り）。
// 使い方: npm run account:reset-link -- user@example.com
import { createPool } from '../db';
import { randomToken, sha256 } from '../auth/password';

const email = process.argv[2];
const url = process.env.DATABASE_URL;
const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
if (!url || !email) throw new Error('DATABASE_URL とメールアドレスを指定してください');
const pool = createPool(url);
const a = (await pool.query('SELECT id FROM accounts WHERE lower(email)=lower($1) AND NOT is_demo', [email])).rows[0];
if (!a) {
  console.error('該当するアカウントがありません');
  process.exitCode = 1;
} else {
  const token = randomToken(32);
  await pool.query("INSERT INTO password_reset_tokens (token_hash, account_id, expires_at) VALUES ($1,$2, now() + interval '24 hours')", [sha256(token), a.id]);
  // 画面にのみ表示（ログファイルに残さないため、出力先をファイルへリダイレクトしないでください）
  console.log(`${origin}/reset#token=${token}`);
}
await pool.end();
