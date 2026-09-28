// PDF・CSV入出力・バックアップ/復元・デモ
import { describe, expect, it } from 'vitest';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Client, customerInput, line, quoteDraft, rid, setupInvoice, setupProject, signup, pool } from '../helpers';
import { parseCsv } from '../../shared/csv';
import { embeddedGlyphStats } from '../pdf-glyph-check';

async function expectGlyphsIntact(bytes: Uint8Array) {
  const stats = await embeddedGlyphStats(bytes);
  expect(stats.length).toBeGreaterThan(0);
  for (const st of stats) expect(st.empty / st.glyphs, `埋め込みフォントのグリフ欠落 ${JSON.stringify(st)}`).toBeLessThan(0.05);
}

async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string; producer: string }> {
  const doc = await getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it: any) => it.str).join('') + '\n';
  }
  const meta = await doc.getMetadata();
  return { pages: doc.numPages, text, producer: String((meta.info as any)?.Producer ?? '') };
}

async function getBytes(c: Client, path: string) {
  const res = await c.req('GET', path);
  expect(res.status, path).toBe(200);
  return { bytes: new Uint8Array(await res.arrayBuffer()), res };
}

describe('PDF', () => {
  it('見積PDF：日本語・長い住所/品目・複数ページ・内部メモ非混入', async () => {
    const { client: c } = await signup();
    const longAddr = '東京都千代田区丸の内一丁目二番三号 サンプルタワー二十三階 架空株式会社気付 長い住所の折り返し確認用テキスト';
    const cu = await c.post('/api/customers', customerInput({ address: longAddr, internalMemo: '【顧客の内部メモ】秘密' }), 201);
    const p = await c.post('/api/projects', { requestId: rid(), customerId: cu.customer.id, title: 'PDF確認', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '【案件の内部メモ】秘密' }, 201);
    const q = await c.post(`/api/projects/${p.id}/quotes`, { requestId: rid() }, 201);
    const lines = Array.from({ length: 45 }, (_, i) =>
      line(`品目${i + 1} とても長い品目名の折り返し確認 デザイン・コーディング・撮影・編集・ディレクション一式`, 1000 + i, '1.5', i % 2 ? '8' : '10', {
        description: `説明文 ${i + 1}：改行を含む\n2行目の説明`,
      }),
    );
    await c.put(`/api/quote-versions/${q.versionId}`, quoteDraft(lines, { notes: '備考欄のテキストです。', changeMemo: '【変更メモ（社内）】' }));
    // 下書きPDFには「下書き」表示
    const draft = await pdfText((await getBytes(c, `/api/pdf/quote-versions/${q.versionId}`)).bytes);
    expect(draft.text).toContain('下書き');
    await c.post(`/api/quote-versions/${q.versionId}/finalize`, {}, 200);
    const { bytes, res } = await getBytes(c, `/api/pdf/quote-versions/${q.versionId}?download=1`);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;.*filename\*=UTF-8''/);
    const pdf = await pdfText(bytes);
    await expectGlyphsIntact(bytes);
    expect(pdf.pages).toBeGreaterThanOrEqual(2);
    expect(pdf.text).toContain('御見積書');
    expect(pdf.text).toContain('Sample Design株式会社');
    expect(pdf.text).toContain('品目45');
    expect(pdf.text).toContain('丸の内');
    expect(pdf.text).toContain('備考欄のテキストです');
    expect(pdf.text).toContain(`1 / ${pdf.pages}`);
    expect(pdf.text).not.toContain('下書き');
    for (const secret of ['内部メモ', '秘密', '変更メモ', p.id, q.versionId, cu.customer.id]) expect(pdf.text).not.toContain(secret);
    expect(pdf.producer).toBe('Freelance Desk');
  });

  it('請求書PDF・納品書PDF：振込先・訂正版表示、内部メモ非混入', async () => {
    const { client: c } = await signup();
    const a = await setupInvoice(c, 100000);
    const invBytes = (await getBytes(c, `/api/pdf/invoice-versions/${a.invoiceVersionId}`)).bytes;
    await expectGlyphsIntact(invBytes);
    const inv = await pdfText(invBytes);
    expect(inv.text).toContain('請求書');
    expect(inv.text).toContain('テスト銀行');
    expect(inv.text).toContain('お支払期限');
    expect(inv.text).not.toContain('社外秘');
    const d = await c.post(`/api/projects/${a.projectId}/deliveries`, { requestId: rid(), deliveredOn: '2026-10-01', content: '納品物一式', customerComment: 'ご確認ください', internalMemo: '【納品の内部メモ】', includeLines: true }, 201);
    const delBytes = (await getBytes(c, `/api/pdf/deliveries/${d.delivery.id}`)).bytes;
    await expectGlyphsIntact(delBytes);
    const del = await pdfText(delBytes);
    expect(del.text).toContain('納品書');
    expect(del.text).toContain('納品物一式');
    expect(del.text).toContain('LP制作');
    expect(del.text).not.toContain('内部メモ');
    const corr = await c.post(`/api/invoices/${a.invoiceId}/corrections`, { requestId: rid(), reason: '金額訂正のため' }, 201);
    await c.post(`/api/invoice-versions/${corr.versionId}/finalize`, {}, 200);
    const cp = await pdfText((await getBytes(c, `/api/pdf/invoice-versions/${corr.versionId}`)).bytes);
    expect(cp.text).toContain('訂正版');
    expect(cp.text).toContain('金額訂正のため');
  });
});

