// E2E：FreelanceDesk クライアントポータル
// 運営者が制作物を提出・招待リンクを発行 → お客様がスマホで招待リンクから入室 → 修正指示（ピン）→ 修正指示書 → 承認 → 写真セレクトを番号入力で選んで送信 → 運営者が結果を確認
import { test, expect, type APIRequestContext } from '@playwright/test';
import zlib from 'node:zlib';
import { MOBILE, PC, apiPost, apiPut, newCtx, noHorizontalOverflow, rid, signupApi } from './helpers';

const H = { 'x-requested-with': 'FreelanceDesk' };

/** 単色のPNG（ブラウザで表示できる実画像） */
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function upload(req: APIRequestContext, url: string, name: string, buffer: Buffer) {
  const r = await req.post(url, { headers: H, multipart: { file: { name, mimeType: 'image/png', buffer }, requestId: rid() } });
  if (!r.ok()) throw new Error(`${url} ${r.status()} ${await r.text()}`);
  return r.json();
}

test('クライアントポータル：招待→修正指示→指示書→承認→写真セレクト送信', async ({ browser }) => {
  // ---- 運営者（API で準備） ----
  const op = await newCtx(browser, PC);
  await signupApi(op.page);
  const req = op.page.request;
  const cu = await apiPost(req, '/api/customers', {
    code: '', name: 'Sample Design株式会社', contactName: '山田 花子', honorific: '御中', postalCode: '', address: '', phone: '', email: 'client@example.com',
    paymentTerms: '', payerName: '', internalMemo: '',
  });
  const p = await apiPost(req, '/api/projects', { requestId: rid(), customerId: cu.customer.id, title: 'ポータルE2E案件', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' });
  const base = `/api/projects/${p.id}/portal`;
  await apiPut(req, base, { status: 'published', statusLabel: 'デザイン確認中', guidance: 'トップページのデザインをご確認ください' });
  const dl = await apiPost(req, `${base}/deliverables`, { title: 'トップページ' });
  await upload(req, `${base}/deliverables/${dl.deliverable.id}/versions`, 'top.png', makePng(600, 400, [240, 240, 250]));
  const sel = await apiPost(req, `${base}/selections`, { title: '撮影セレクト', message: '使う写真を選んでください', showNames: true });
  await upload(req, `${base}/selections/${sel.id}/photos`, 'IMG_0001.png', makePng(120, 90, [200, 80, 80]));
  await upload(req, `${base}/selections/${sel.id}/photos`, 'IMG_0002.png', makePng(120, 90, [80, 200, 80]));
  await apiPost(req, `${base}/selections/${sel.id}/status`, { status: 'open' });

  // 運営者画面：クライアントポータルタブから招待リンクを発行
  await op.page.goto(`/projects/${p.id}?tab=portal`);
  await expect(op.page.getByTestId('portal-tab')).toBeVisible();
  await expect(op.page.getByText('トップページ', { exact: true })).toBeVisible();
  await op.page.getByRole('button', { name: '招待リンクを発行' }).click();
  const inviteUrl = (await op.page.getByTestId('invite-url').textContent())!.trim();
  expect(inviteUrl).toMatch(/\/portal\/invite#t=[A-Za-z0-9_-]{43}$/);

  // ---- お客様（スマホ・別の端末＝Cookieなし） ----
  const cl = await newCtx(browser, MOBILE);
  const page = cl.page;
  await page.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page.getByText('ポータルE2E案件')).toBeVisible();
  await page.getByLabel('メールアドレス').fill('wrong@example.com');
  await page.getByRole('button', { name: 'ポータルを開く' }).click();
  await expect(page.getByRole('alert')).toContainText('メールアドレスが一致しません');
  await page.getByLabel('メールアドレス').fill('client@example.com');
  await page.getByRole('button', { name: 'ポータルを開く' }).click();
  await expect(page.getByRole('heading', { name: 'ポータルE2E案件' })).toBeVisible();
  await expect(page.getByTestId('portal-status')).toHaveText('デザイン確認中');
  await noHorizontalOverflow(page);

  // 修正指示（ピン）
  await page.getByRole('link', { name: /トップページ v1/ }).click();
  await page.getByRole('button', { name: '画像に修正指示（ピン）を置く' }).click();
  const img = page.getByTestId('pin-image');
  await img.click({ position: { x: 60, y: 40 } });
  await page.getByRole('button', { name: '少し大きくしてください' }).click();
  await page.getByRole('button', { name: '修正指示を追加' }).click();
  await expect(page.locator('.pin').first()).toHaveText('1');
  await expect(page.getByText('少し大きくしてください。')).toBeVisible();
  await noHorizontalOverflow(page);

  // 修正指示書
  await page.getByRole('link', { name: '修正指示書を見る' }).click();
  await expect(page.getByTestId('sheet-text')).toContainText('① [変更]');
  await expect(page.getByTestId('sheet-text')).toContainText('少し大きくしてください。');
  await page.getByRole('link', { name: '← 版の確認に戻る' }).click();

  // 承認（確認ダイアログは自動で承諾）
  await page.getByRole('button', { name: 'この版を承認する' }).click();
  await expect(page.getByText(/様が承認しました/)).toBeVisible();

  // 写真セレクト：番号入力で選んで送信
  await page.getByRole('link', { name: /ポータルE2E案件 に戻る/ }).click();
  await expect(page.getByText('承認：トップページ v1')).toBeVisible();
  await page.getByRole('link', { name: /撮影セレクト/ }).click();
  await page.getByLabel('番号で選ぶ').fill('２、9');
  await page.getByRole('button', { name: '選択に追加' }).click();
  await expect(page.getByTestId('number-check')).toContainText('該当する写真がない番号：009');
  await expect(page.getByTestId('pick-count')).toHaveText('選択中 1枚');
  await page.getByRole('button', { name: /写真 001/ }).click();
  await expect(page.getByTestId('pick-count')).toHaveText('選択中 2枚');
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: '選んだ写真を送信する' }).click();
  await expect(page.getByText(/送信済み/)).toBeVisible();

  // ---- 運営者：結果の確認 ----
  await op.page.goto(`/projects/${p.id}/portal/select/${sel.id}`);
  await expect(op.page.getByTestId('selection-response')).toContainText('001 → IMG_0001.png');
  await expect(op.page.getByTestId('selection-response')).toContainText('002 → IMG_0002.png');
  await op.page.goto(`/projects/${p.id}?tab=portal`);
  await expect(op.page.getByText('山田 花子様が承認')).toBeVisible();

  await cl.ctx.close();
  await op.ctx.close();
});
