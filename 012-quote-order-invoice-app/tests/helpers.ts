import crypto from 'node:crypto';
import { createApp } from '../server/src/app';
import { createPool } from '../server/src/db';
import { loadConfig } from '../server/src/config';

export const pool = createPool(process.env.DATABASE_URL!);

let fixedNow: Date | null = null;
export function setNow(d: Date | null) {
  fixedNow = d;
}

export function makeApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const config = { ...loadConfig(), ...overrides };
  return createApp({ pool, config, now: () => fixedNow ?? new Date() });
}

export const app = makeApp();

export const rid = () => `t-${crypto.randomUUID()}`;

type Json = Record<string, any>;

/** Cookie を保持する簡易クライアント（CSRFヘッダ付き） */
export class Client {
  cookie = '';
  constructor(public a = app) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'x-requested-with': 'FreelanceDesk', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this.a.request(path, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /fd_session=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `fd_session=${m[1]}` : '';
      if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(set)) this.cookie = '';
    }
    return res;
  }

  async json(method: string, path: string, body?: unknown, expectStatus?: number): Promise<Json> {
    const res = await this.req(method, path, body);
    const text = await res.text();
    let data: Json;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (expectStatus !== undefined && res.status !== expectStatus) {
      throw new Error(`${method} ${path} → ${res.status} (expected ${expectStatus}): ${text.slice(0, 500)}`);
    }
    return { ...data, _status: res.status };
  }

  get = (p: string, st = 200) => this.json('GET', p, undefined, st);
  post = (p: string, b: unknown = {}, st?: number) => this.json('POST', p, b, st);
  put = (p: string, b: unknown, st = 200) => this.json('PUT', p, b, st);
  patch = (p: string, b: unknown, st = 200) => this.json('PATCH', p, b, st);
  del = (p: string, st = 200) => this.json('DELETE', p, undefined, st);
}

export async function signup(email = `u-${crypto.randomUUID()}@example.com`, password = 'password-1234') {
  const c = new Client();
  const r = await c.post('/api/auth/signup', { email, password, businessName: 'テスト事業者' }, 201);
  return { client: c, email, password, account: r.account, recoveryCodes: r.recoveryCodes as string[] };
}

export const customerInput = (over: Json = {}) => ({
  code: '',
  name: 'Sample Design株式会社',
  contactName: '山田 花子',
  honorific: '御中',
  postalCode: '100-0001',
  address: '東京都千代田区サンプル1-2-3',
  phone: '03-0000-0000',
  email: 'info@example.com',
  paymentTerms: '月末締め翌月末払い',
  payerName: 'サンプルデザイン(カ',
  internalMemo: '内部メモ：値引き交渉あり',
  ...over,
});

export const line = (name: string, unitPrice: number, quantity = '1', taxRate = '10', over: Json = {}) => ({
  id: crypto.randomUUID(),
  itemId: null,
  name,
  description: '',
  quantity,
  unit: '式',
  unitPrice,
  taxRate,
  ...over,
});

export function quoteDraft(lines: Json[], over: Json = {}) {
  return {
    issueDate: '2026-09-01',
    validUntil: '2026-09-30',
    subject: '秋キャンペーンLP制作',
    deliveryNote: '受注後3週間',
    paymentTerms: '月末締め翌月末払い',
    notes: '備考です',
    taxMode: 'inclusive',
    lineRounding: 'round',
    taxRounding: 'floor',
    lines,
    adjustments: [],
    changeMemo: '',
    ...over,
  };
}

/** 顧客＋案件を作る */
export async function setupProject(c: Client, title = '秋キャンペーンLP制作') {
  const cu = await c.post('/api/customers', customerInput(), 201);
  const p = await c.post('/api/projects', { requestId: rid(), customerId: cu.customer.id, title, inquiryDate: '2026-08-25', plannedStart: null, plannedDue: '2026-10-10', internalMemo: '社外秘メモ' }, 201);
  return { customerId: cu.customer.id as string, projectId: p.id as string };
}

/** 見積作成→確定→受注まで */
export async function setupOrdered(c: Client, total = 100000) {
  const { customerId, projectId } = await setupProject(c);
  const q = await c.post(`/api/projects/${projectId}/quotes`, { requestId: rid() }, 201);
  await c.put(`/api/quote-versions/${q.versionId}`, quoteDraft([line('LP制作', total)]));
  await c.post(`/api/quote-versions/${q.versionId}/submit`, { submittedOn: '2026-09-02' }, 200);
  const o = await c.post(`/api/projects/${projectId}/orders`, { quoteVersionId: q.versionId, orderDate: '2026-09-05', dueDate: '2026-10-10' }, 201);
  return { customerId, projectId, versionId: q.versionId as string, orderId: o.order.id as string };
}

/** 受注→請求書発行まで */
export async function setupInvoice(c: Client, total = 100000, due = '2026-10-31') {
  const base = await setupOrdered(c, total);
  const inv = await c.post(`/api/projects/${base.projectId}/invoices`, { requestId: rid() }, 201);
  const v = await c.get(`/api/invoice-versions/${inv.versionId}`);
  const ver = v.version;
  await c.put(`/api/invoice-versions/${inv.versionId}`, {
    issueDate: '2026-09-20',
    dueDate: due,
    subject: ver.subject,
    paymentTerms: ver.paymentTerms,
    notes: ver.notes,
    bankInfo: 'テスト銀行 本店 普通 1234567',
    taxMode: ver.taxMode,
    lineRounding: ver.lineRounding,
    taxRounding: ver.taxRounding,
    lines: ver.lines,
    adjustments: ver.adjustments,
  });
  await c.post(`/api/invoice-versions/${inv.versionId}/finalize`, {}, 200);
  return { ...base, invoiceId: inv.invoiceId as string, invoiceVersionId: inv.versionId as string };
}
