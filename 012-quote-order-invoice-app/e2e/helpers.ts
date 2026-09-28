import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import crypto from 'node:crypto';

export const MOBILE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
export const PC = { viewport: { width: 1366, height: 900 } };

export const rid = () => `e2e-${crypto.randomUUID()}`;
const H = { 'x-requested-with': 'FreelanceDesk' };

export async function apiPost(req: APIRequestContext, path: string, data: unknown = {}) {
  const r = await req.post(path, { data, headers: H });
  if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
}
export async function apiPut(req: APIRequestContext, path: string, data: unknown) {
  const r = await req.put(path, { data, headers: H });
  if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
}
export async function apiGet(req: APIRequestContext, path: string) {
  const r = await req.get(path);
  if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
}

/** API経由で登録（ページのCookieにセッションが入る） */
export async function signupApi(page: Page, email = `e2e-${crypto.randomUUID()}@example.com`, password = 'password-1234') {
  await apiPost(page.request, '/api/auth/signup', { email, password, businessName: 'E2E制作室' });
  return { email, password };
}

export async function loginUi(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

export const line = (name: string, unitPrice: number, quantity = '1') => ({ id: rid(), itemId: null, name, description: '', quantity, unit: '式', unitPrice, taxRate: '10' });

/** API で 顧客→案件→見積確定→受注 まで作る */
export async function apiOrdered(req: APIRequestContext, opts: { customer?: string; payer?: string; title?: string; total?: number } = {}) {
  const cu = await apiPost(req, '/api/customers', {
    code: '', name: opts.customer ?? 'Sample Design株式会社', contactName: '', honorific: '御中', postalCode: '', address: '', phone: '', email: '',
    paymentTerms: '', payerName: opts.payer ?? 'ｻﾝﾌﾟﾙﾃﾞｻﾞｲﾝ(ｶ', internalMemo: '',
  });
  const p = await apiPost(req, '/api/projects', { requestId: rid(), customerId: cu.customer.id, title: opts.title ?? 'E2E案件', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' });
  const q = await apiPost(req, `/api/projects/${p.id}/quotes`, { requestId: rid() });
  await apiPut(req, `/api/quote-versions/${q.versionId}`, {
    issueDate: '2026-08-01', validUntil: null, subject: opts.title ?? 'E2E案件', deliveryNote: '', paymentTerms: '', notes: '',
    taxMode: 'inclusive', lineRounding: 'round', taxRounding: 'floor', lines: [line('制作', opts.total ?? 55000)], adjustments: [], changeMemo: '',
  });
  await apiPost(req, `/api/quote-versions/${q.versionId}/finalize`);
  await apiPost(req, `/api/projects/${p.id}/orders`, { quoteVersionId: q.versionId, orderDate: '2026-08-02', dueDate: null });
  return { projectId: p.id as string, customerId: cu.customer.id as string };
}

export async function apiIssuedInvoice(req: APIRequestContext, dueDate: string, opts: Parameters<typeof apiOrdered>[1] = {}) {
  const o = await apiOrdered(req, opts);
  const inv = await apiPost(req, `/api/projects/${o.projectId}/invoices`, { requestId: rid() });
  const v = (await apiGet(req, `/api/invoice-versions/${inv.versionId}`)).version;
  await apiPut(req, `/api/invoice-versions/${inv.versionId}`, {
    issueDate: '2026-08-10', dueDate, subject: v.subject, paymentTerms: v.paymentTerms, notes: v.notes, bankInfo: v.bankInfo,
    taxMode: v.taxMode, lineRounding: v.lineRounding, taxRounding: v.taxRounding, lines: v.lines, adjustments: v.adjustments,
  });
  await apiPost(req, `/api/invoice-versions/${inv.versionId}/finalize`);
  return { ...o, invoiceId: inv.invoiceId as string };
}

export async function noHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `横スクロールが発生（${page.url()}）`).toBeLessThanOrEqual(1);
}

export async function newCtx(browser: Browser, device: typeof MOBILE | typeof PC) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  return { ctx, page };
}
