import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AppEnv, type Services } from '../context';
import { many, one, withTx } from '../db';
import { toCsv, parseCsv } from '../../../shared/csv';
import { PROJECT_STATUS_LABELS, PAYMENT_METHOD_LABELS, type ProjectStatus, type PaymentMethod } from '../../../shared/status';
import { PAYMENT_STATE_LABELS } from '../../../shared/calc';
import { listInvoices, listPayments } from '../services/queries';
import { createBackup, restoreBackup } from '../services/backup';
import { HttpError } from '../services/errors';
import { contentDisposition } from '../services/upload';
import { customerSchema, itemSchema } from '../schemas';

const csvResponse = (c: any, name: string, csv: string) =>
  c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': contentDisposition('attachment', name), 'Cache-Control': 'private, no-store' });

export const CUSTOMER_CSV_HEADER = ['顧客コード', '会社名・屋号', '担当者', '敬称', '郵便番号', '住所', '電話', 'メール', '支払条件', '振込名義', '内部メモ'];
export const ITEM_CSV_HEADER = ['品目コード', '品名', '説明', '標準単価', '単位', '税率'];

export function dataRoutes(s: Services) {
  const r = new Hono<AppEnv>();
  const stamp = () => s.today().replace(/-/g, '');

  // ---------- CSV出力（UTF-8 BOM・全項目引用・数式インジェクション対策） ----------
  r.get('/export/customers.csv', async (c) => {
    const rows = await many(s.pool, 'SELECT * FROM customers WHERE account_id=$1 ORDER BY code, name', [c.get('accountId')]);
    const csv = toCsv(
      [...CUSTOMER_CSV_HEADER, 'アーカイブ'],
      rows.map((x) => [x.code, x.name, x.contact_name, x.honorific, x.postal_code, x.address, x.phone, x.email, x.payment_terms, x.payer_name, x.internal_memo, x.archived_at ? 'はい' : '']),
    );
    return csvResponse(c, `顧客_${stamp()}.csv`, csv);
  });

  r.get('/export/items.csv', async (c) => {
    const rows = await many(s.pool, 'SELECT * FROM items WHERE account_id=$1 ORDER BY code, name', [c.get('accountId')]);
    const csv = toCsv(
      [...ITEM_CSV_HEADER, 'アーカイブ'],
      rows.map((x) => [x.code, x.name, x.description, Number(x.unit_price), x.unit, x.tax_rate, x.archived_at ? 'はい' : '']),
    );
    return csvResponse(c, `品目_${stamp()}.csv`, csv);
  });

  r.get('/export/projects.csv', async (c) => {
    const rows = await many(
      s.pool,
      `SELECT p.*, cu.name AS customer_name, cu.code AS customer_code,
         (SELECT o.amount FROM orders o WHERE o.project_id=p.id AND o.status='active') AS order_amount,
         (SELECT o.order_date FROM orders o WHERE o.project_id=p.id AND o.status='active') AS order_date
       FROM projects p JOIN customers cu ON cu.id=p.customer_id WHERE p.account_id=$1 ORDER BY p.number`,
      [c.get('accountId')],
    );
    const csv = toCsv(
      ['案件番号', '案件名', '顧客コード', '顧客名', '状態', '問い合わせ日', '予定開始', '予定納期', '受注日', '受注金額'],
      rows.map((x) => [
        x.number,
        x.title,
        x.customer_code,
        x.customer_name,
        PROJECT_STATUS_LABELS[x.status as ProjectStatus],
        x.inquiry_date,
        x.planned_start,
        x.planned_due,
        x.order_date,
        x.order_amount === null ? null : Number(x.order_amount),
      ]),
    );
    return csvResponse(c, `案件_${stamp()}.csv`, csv);
  });

  r.get('/export/invoices.csv', async (c) => {
    const rows = (await listInvoices(s.pool, c.get('accountId'), s.today())).filter((i) => i.status !== 'draft');
    const csv = toCsv(
      ['請求番号', '状態', '請求日', '支払期限', '顧客名', '案件番号', '案件名', '請求額', '入金割当額', '残額', '入金状態', '期限超過', '訂正版'],
      rows.map((i) => [
        i.number,
        i.status === 'cancelled' ? '取消' : '発行済み',
        i.issueDate,
        i.dueDate,
        i.customerName,
        i.projectNumber,
        i.projectTitle,
        i.total,
        i.allocated,
        i.status === 'cancelled' ? null : i.remaining,
        i.paymentState ? PAYMENT_STATE_LABELS[i.paymentState] : '',
        i.overdue ? 'はい' : '',
        i.currentRevision && i.currentRevision > 1 ? `第${i.currentRevision}版` : '',
      ]),
    );
    return csvResponse(c, `請求_${stamp()}.csv`, csv);
  });

  r.get('/export/payments.csv', async (c) => {
    const rows = await listPayments(s.pool, c.get('accountId'));
    const csv = toCsv(
      ['入金日', '金額', '方法', '名義', 'メモ', '取込元', '割当額', '未割当額', '割当先請求番号'],
      rows.map((p) => [
        p.receivedOn,
        p.amount,
        PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
        p.payerName,
        p.memo,
        p.source === 'bank_csv' ? '銀行CSV' : '手入力',
        p.allocated,
        p.unallocated,
        (p.allocations as any[]).map((a) => a.invoiceNumber).join(' / '),
      ]),
    );
    return csvResponse(c, `入金_${stamp()}.csv`, csv);
  });

  r.get('/templates/:name', async (c) => {
    const name = c.req.param('name');
    if (name === 'customers.csv') return csvResponse(c, '顧客テンプレート.csv', toCsv(CUSTOMER_CSV_HEADER, [['C001', 'Sample Design株式会社', '山田 花子', '御中', '100-0001', '東京都千代田区サンプル1-2-3', '03-0000-0000', 'info@example.com', '月末締め翌月末払い', 'サンプルデザイン(カ', '']]));
    if (name === 'items.csv') return csvResponse(c, '品目テンプレート.csv', toCsv(ITEM_CSV_HEADER, [['I001', 'LPデザイン', 'PC/スマホ対応', 50000, '式', '10']]));
    throw new HttpError(404, 'テンプレートが見つかりません');
  });

  // ---------- CSV取込（顧客・品目）。preview=1 で検証のみ ----------
  r.post('/import/:kind', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: () => { throw new HttpError(413, 'CSVファイルが大きすぎます（上限5MB）'); } }), async (c) => {
    const kind = c.req.param('kind');
    if (kind !== 'customers' && kind !== 'items') throw new HttpError(404, '取込種別が正しくありません');
    const form = (await c.req.parseBody()) as Record<string, string | File>;
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, 'CSVファイルを選択してください');
    const encoding = form.encoding === 'shift_jis' ? 'shift_jis' : 'utf-8';
    const preview = form.preview === '1';
    let text: string;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new HttpError(400, `文字コード（${encoding === 'utf-8' ? 'UTF-8' : 'Shift_JIS'}）として読み込めません。文字コードの選択を確認してください`);
    }
    const parsed = parseCsv(text);
    if (parsed.errors.length) throw new HttpError(400, `CSVの形式に誤りがあります：${parsed.errors[0]}`);
    const [header, ...rows] = parsed.rows;
    const expected = kind === 'customers' ? CUSTOMER_CSV_HEADER : ITEM_CSV_HEADER;
    if (!header || expected.some((h, i) => (header[i] ?? '').trim() !== h)) {
      throw new HttpError(400, `見出し行がテンプレートと一致しません。1行目は「${expected.join(',')}」にしてください`);
    }
    const acc = c.get('accountId');
    const results: Array<{ line: number; status: 'ok' | 'error' | 'duplicate'; message?: string; name?: string }> = [];
    const valid: any[] = [];
    const seenCodes = new Set<string>();
    const table = kind === 'customers' ? 'customers' : 'items';
    const existingCodes = new Set((await many(s.pool, `SELECT code FROM ${table} WHERE account_id=$1 AND code <> ''`, [acc])).map((x) => x.code as string));
    rows.forEach((cells, idx) => {
      const line = idx + 2;
      const v = (i: number) => (cells[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
      let parsedRow;
      if (kind === 'customers') {
        const honor = v(3);
        parsedRow = customerSchema.safeParse({
          code: v(0),
          name: v(1),
          contactName: v(2),
          honorific: ['御中', '様', '殿', ''].includes(honor) ? honor : '御中',
          postalCode: v(4),
          address: v(5),
          phone: v(6),
          email: v(7),
          paymentTerms: v(8),
          payerName: v(9),
          internalMemo: v(10),
        });
      } else {
        const price = Number(v(3).replace(/[,¥￥円]/g, ''));
        parsedRow = itemSchema.safeParse({ code: v(0), name: v(1), description: v(2), unitPrice: price, unit: v(4), taxRate: v(5) || '10' });
      }
      if (!parsedRow.success) {
        results.push({ line, status: 'error', message: parsedRow.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ') });
        return;
      }
      const code = parsedRow.data.code;
      if (code && (existingCodes.has(code) || seenCodes.has(code))) {
        results.push({ line, status: 'duplicate', message: `コード「${code}」は登録済みのためスキップ`, name: parsedRow.data.name });
        return;
      }
      if (code) seenCodes.add(code);
      valid.push(parsedRow.data);
      results.push({ line, status: 'ok', name: parsedRow.data.name });
    });
    if (preview) return c.json({ preview: true, results, validCount: valid.length });
    await withTx(s.pool, async (tx) => {
      for (const d of valid) {
        if (kind === 'customers') {
          await tx.query(
            `INSERT INTO customers (account_id, code, name, contact_name, honorific, postal_code, address, phone, email, payment_terms, payer_name, internal_memo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [acc, d.code, d.name, d.contactName, d.honorific, d.postalCode, d.address, d.phone, d.email, d.paymentTerms, d.payerName, d.internalMemo],
          );
        } else {
          await tx.query('INSERT INTO items (account_id, code, name, description, unit_price, unit, tax_rate) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
            acc,
            d.code,
            d.name,
            d.description,
            d.unitPrice,
            d.unit,
            d.taxRate,
          ]);
        }
      }
    });
    return c.json({ preview: false, results, imported: valid.length });
  });

  // ---------- 全データバックアップ／復元 ----------
  r.get('/backup.zip', async (c) => {
    const zip = await createBackup(s.pool, c.get('accountId'), s.now());
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', `FreelanceDesk_バックアップ_${stamp()}.zip`),
      'Cache-Control': 'private, no-store',
    });
  });

  const restoreMax = Number(process.env.RESTORE_MAX_BYTES ?? 300 * 1024 * 1024);
  r.post(
    '/restore',
    bodyLimit({ maxSize: restoreMax, onError: () => { throw new HttpError(413, 'バックアップファイルが大きすぎます'); } }),
    async (c) => {
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      const file = form.file;
      if (!(file instanceof File)) throw new HttpError(400, 'バックアップファイルを選択してください');
      const res = await restoreBackup(s.pool, c.get('accountId'), new Uint8Array(await file.arrayBuffer()));
      return c.json(res);
    },
  );

  r.get('/stats', async (c) => {
    const x = await one(
      s.pool,
      `SELECT (SELECT count(*) FROM customers WHERE account_id=$1)::int AS customers, (SELECT count(*) FROM projects WHERE account_id=$1)::int AS projects,
              (SELECT COALESCE(sum(size_bytes),0) FROM attachments WHERE account_id=$1)::bigint AS storage`,
      [c.get('accountId')],
    );
    return c.json({ ...x, storage: Number(x.storage), storageQuota: s.config.accountStorageQuotaBytes, uploadMax: s.config.uploadMaxBytes });
  });

  return r;
}
