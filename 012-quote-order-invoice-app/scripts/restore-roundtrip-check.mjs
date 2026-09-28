// バックアップ→別環境の空アカウントへ復元→件数・金額の一致を確認する運用チェック
// 使い方: SRC_URL=https://旧環境 SRC_EMAIL=.. SRC_PASSWORD=.. DST_URL=https://新環境 DST_EMAIL=.. DST_PASSWORD=.. node scripts/restore-roundtrip-check.mjs
// （SRC_EMAIL を省略すると元環境でデモアカウントを作成して検証します）
const H = { 'x-requested-with': 'FreelanceDesk', 'content-type': 'application/json' };
const env = process.env;
async function session(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${base}${path}: ${r.status} ${await r.text()}`);
  return r.headers.get('set-cookie').split(';')[0];
}
const A = env.SRC_URL ?? 'http://localhost:3301';
const B = env.DST_URL ?? 'http://localhost:3302';
const ca = env.SRC_EMAIL ? await session(A, '/api/auth/login', { email: env.SRC_EMAIL, password: env.SRC_PASSWORD }) : await session(A, '/api/auth/demo', {});
const zip = new Uint8Array(await (await fetch(A + '/api/data/backup.zip', { headers: { cookie: ca } })).arrayBuffer());
const cb = env.DST_EMAIL
  ? await session(B, '/api/auth/login', { email: env.DST_EMAIL, password: env.DST_PASSWORD })
  : await session(B, '/api/auth/signup', { email: `restore-${Date.now()}@example.com`, password: 'password-1234' });
const fd = new FormData();
fd.append('file', new File([zip], 'backup.zip'));
const res = await fetch(B + '/api/data/restore', { method: 'POST', headers: { cookie: cb, 'x-requested-with': 'FreelanceDesk' }, body: fd });
const r = await res.json();
if (!res.ok) throw new Error(`restore failed: ${JSON.stringify(r)}`);
const snapshot = async (base, c) => {
  const d = await (await fetch(base + '/api/dashboard?from=2000-01-01&to=2100-12-31', { headers: { cookie: c } })).json();
  const inv = await (await fetch(base + '/api/invoices?state=all', { headers: { cookie: c } })).json();
  return {
    amounts: Object.fromEntries(Object.entries(d.amounts).map(([k, v]) => [k, v.amount])),
    invoices: inv.invoices.map((i) => [i.number, i.total, i.allocated, i.paymentState]).sort(),
  };
};
const [sa, sb] = [await snapshot(A, ca), await snapshot(B, cb)];
console.log('backup bytes:', zip.length);
console.log('restored counts:', JSON.stringify(r.stats.counts));
console.log('source :', JSON.stringify(sa));
console.log('restore:', JSON.stringify(sb));
const ok = JSON.stringify(sa) === JSON.stringify(sb);
console.log(ok ? 'OK: 件数・金額が一致しました' : 'NG: 不一致があります');
process.exit(ok ? 0 : 1);
