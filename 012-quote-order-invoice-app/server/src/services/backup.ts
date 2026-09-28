// 全データのバックアップ（ZIP）と復元。
// 形式: manifest.json / data.json / attachments/<元ID>
// 復元先は「空のアカウント」のみ。全IDを新しいUUIDへ付け替えるため、同じ環境・別環境のどちらにも復元できる。
import crypto from 'node:crypto';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type pg from 'pg';
import { many, one, withTx } from '../db';
import { unprocessable } from './errors';

export const BACKUP_FORMAT_VERSION = 1;

// 依存順（親→子）
export const BACKUP_TABLES = [
  'customers',
  'items',
  'projects',
  'project_status_history',
  'project_events',
  'tasks',
  'quotes',
  'quote_versions',
  'orders',
  'deliveries',
  'invoices',
  'invoice_versions',
  'attachments',
  'bank_imports',
  'payments',
  'payment_allocations',
  'counters',
] as const;

type Row = Record<string, any>;

export interface BackupStats {
  counts: Record<string, number>;
  invoiceIssuedTotal: number;
  paymentTotal: number;
  allocationTotal: number;
  orderTotal: number;
  attachmentBytes: number;
}

export async function computeStats(q: pg.Pool | pg.PoolClient, accountId: string): Promise<BackupStats> {
  const counts: Record<string, number> = {};
  for (const t of BACKUP_TABLES) {
    const r = await one(q, `SELECT count(*)::int AS n FROM ${t} WHERE account_id=$1`, [accountId]);
    counts[t] = r.n;
  }
  const sums = await one(
    q,
    `SELECT
       (SELECT COALESCE(sum(total),0) FROM invoices WHERE account_id=$1 AND status='issued')::bigint AS inv,
       (SELECT COALESCE(sum(amount),0) FROM payments WHERE account_id=$1)::bigint AS pay,
       (SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE account_id=$1)::bigint AS alloc,
       (SELECT COALESCE(sum(amount),0) FROM orders WHERE account_id=$1 AND status='active')::bigint AS ord,
       (SELECT COALESCE(sum(size_bytes),0) FROM attachments WHERE account_id=$1)::bigint AS bytes`,
    [accountId],
  );
  return {
    counts,
    invoiceIssuedTotal: Number(sums.inv),
    paymentTotal: Number(sums.pay),
    allocationTotal: Number(sums.alloc),
    orderTotal: Number(sums.ord),
    attachmentBytes: Number(sums.bytes),
  };
}

function serialize(v: any): any {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return undefined;
  return v;
}