describe('CSV出力', () => {
  it('5種類：BOM付きUTF-8・数式インジェクション対策', async () => {
    const { client: c } = await signup();
    await c.post('/api/customers', customerInput({ name: '=HYPERLINK("http://evil")', code: 'C9' }), 201);
    await setupInvoice(c);
    for (const name of ['customers', 'items', 'projects', 'invoices', 'payments']) {
      const res = await c.req('GET', `/api/data/export/${name}.csv`);
      expect(res.status).toBe(200);
      const buf = new Uint8Array(await res.arrayBuffer());
      expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    }
    const text = await (await c.req('GET', '/api/data/export/customers.csv')).text();
    const rows = parseCsv(text).rows;
    const evil = rows.find((r) => r[0] === 'C9')!;
    expect(evil[1]).toBe(`'=HYPERLINK("http://evil")`);
  });
});

describe('CSV取込（顧客・品目）', () => {
  it('プレビュー→取込、重複コードはスキップ、Shift_JIS', async () => {
    const { client: c } = await signup();
    const csv = '﻿顧客コード,会社名・屋号,担当者,敬称,郵便番号,住所,電話,メール,支払条件,振込名義,内部メモ\r\nC1,"株式会社A, 本社",山田,御中,,"住所\n2行目",,,,,\r\nC1,重複,,,,,,,,,\r\nC2,,,,,,,,,,\r\n';
    const fd = (preview: boolean, content: BlobPart = csv, encoding = 'utf-8') => {
      const f = new FormData();
      f.append('file', new File([content], 'c.csv'));
      f.append('encoding', encoding);
      if (preview) f.append('preview', '1');
      return f;
    };
    const pv = await c.json('POST', '/api/data/import/customers', fd(true));
    expect(pv.results.map((r: any) => r.status)).toEqual(['ok', 'duplicate', 'error']);
    expect((await c.get('/api/customers')).customers).toHaveLength(0);
    const done = await c.json('POST', '/api/data/import/customers', fd(false));
    expect(done.imported).toBe(1);
    const list = (await c.get('/api/customers')).customers;
    expect(list[0].name).toBe('株式会社A, 本社');
    expect(list[0].address).toBe('住所\n2行目');
    // Shift_JIS（品目）
    const sjisText = '品目コード,品名,説明,標準単価,単位,税率\r\nI1,ロゴ制作,説明,"50,000",式,10\r\n';
    const sjis = new Uint8Array(Buffer.from(new TextEncoder().encode(sjisText))); // UTF-8 bytes
    const bad = await c.json('POST', '/api/data/import/items', fd(false, sjis, 'shift_jis'));
    expect(bad._status).toBe(400); // UTF-8バイト列をShift_JISとして読むと失敗
    const encoded = encodeShiftJis(sjisText);
    const okr = await c.json('POST', '/api/data/import/items', fd(false, encoded as BlobPart, 'shift_jis'));
    expect(okr.imported).toBe(1);
    const items = (await c.get('/api/items')).items;
    expect(items[0]).toMatchObject({ name: 'ロゴ制作', unitPrice: 50000 });
  });
});

// テスト用：限られた文字のShift_JISエンコード（表で対応）
function encodeShiftJis(s: string): Uint8Array {
  const table: Record<string, number[]> = {
    品: [0x95, 0x69], 目: [0x96, 0xda], コ: [0x83, 0x52], ー: [0x81, 0x5b], ド: [0x83, 0x68], 名: [0x96, 0xbc], 説: [0x90, 0xe0], 明: [0x96, 0xbe],
    標: [0x95, 0x57], 準: [0x8f, 0x80], 単: [0x92, 0x50], 価: [0x89, 0xbf], 位: [0x88, 0xca], 税: [0x90, 0xc5], 率: [0x97, 0xa6], ロ: [0x83, 0x8d],
    ゴ: [0x83, 0x53], 制: [0x90, 0xa7], 作: [0x8d, 0xec], 式: [0x8e, 0xae],
  };
  const out: number[] = [];
  for (const ch of s) {
    if (table[ch]) out.push(...table[ch]);
    else if (ch.charCodeAt(0) < 0x80) out.push(ch.charCodeAt(0));
    else throw new Error(`no sjis for ${ch}`);
  }
  // 復号できることを確認
  expect(new TextDecoder('shift_jis').decode(new Uint8Array(out))).toBe(s);
  return new Uint8Array(out);
}

