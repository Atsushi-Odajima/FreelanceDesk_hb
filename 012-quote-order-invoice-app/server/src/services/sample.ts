// 架空のサンプルデータ（デモアカウント専用。本番アカウントには投入しない）
import crypto from 'node:crypto';
import type { Tx } from '../db';
import type { Services } from '../context';
import { addDays } from '../../../shared/dates';
import type { Line } from '../../../shared/calc';
import { createProject } from './projects';
import { createNextVersion, createQuote, declineQuote, submitQuoteVersion, updateQuoteDraft, type QuoteDraftInput } from './quotes';
import { createDelivery, createOrder } from './orders';
import { createInvoiceFromOrder, finalizeInvoiceVersion, updateInvoiceDraft } from './invoices';
import { recordInvoicePayment } from './payments';
import { setProjectStatus } from './events';

const rid = () => `sample-${crypto.randomUUID()}`;
const line = (name: string, unitPrice: number, quantity = '1', unit = '式', description = '', taxRate = '10'): Line => ({
  id: crypto.randomUUID(),
  itemId: null,
  name,
  description,
  quantity,
  unit,
  unitPrice,
  taxRate,
});

export async function seedSampleData(tx: Tx, s: Services, accountId: string) {
  const today = s.today();
  await tx.query(
    `UPDATE business_profiles SET name=$2, contact_name=$3, postal_code=$4, address=$5, phone=$6, email=$7, bank_info=$8, registration_no=$9,
       default_payment_terms=$10, default_notes=$11 WHERE account_id=$1`,
    [
      accountId,
      'サンプル制作室（架空）',
      '見本 太郎',
      '000-0000',
      '東京都架空区サンプル町1-2-3 サンプルビル4F',
      '000-0000-0000',
      'sample@example.com',
      'サンプル銀行 架空支店 普通 0000000 サンプルセイサクシツ',
      'T0000000000000（架空）',
      '請求書発行月の翌月末までにお振込みください',
      'これはデモ用の架空データです。',
    ],
  );

  const cust = async (code: string, name: string, contact: string, payer: string) =>
    (
      await tx.query(
        `INSERT INTO customers (account_id, code, name, contact_name, honorific, postal_code, address, phone, email, payment_terms, payer_name, internal_memo)
         VALUES ($1,$2,$3,$4,'御中','000-0000','東京都架空区見本1-1-1','000-0000-0000','info@example.com','月末締め翌月末払い',$5,'デモ用の架空顧客') RETURNING id`,
        [accountId, code, name, contact, payer],
      )
    ).rows[0].id as string;
  const c1 = await cust('C001', 'Sample Design株式会社', '山田 花子', 'サンプルデザイン(カ');
  const c2 = await cust('C002', '架空商店', '鈴木 一郎', 'カクウシヨウテン');
  const c3 = await cust('C003', 'デモ企画合同会社', '佐藤 次郎', 'デモキカク(ド');

  const items: Array<[string, string, number, string]> = [
    ['I001', 'LPデザイン', 60000, '式'],
    ['I002', 'コーディング', 40000, '式'],
    ['I003', 'ロゴ制作', 50000, '式'],
    ['I004', 'SNS運用代行（月額）', 80000, '月'],
    ['I005', '修正対応（時間）', 5000, '時間'],
  ];
  for (const [code, name, price, unit] of items) {
    await tx.query('INSERT INTO items (account_id, code, name, unit_price, unit, tax_rate) VALUES ($1,$2,$3,$4,$5,$6)', [accountId, code, name, price, unit, '10']);
  }

  const draft = (lines: Line[], extra: Partial<QuoteDraftInput> = {}): QuoteDraftInput => ({
    issueDate: addDays(today, -40),
    validUntil: addDays(today, -10),
    subject: '',
    deliveryNote: '受注後3週間',
    paymentTerms: '月末締め翌月末払い',
    notes: '',
    taxMode: 'inclusive',
    lineRounding: 'round',
    taxRounding: 'floor',
    lines,
    adjustments: [],
    changeMemo: '',
    ...extra,
  });

  // --- 1. 秋キャンペーンLP制作：v1 120,000 → v2 100,000 → 受注 → タスク → 納品 → 請求 → 30,000 + 70,000 入金 → 完了
  const p1 = (await createProject(tx, s, accountId, { customerId: c1, title: '秋キャンペーンLP制作', inquiryDate: addDays(today, -45), plannedStart: addDays(today, -35), plannedDue: addDays(today, -12), internalMemo: '先方担当は山田様。修正2回まで。' })).id;
  const q1 = await createQuote(tx, s, accountId, p1, rid());
  await updateQuoteDraft(
    tx,
    accountId,
    q1.versionId,
    draft([line('LPデザイン', 60000, '1', '式', 'PC/スマホ対応 1ページ'), line('コーディング', 40000), line('撮影素材手配', 20000)], { subject: '秋キャンペーンLP制作', changeMemo: '初回見積' }),
  );
  await submitQuoteVersion(tx, s, accountId, q1.versionId, addDays(today, -40));
  const q1v2 = await createNextVersion(tx, accountId, q1.versionId, rid());
  await updateQuoteDraft(
    tx,
    accountId,
    q1v2.versionId,
    draft([line('LPデザイン', 60000, '1', '式', 'PC/スマホ対応 1ページ'), line('コーディング', 40000)], {
      subject: '秋キャンペーンLP制作',
      issueDate: addDays(today, -38),
      changeMemo: '素材は先方支給に変更し、撮影素材手配を削除',
    }),
  );
  await submitQuoteVersion(tx, s, accountId, q1v2.versionId, addDays(today, -38));
  const o1 = await createOrder(tx, s, accountId, p1, { quoteVersionId: q1v2.versionId, orderDate: addDays(today, -36), dueDate: addDays(today, -12), memo: '' });
  let order = 10;
  for (const t of ['素材受領', '初稿', '確認', '修正', '納品']) {
    await tx.query('INSERT INTO tasks (account_id, project_id, title, due_date, done, done_at, sort_order) VALUES ($1,$2,$3,$4,true,now(),$5)', [
      accountId,
      p1,
      t,
      addDays(today, -34 + order / 2),
      order,
    ]);
    order += 10;
  }
  await createDelivery(tx, s, accountId, p1, { requestId: rid(), deliveredOn: addDays(today, -13), content: 'LP一式（HTML/CSS/画像）', customerComment: 'ご確認をお願いいたします。', internalMemo: '', includeLines: true });
  const i1 = await createInvoiceFromOrder(tx, s, accountId, p1, rid(), o1.order.id);
  await setIssueDates(tx, accountId, i1.versionId, addDays(today, -12), addDays(today, 18));
  await finalizeInvoiceVersion(tx, s, accountId, i1.versionId);
  await recordInvoicePayment(tx, s, accountId, i1.invoiceId, { requestId: rid(), receivedOn: addDays(today, -5), amount: 30000, method: 'bank_transfer', payerName: 'サンプルデザイン(カ', memo: '一部入金' });
  await recordInvoicePayment(tx, s, accountId, i1.invoiceId, { requestId: rid(), receivedOn: addDays(today, -2), amount: 70000, method: 'bank_transfer', payerName: 'サンプルデザイン(カ', memo: '残額入金' });
  await setProjectStatus(tx, accountId, p1, 'completed', '入金確認済み');

  // --- 2. 期限超過：ロゴ制作（請求済み・未入金・期限超過）
  const p2 = (await createProject(tx, s, accountId, { customerId: c2, title: 'ロゴ制作', inquiryDate: addDays(today, -70), plannedStart: null, plannedDue: addDays(today, -45), internalMemo: '' })).id;
  const q2 = await createQuote(tx, s, accountId, p2, rid());
  await updateQuoteDraft(tx, accountId, q2.versionId, draft([line('ロゴ制作', 50000, '1', '式', 'ラフ3案・修正2回')], { subject: 'ロゴ制作', taxMode: 'exclusive', issueDate: addDays(today, -68), validUntil: addDays(today, -38) }));
  await submitQuoteVersion(tx, s, accountId, q2.versionId, addDays(today, -68));
  const o2 = await createOrder(tx, s, accountId, p2, { quoteVersionId: q2.versionId, orderDate: addDays(today, -65), dueDate: addDays(today, -45), memo: '' });
  await createDelivery(tx, s, accountId, p2, { requestId: rid(), deliveredOn: addDays(today, -46), content: 'ロゴデータ（AI/PNG/SVG）', customerComment: '', internalMemo: '', includeLines: true });
  const i2 = await createInvoiceFromOrder(tx, s, accountId, p2, rid(), o2.order.id);
  await setIssueDates(tx, accountId, i2.versionId, addDays(today, -45), addDays(today, -15));
  await finalizeInvoiceVersion(tx, s, accountId, i2.versionId);

  // --- 3. 未請求：SNS運用代行（受注・納品済み、請求書なし）
  const p3 = (await createProject(tx, s, accountId, { customerId: c3, title: 'SNS運用代行（月次）', inquiryDate: addDays(today, -30), plannedStart: addDays(today, -28), plannedDue: addDays(today, -1), internalMemo: '' })).id;
  const q3 = await createQuote(tx, s, accountId, p3, rid());
  await updateQuoteDraft(
    tx,
    accountId,
    q3.versionId,
    draft([line('SNS運用代行（月額）', 80000, '1', '月'), line('修正対応（時間）', 5000, '2.5', '時間', '追加修正')], {
      subject: 'SNS運用代行',
      taxMode: 'exclusive',
      issueDate: addDays(today, -29),
      validUntil: addDays(today, 1),
      adjustments: [{ id: crypto.randomUUID(), kind: 'discount', label: '初月割引', amount: 5000, taxRate: '10' }],
    }),
  );
  await submitQuoteVersion(tx, s, accountId, q3.versionId, addDays(today, -29));
  await createOrder(tx, s, accountId, p3, { quoteVersionId: q3.versionId, orderDate: addDays(today, -27), dueDate: addDays(today, -1), memo: '' });
  await createDelivery(tx, s, accountId, p3, { requestId: rid(), deliveredOn: addDays(today, -1), content: '投稿20本・月次レポート', customerComment: '', internalMemo: '', includeLines: true });

  // --- 4. 失注：会社案内パンフレット
  const p4 = (await createProject(tx, s, accountId, { customerId: c2, title: '会社案内パンフレット', inquiryDate: addDays(today, -20), plannedStart: null, plannedDue: null, internalMemo: '' })).id;
  const q4 = await createQuote(tx, s, accountId, p4, rid());
  await updateQuoteDraft(tx, accountId, q4.versionId, draft([line('パンフレットデザイン（8P）', 25000, '8', 'P')], { subject: '会社案内パンフレット', taxMode: 'exclusive', issueDate: addDays(today, -18), validUntil: addDays(today, 12) }));
  await submitQuoteVersion(tx, s, accountId, q4.versionId, addDays(today, -18));
  await declineQuote(tx, s, accountId, q4.versionId, '予算の都合で見送り（デモ）');

  // --- 5. 作業中：動画編集（今週納期）
  const p5 = (await createProject(tx, s, accountId, { customerId: c1, title: '商品紹介動画の編集', inquiryDate: addDays(today, -10), plannedStart: addDays(today, -5), plannedDue: addDays(today, 3), internalMemo: '' })).id;
  const q5 = await createQuote(tx, s, accountId, p5, rid());
  await updateQuoteDraft(tx, accountId, q5.versionId, draft([line('動画編集（60秒）', 45000), line('テロップ作成', 10000)], { subject: '商品紹介動画の編集', taxMode: 'exclusive', issueDate: addDays(today, -9), validUntil: addDays(today, 21) }));
  await submitQuoteVersion(tx, s, accountId, q5.versionId, addDays(today, -9));
  await createOrder(tx, s, accountId, p5, { quoteVersionId: q5.versionId, orderDate: addDays(today, -7), dueDate: addDays(today, 3), memo: '' });
  await setProjectStatus(tx, accountId, p5, 'in_progress', '');
  const tasks: Array<[string, boolean]> = [['素材受領', true], ['初稿', true], ['顧客確認', false], ['修正', false], ['最終確認', false]];
  let n = 10;
  for (const [t, done] of tasks) {
    await tx.query('INSERT INTO tasks (account_id, project_id, title, due_date, done, done_at, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      accountId,
      p5,
      t,
      addDays(today, -4 + n / 10),
      done,
      done ? new Date() : null,
      n,
    ]);
    n += 10;
  }

  // --- 6. 見積回答待ち
  const p6 = (await createProject(tx, s, accountId, { customerId: c3, title: 'Webサイト保守（年間）', inquiryDate: addDays(today, -6), plannedStart: null, plannedDue: addDays(today, 30), internalMemo: '' })).id;
  const q6 = await createQuote(tx, s, accountId, p6, rid());
  await updateQuoteDraft(tx, accountId, q6.versionId, draft([line('Webサイト保守', 15000, '12', '月')], { subject: 'Webサイト保守（年間）', taxMode: 'exclusive', issueDate: addDays(today, -5), validUntil: addDays(today, 25) }));
  await submitQuoteVersion(tx, s, accountId, q6.versionId, addDays(today, -5));
}

async function setIssueDates(tx: Tx, accountId: string, versionId: string, issueDate: string, dueDate: string) {
  const v = (await tx.query('SELECT * FROM invoice_versions WHERE account_id=$1 AND id=$2', [accountId, versionId])).rows[0];
  await updateInvoiceDraft(tx, accountId, versionId, {
    issueDate,
    dueDate,
    subject: v.subject,
    paymentTerms: v.payment_terms,
    notes: v.notes,
    bankInfo: v.bank_info,
    taxMode: v.tax_mode,
    lineRounding: v.line_rounding,
    taxRounding: v.tax_rounding,
    lines: v.lines,
    adjustments: v.adjustments,
  });
}
