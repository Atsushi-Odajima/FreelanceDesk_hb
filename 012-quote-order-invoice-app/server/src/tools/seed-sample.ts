// 開発・デモ用：架空データ入りの「デモアカウント」を作成します（本番アカウントには投入しません）。
// 使い方: npm run seed:sample -- demo@example.com password1234
import { createPool, withTx } from '../db';
import { migrate } from '../migrate';
import { loadConfig } from '../config';
import { makeServices } from '../context';
import { hashPassword } from '../auth/password';
import { seedSampleData } from '../services/sample';

const [email, password] = process.argv.slice(2);
if (!email || !password) throw new Error('メールアドレスとパスワードを指定してください');
const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
const s = makeServices({ pool, config });
await withTx(pool, async (tx) => {
  const a = await tx.query("INSERT INTO accounts (email, password_hash, is_demo, demo_expires_at) VALUES ($1,$2,true, now() + interval '3650 days') RETURNING id", [
    email,
    await hashPassword(password),
  ]);
  await tx.query('INSERT INTO business_profiles (account_id) VALUES ($1)', [a.rows[0].id]);
  await seedSampleData(tx, s, a.rows[0].id);
});
console.log(`サンプルデータ入りのデモアカウントを作成しました: ${email}`);
await pool.end();
