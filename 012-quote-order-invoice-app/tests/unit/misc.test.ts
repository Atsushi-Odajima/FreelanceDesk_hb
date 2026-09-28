import { describe, expect, it } from 'vitest';
import { addDays, endOfMonth, isValidDate, todayIn, weekRange } from '../../shared/dates';
import { advanceStatus } from '../../shared/status';
import { detectFile, sanitizeFilename, contentDisposition, UploadRejected } from '../../server/src/services/upload';
import { bankRowKeys, normalizePayerName } from '../../server/src/services/payments';
import { buildTimeline } from '../../server/src/services/timeline';

describe('日付', () => {
  it('JSTの今日', () => {
    expect(todayIn('Asia/Tokyo', new Date('2026-09-27T15:30:00Z'))).toBe('2026-09-28');
    expect(todayIn('Asia/Tokyo', new Date('2026-09-27T14:59:00Z'))).toBe('2026-09-27');
  });
  it('加算・月末・週', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(weekRange('2026-09-28')).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // 月曜
    expect(weekRange('2026-10-04')).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // 日曜
    expect(isValidDate('2026-02-29')).toBe(false);
  });
});

describe('案件状態の自動前進', () => {
  it('前進のみ・終了状態は変えない', () => {
    expect(advanceStatus('inquiry', 'quoting')).toBe('quoting');
    expect(advanceStatus('ordered', 'quote_submitted')).toBe('ordered');
    expect(advanceStatus('lost', 'ordered')).toBe('lost');
    expect(advanceStatus('completed', 'invoiced')).toBe('completed');
  });
});

describe('添付ファイルの実体検証', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it('画像・PDF', () => {
    expect(detectFile('a.jpg', bytes(0xff, 0xd8, 0xff, 0xe0)).mime).toBe('image/jpeg');
    expect(detectFile('a.png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).mime).toBe('image/png');
    expect(detectFile('doc.pdf', new TextEncoder().encode('%PDF-1.7\n')).mime).toBe('application/pdf');
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
    expect(detectFile('IMG_0001.HEIC', heic).mime).toBe('image/heic');
  });
  it('拡張子偽装の実行ファイルを拒否', () => {
    expect(() => detectFile('photo.jpg', bytes(0x4d, 0x5a, 0x90, 0x00))).toThrow(UploadRejected);
    expect(() => detectFile('a.txt', new TextEncoder().encode('#!/bin/sh\nrm -rf /'))).toThrow(UploadRejected);
  });
  it('危険な拡張子・HTML・SVGを拒否', () => {
    expect(() => detectFile('setup.exe', bytes(0xff, 0xd8, 0xff))).toThrow(/安全のため/);
    expect(() => detectFile('x.svg', new TextEncoder().encode('<svg onload=alert(1)>'))).toThrow(UploadRejected);
    expect(() => detectFile('x.html', new TextEncoder().encode('<html>'))).toThrow(UploadRejected);
  });
  it('不明な形式を拒否', () => {
    expect(() => detectFile('a.bin', bytes(1, 2, 3, 4))).toThrow(UploadRejected);
  });
  it('マクロ付きOffice・一般ZIPを拒否', () => {
    const zipHead = new TextEncoder().encode('PK\u0003\u0004....[Content_Types].xml....word/vbaProject.bin');
    expect(() => detectFile('a.docx', zipHead)).toThrow(/マクロ/);
    expect(() => detectFile('a.zip', new TextEncoder().encode('PK\u0003\u0004'))).toThrow(UploadRejected);
    expect(detectFile('a.xlsx', new TextEncoder().encode('PK\u0003\u0004[Content_Types].xml')).kind).toBe('office');
  });
  it('ファイル名の無害化とContent-Disposition', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a"b<c>.pdf')).toBe('abc.pdf');
    expect(contentDisposition('attachment', '見積書.pdf')).toContain("filename*=UTF-8''%E8%A6%8B");
  });
});

describe('銀行明細の行キー', () => {
  it('同一内容の行は出現順で区別、同じCSVなら同じキー', () => {
    const rows = [
      { date: '2026-09-01', name: 'ｻﾝﾌﾟﾙ', amount: 1000 },
      { date: '2026-09-01', name: 'サンプル', amount: 1000 },
    ];
    const k = bankRowKeys(rows);
    expect(k[0]).not.toBe(k[1]);
    expect(bankRowKeys(rows)).toEqual(k);
  });
  it('名義の正規化（半角カナ・法人格・空白）', () => {
    expect(normalizePayerName('ｻﾝﾌﾟﾙﾃﾞｻﾞｲﾝ(ｶ')).toBe(normalizePayerName('サンプルデザイン'));
    expect(normalizePayerName('Sample Design株式会社')).toBe('SAMPLEDESIGN');
  });
});

describe('タイムライン', () => {
  const base = {
    project: { status: 'inquiry', inquiry_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' },
    quoteVersions: [],
    order: null,
    tasks: [],
    deliveries: [],
    invoices: [],
  };
  it('問い合わせ直後は「見積を作成」が次の操作', () => {
    const t = buildTimeline(base);
    expect(t.map((e) => e.step)).toEqual(['inquiry', 'quote', 'order', 'work', 'delivery', 'invoice', 'payment']);
    expect(t[1].nextAction?.key).toBe('create_quote');
  });
  it('入金済みなら「完了にする」を提示', () => {
    const t = buildTimeline({
      ...base,
      project: { ...base.project, status: 'invoiced' },
      quoteVersions: [{ id: 'q', number: 'Q-1', version: 2, status: 'final', submitted_on: '2026-09-02', finalized_at: null, total: 100000, created_at: '' }],
      order: { id: 'o', order_date: '2026-09-03', amount: 100000 },
      deliveries: [{ id: 'd', number: 'D-1', delivered_on: '2026-09-10' }],
      invoices: [{ id: 'i', number: 'INV-1', status: 'issued', issueDate: '2026-09-11', total: 100000, paymentState: 'paid', remaining: 0, lastPaymentOn: '2026-09-20', overdue: false }],
    });
    expect(t.every((e) => e.state === 'done')).toBe(true);
    expect(t[6].nextAction?.key).toBe('complete');
  });
  it('失注は以降の工程をスキップ', () => {
    const t = buildTimeline({
      ...base,
      project: { ...base.project, status: 'lost' },
      quoteVersions: [{ id: 'q', number: 'Q-1', version: 1, status: 'final', submitted_on: '2026-09-02', finalized_at: null, total: 1, created_at: '' }],
    });
    expect(t[2].state).toBe('skipped');
    expect(t.some((e) => e.nextAction)).toBe(false);
  });
});