export async function createBackup(pool: pg.Pool, accountId: string, now: Date): Promise<Uint8Array> {
  const data: Record<string, Row[]> = {};
  for (const t of BACKUP_TABLES) {
    const rows = await many(pool, `SELECT * FROM ${t} WHERE account_id=$1`, [accountId]);
    data[t] = rows.map((r) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(r)) if (k !== 'account_id') o[k] = serialize(v);
      return o;
    });
  }
  const bp = await one(pool, 'SELECT * FROM business_profiles WHERE account_id=$1', [accountId]);
  const business: Row = {};
  for (const [k, v] of Object.entries(bp ?? {})) if (k !== 'account_id') business[k] = serialize(v);

  const files: Record<string, Uint8Array> = {};
  const blobs = await many(pool, 'SELECT a.id, b.data FROM attachments a JOIN attachment_blobs b ON b.attachment_id=a.id WHERE a.account_id=$1', [accountId]);
  for (const b of blobs) files[`attachments/${b.id}`] = new Uint8Array(b.data);

  const stats = await computeStats(pool, accountId);
  const manifest = { app: 'freelance-desk', formatVersion: BACKUP_FORMAT_VERSION, exportedAt: now.toISOString(), stats };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['data.json'] = strToU8(JSON.stringify({ business, tables: data }));
  return zipSync(files, { level: 6 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function remapDeep(v: any, map: Map<string, string>): any {
  if (typeof v === 'string') return UUID_RE.test(v) && map.has(v.toLowerCase()) ? map.get(v.toLowerCase()) : v;
  if (Array.isArray(v)) return v.map((x) => remapDeep(x, map));
  if (v && typeof v === 'object') {
    const o: Row = {};
    for (const [k, x] of Object.entries(v)) o[k] = remapDeep(x, map);
    return o;
  }
  return v;
}

async function tableColumns(tx: pg.PoolClient, table: string): Promise<Map<string, string>> {
  const rows = await many(tx, "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table]);
  return new Map(rows.map((r) => [r.column_name as string, r.data_type as string]));
}

export async function isAccountEmpty(q: pg.Pool | pg.PoolClient, accountId: string): Promise<boolean> {
  const r = await one(
    q,
    `SELECT (SELECT count(*) FROM customers WHERE account_id=$1) + (SELECT count(*) FROM items WHERE account_id=$1)
          + (SELECT count(*) FROM projects WHERE account_id=$1) + (SELECT count(*) FROM payments WHERE account_id=$1) AS n`,
    [accountId],
  );
  return Number(r.n) === 0;
}

export async function restoreBackup(pool: pg.Pool, accountId: string, zip: Uint8Array) {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw unprocessable('バックアップファイル（ZIP）を読み込めません');
  }
  if (!entries['manifest.json'] || !entries['data.json']) throw unprocessable('Freelance Desk のバックアップファイルではありません');
  let manifest: any;
  let payload: any;
  try {
    manifest = JSON.parse(strFromU8(entries['manifest.json']));
    payload = JSON.parse(strFromU8(entries['data.json']));
  } catch {
    throw unprocessable('バックアップファイルが壊れています');
  }
  if (manifest.app !== 'freelance-desk' || manifest.formatVersion !== BACKUP_FORMAT_VERSION) throw unprocessable('対応していないバックアップ形式です');
  const tables: Record<string, Row[]> = payload.tables ?? {};
  for (const t of BACKUP_TABLES) if (tables[t] !== undefined && !Array.isArray(tables[t])) throw unprocessable('バックアップファイルが壊れています');

  // 旧ID → 新ID
  const map = new Map<string, string>();
  for (const t of BACKUP_TABLES) {
    for (const r of tables[t] ?? []) {
      if (typeof r.id === 'string' && UUID_RE.test(r.id)) map.set(r.id.toLowerCase(), crypto.randomUUID());
    }
  }

  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`restore:${accountId}`]);
    if (!(await isAccountEmpty(tx, accountId))) throw unprocessable('復元は、データが空のアカウントにのみ行えます（新しいアカウントを作成して復元してください）');
    const deferredInvoiceVersion: Array<[string, string]> = [];
    for (const t of BACKUP_TABLES) {
      const cols = await tableColumns(tx, t);
      for (const raw of tables[t] ?? []) {
        const row = remapDeep(raw, map) as Row;
        row.account_id = accountId;
        if (t === 'invoices' && row.current_version_id) {
          deferredInvoiceVersion.push([row.id, row.current_version_id]);
          row.current_version_id = null;
        }
        const keys = Object.keys(row).filter((k) => cols.has(k));
        const values = keys.map((k) => {
          const v = row[k];
          const type = cols.get(k);
          if (type === 'jsonb' && v !== null && v !== undefined) return JSON.stringify(v);
          return v;
        });
        const sql = `INSERT INTO ${t} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`;
        await tx.query(sql, values);
      }
    }
    for (const [invId, verId] of deferredInvoiceVersion) {
      await tx.query('UPDATE invoices SET current_version_id=$3 WHERE account_id=$1 AND id=$2', [accountId, invId, verId]);
    }
    // 添付の実体
    for (const a of tables.attachments ?? []) {
      const data = entries[`attachments/${a.id}`];
      if (!data) throw unprocessable(`添付ファイルの実体が見つかりません（${a.filename}）`);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      if (hash !== a.sha256) throw unprocessable(`添付ファイルが破損しています（${a.filename}）`);
      await tx.query('INSERT INTO attachment_blobs (attachment_id, data) VALUES ($1,$2)', [map.get(String(a.id).toLowerCase()), Buffer.from(data)]);
    }
    // 事業者情報
    const b = remapDeep(payload.business ?? {}, map) as Row;
    const bcols = await tableColumns(tx, 'business_profiles');
    const bkeys = Object.keys(b).filter((k) => bcols.has(k) && k !== 'account_id' && k !== 'updated_at');
    if (bkeys.length) {
      await tx.query(
        `UPDATE business_profiles SET ${bkeys.map((k, i) => `"${k}"=$${i + 2}`).join(',')}, updated_at=now() WHERE account_id=$1`,
        [accountId, ...bkeys.map((k) => b[k])],
      );
    }
    const after = await computeStats(tx, accountId);
    const expected: BackupStats = manifest.stats;
    const mismatches: string[] = [];
    for (const t of BACKUP_TABLES) if ((expected.counts?.[t] ?? 0) !== after.counts[t]) mismatches.push(`${t}: ${expected.counts?.[t]} → ${after.counts[t]}`);
    for (const k of ['invoiceIssuedTotal', 'paymentTotal', 'allocationTotal', 'orderTotal', 'attachmentBytes'] as const) {
      if (expected[k] !== after[k]) mismatches.push(`${k}: ${expected[k]} → ${after[k]}`);
    }
    if (mismatches.length) throw unprocessable(`復元後の件数・金額がバックアップと一致しません（${mismatches.join(', ')}）`);
    return { ok: true, stats: after };
  });
}