describe('バックアップ→空アカウントへ復元', () => {
  it('件数・金額・添付・スナップショットが一致', async () => {
    const A = await signup();
    const a = await setupInvoice(A.client, 100000);
    await A.client.post(`/api/invoices/${a.invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-09-25', amount: 30000, method: 'bank_transfer', payerName: '', memo: '' }, 201);
    await A.client.post('/api/payments', { requestId: rid(), receivedOn: '2026-09-26', amount: 777, method: 'cash', payerName: '未割当', memo: '' }, 201);
    const corr = await A.client.post(`/api/invoices/${a.invoiceId}/corrections`, { requestId: rid(), reason: '訂正' }, 201);
    await A.client.post(`/api/invoice-versions/${corr.versionId}/finalize`, {}, 200);
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], 'photo.png'));
    fd.append('purpose', 'project');
    fd.append('projectId', a.projectId);
    await A.client.json('POST', '/api/attachments', fd);
    await A.client.post(`/api/projects/${a.projectId}/tasks`, { requestId: rid(), title: 'タスク' }, 201);

    const { bytes } = await getBytes(A.client, '/api/data/backup.zip');
    const files = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest.stats.counts.invoice_versions).toBe(2);

    // データのあるアカウントには復元不可
    const up = (c: Client, b: Uint8Array) => {
      const f = new FormData();
      f.append('file', new File([b as BlobPart], 'backup.zip'));
      return c.json('POST', '/api/data/restore', f);
    };
    expect((await up(A.client, bytes))._status).toBe(422);

    // 空アカウントへ復元（同じ環境でもID衝突しない）
    const B = await signup();
    const r = await up(B.client, bytes);
    expect(r._status).toBe(200);
    expect(r.stats).toEqual(manifest.stats);
    const invs = await B.client.get('/api/invoices');
    expect(invs.invoices).toHaveLength(1);
    expect(invs.invoices[0]).toMatchObject({ total: 100000, allocated: 30000, remaining: 70000, paymentState: 'partial', currentRevision: 2 });
    expect(invs.invoices[0].id).not.toBe(a.invoiceId);
    const d = await B.client.get(`/api/projects/${invs.invoices[0].projectId}`);
    expect(d.attachments).toHaveLength(1);
    const file = await B.client.req('GET', `/api/attachments/${d.attachments[0].id}`);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const pdf = await B.client.req('GET', `/api/pdf/invoice-versions/${d.invoices[0].finalVersionId}`);
    expect(pdf.status).toBe(200);
    expect((await B.client.get('/api/payments?unallocated=1')).payments[0].amount).toBe(777);
    // 復元後も操作可能（採番は続きから）
    const np = await B.client.post('/api/projects', { requestId: rid(), customerId: d.customer.id, title: '復元後の新規', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' }, 201);
    const nd = await B.client.get(`/api/projects/${np.id}`);
    expect(nd.project.number).toMatch(/-0002$/);
  });

  it('改ざん・破損したバックアップは拒否（部分的に取り込まない）', async () => {
    const A = await signup();
    await setupInvoice(A.client);
    const { bytes } = await getBytes(A.client, '/api/data/backup.zip');
    const files = unzipSync(bytes);
    const data = JSON.parse(strFromU8(files['data.json']));
    data.tables.payments.push({ id: '00000000-0000-4000-8000-000000000001', received_on: '2026-09-01', amount: 5, method: 'cash', payer_name: '', memo: '', source: 'manual' });
    files['data.json'] = strToU8(JSON.stringify(data));
    const B = await signup();
    const f = new FormData();
    f.append('file', new File([zipSync(files) as BlobPart], 'b.zip'));
    const r = await B.client.json('POST', '/api/data/restore', f);
    expect(r._status).toBe(422);
    expect((await B.client.get('/api/customers')).customers).toHaveLength(0);
    const f2 = new FormData();
    f2.append('file', new File([new Uint8Array([1, 2, 3])], 'x.zip'));
    expect((await B.client.json('POST', '/api/data/restore', f2))._status).toBe(422);
  });
});

describe('デモ（サンプルデータ）', () => {
  it('架空データ入りの別アカウントを作成し、本番アカウントと混ざらない', async () => {
    const real = await signup();
    const demo = new Client();
    const r = await demo.post('/api/auth/demo', {}, 201);
    expect(r.account.isDemo).toBe(true);
    const projects = (await demo.get('/api/projects')).projects;
    const titles = projects.map((p: any) => p.title);
    expect(titles).toEqual(expect.arrayContaining(['秋キャンペーンLP制作', 'ロゴ制作', 'SNS運用代行（月次）', '会社案内パンフレット']));
    const lp = projects.find((p: any) => p.title === '秋キャンペーンLP制作');
    const d = await demo.get(`/api/projects/${lp.id}`);
    expect(d.quoteVersions.map((v: any) => Number(v.total))).toEqual([120000, 100000]);
    expect(d.activeOrder.amount).toBe(100000);
    expect(d.tasks.map((t: any) => t.title)).toEqual(['素材受領', '初稿', '確認', '修正', '納品']);
    expect(d.invoices[0]).toMatchObject({ total: 100000, allocated: 100000, paymentState: 'paid' });
    expect(d.project.status).toBe('completed');
    const dash = await demo.get('/api/dashboard');
    expect(dash.lists.overdue.length).toBe(1);
    expect(dash.lists.unbilled.length).toBe(1);
    expect(projects.find((p: any) => p.title === '会社案内パンフレット').status).toBe('lost');
    // 本番アカウントには何も入らない
    expect((await real.client.get('/api/projects')).projects).toHaveLength(0);
    const cnt = await pool.query('SELECT count(*)::int AS n FROM projects WHERE account_id=$1', [real.account.id]);
    expect(cnt.rows[0].n).toBe(0);
  });
});

describe('検索', () => {
  it('案件番号・案件名・顧客・見積番号・請求番号', async () => {
    const { client: c } = await signup();
    const a = await setupInvoice(c);
    const inv = (await c.get(`/api/invoices/${a.invoiceId}`)).invoice;
    const proj = (await c.get(`/api/projects/${a.projectId}`)).project;
    const qv = await c.get(`/api/quote-versions/${a.versionId}`);
    const q = (s: string) => c.get(`/api/search?q=${encodeURIComponent(s)}`);
    expect((await q(proj.number)).projects[0].id).toBe(a.projectId);
    expect((await q('キャンペーン')).projects[0].id).toBe(a.projectId);
    expect((await q('Sample')).customers.length).toBe(1);
    expect((await q(qv.version.number)).quotes[0].id).toBe(a.versionId);
    expect((await q(inv.number)).invoices[0].id).toBe(a.invoiceId);
    expect((await q('%')).projects).toHaveLength(0); // ワイルドカードはエスケープ
  });
});

describe('顧客・品目のアーカイブ', () => {
  it('取引のある顧客は削除不可→アーカイブ、新規案件不可', async () => {
    const { client: c } = await signup();
    const { customerId } = await setupProject(c);
    expect((await c.del(`/api/customers/${customerId}`, 409))._status).toBe(409);
    await c.post(`/api/customers/${customerId}/archive`, {}, 200);
    expect((await c.get('/api/customers')).customers).toHaveLength(0);
    expect((await c.get('/api/customers?archived=1')).customers).toHaveLength(1);
    const r = await c.post('/api/projects', { requestId: rid(), customerId, title: 'x', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' });
    expect(r._status).toBe(422);
  });

  it('品目の単価変更は確定済み見積に遡及しない', async () => {
    const { client: c } = await signup();
    const it = await c.post('/api/items', { code: 'I1', name: 'デザイン', description: '', unitPrice: 50000, unit: '式', taxRate: '10' }, 201);
    const { projectId } = await setupProject(c);
    const q = await c.post(`/api/projects/${projectId}/quotes`, { requestId: rid() }, 201);
    await c.put(`/api/quote-versions/${q.versionId}`, quoteDraft([line('デザイン', 50000, '1', '10', { itemId: it.item.id })], { taxMode: 'exclusive' }));
    await c.post(`/api/quote-versions/${q.versionId}/finalize`, {}, 200);
    await c.put(`/api/items/${it.item.id}`, { code: 'I1', name: 'デザイン改', description: '', unitPrice: 80000, unit: '式', taxRate: '10' });
    const v = await c.get(`/api/quote-versions/${q.versionId}`);
    expect(v.preview.lines[0]).toMatchObject({ name: 'デザイン', unitPrice: 50000 });
    expect(v.preview.totals.total).toBe(55000);
    expect((await c.del(`/api/items/${it.item.id}`, 409))._status).toBe(409);
  });
});
