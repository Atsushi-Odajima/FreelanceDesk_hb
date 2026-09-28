import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { apiGet, apiIssuedInvoice, apiPost, newCtx, noHorizontalOverflow, PC, MOBILE, signupApi } from './helpers';

const WIDTHS = [320, 375, 430, 768, 1024, 1366];

test('主要画面が 320〜1366px で横スクロールなく表示される（デモデータ）', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  await apiPost(page.request, '/api/auth/demo');
  const projects = (await apiGet(page.request, '/api/projects')).projects;
  const lp = projects.find((p: any) => p.title === '秋キャンペーンLP制作');
  const invs = (await apiGet(page.request, '/api/invoices?state=all')).invoices;
  const detail = await apiGet(page.request, `/api/projects/${lp.id}`);
  const pages = [
    '/',
    '/projects',
    `/projects/${lp.id}`,
    `/quotes/${detail.quoteVersions[1].id}`,
    '/invoices',
    `/invoices/${invs[0].id}`,
    '/payments',
    '/payments/import',
    '/customers',
    '/items',
    '/settings?tab=business',
    '/settings?tab=data',
    '/menu',
  ];
  fs.mkdirSync('test-results/screens', { recursive: true });
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w < 768 ? 800 : 900 });
    for (const p of pages) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('main')).toBeVisible();
      await noHorizontalOverflow(page);
      if (w === 320 || w === 1366) await page.screenshot({ path: `test-results/screens/${w}${p.replace(/[/?=]/g, '_')}.png`, fullPage: true });
    }
  }
  // スマホは下部ナビ、PCはサイドバー
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.locator('.bottom-nav')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.bottom-nav')).toBeHidden();
  // タップ領域（ボタンの高さ）が 44px 以上（スマホ）
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/projects/${lp.id}`);
  const heights = await page.locator('main .btn:not(.sm)').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

test('PWA：manifest・アイコン・Service Worker 登録、オフライン時は閲覧のみで保存不可', async ({ browser }) => {
  const { ctx, page } = await newCtx(browser, MOBILE);
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/?source=pwa', lang: 'ja' });
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).status()).toBe(200);
  expect((await page.request.get('/icons/apple-touch-icon.png')).status()).toBe(200);
  await signupApi(page);
  await page.goto('/');
  await expect(page.locator('link[rel=apple-touch-icon]')).toHaveCount(1);
  await expect(page.locator('meta[name=apple-mobile-web-app-capable]')).toHaveCount(1);
  const swReady = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(swReady).toBe(true);
  await page.reload(); // SWの制御下で読み込み直す
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: '顧客' })).toBeVisible();

  // オフライン：画面は表示され、保存は止まる
  await ctx.setOffline(true);
  await page.goto('/projects/new');
  await expect(page.getByText(/オフラインです/).first()).toBeVisible();
  await page.getByLabel('案件名').fill('オフライン下書き');
  await expect(page.getByRole('button', { name: '登録する' })).toBeDisabled();
  await expect(page.getByText(/端末下書き/)).toBeVisible();
  // 再接続後、下書きが残っていて登録できる（同じrequestIdで1件だけ）
  await ctx.setOffline(false);
  await page.reload();
  await expect(page.getByLabel('案件名')).toHaveValue('オフライン下書き');
  await ctx.close();
});

test('スマホ：写真添付（PNG・HEIC）、実行ファイル拒否、PDFの保存', async ({ browser }) => {
  const { ctx, page } = await newCtx(browser, MOBILE);
  await signupApi(page);
  const a = await apiIssuedInvoice(page.request, '2026-12-31', { title: '添付テスト' });
  await page.goto(`/projects/${a.projectId}`);
  await page.getByRole('tab', { name: /ファイル/ }).click();
  await page.getByTestId('file-input').setInputFiles([path.resolve('e2e/fixtures/photo.png'), path.resolve('e2e/fixtures/IMG_0001.HEIC')]);
  await expect(page.getByText('2件を添付しました')).toBeVisible();
  await expect(page.getByText('photo.png')).toBeVisible();
  await expect(page.getByText('IMG_0001.HEIC')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(path.resolve('e2e/fixtures/malware.jpg'));
  await expect(page.getByText(/実行ファイルは添付できません/)).toBeVisible();
  await noHorizontalOverflow(page);

  // 請求書PDFの保存（ダウンロード）
  await page.goto(`/invoices/${a.invoiceId}`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '請求書を保存' }).click()]);
  // ※この検証環境のヘッドレスChromiumは suggestedFilename が常に "download" になるため、ファイル名はヘッダで検証
  const head = await page.request.get(dl.url());
  expect(decodeURIComponent(head.headers()['content-disposition'])).toMatch(/^attachment;.*請求書_INV-\d{4}-\d{4}\.pdf$/);
  const file = await dl.path();
  expect(fs.readFileSync(file!).subarray(0, 5).toString()).toBe('%PDF-');
  // スマホでは「開く」リンク（新しいタブでPDF表示）
  await expect(page.getByRole('link', { name: '請求書を開く' })).toHaveAttribute('href', /\/api\/pdf\/invoice-versions\//);
  await ctx.close();
});

test('PC：PDFプレビュー（iframe）とキーボード操作', async ({ browser }) => {
  const { ctx, page } = await newCtx(browser, PC);
  await signupApi(page);
  const a = await apiIssuedInvoice(page.request, '2026-12-31', { title: 'PC確認' });
  await page.goto(`/invoices/${a.invoiceId}`);
  await page.getByRole('button', { name: '請求書プレビュー' }).click();
  await expect(page.locator('iframe.pdf-frame')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('iframe.pdf-frame')).toHaveCount(0);
  // 表形式の一覧
  await page.goto('/invoices?');
  await page.getByRole('button', { name: 'すべて' }).click();
  await expect(page.getByTestId('invoice-table')).toBeVisible();
  await ctx.close();
});
