// E2E シナリオ1：スマホ画面で 顧客→案件→見積v1→v2→v2提出→受注→タスク→納品→請求→30,000入金→70,000入金→完了
import { test, expect } from '@playwright/test';
import { MOBILE, newCtx, noHorizontalOverflow } from './helpers';

test('シナリオ1：一連の流れをスマホ幅(375px)で完了できる', async ({ browser }) => {
  const { ctx, page } = await newCtx(browser, MOBILE);
  const email = `s1-${Date.now()}@example.com`;

  // 登録（復旧コード表示）
  await page.goto('/signup');
  await page.getByLabel('屋号・事業者名（あとで変更可）').fill('E2E制作室');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード（10文字以上）').fill('password-1234');
  await page.getByLabel('パスワード（確認）').fill('password-1234');
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  await page.getByRole('button', { name: /控えました/ }).click();
  await expect(page).toHaveURL(/settings/);

  // 案件登録（その場で顧客も登録）
  await page.goto('/projects/new');
  await page.getByRole('button', { name: '＋ 新しい顧客' }).click();
  await page.getByLabel('会社名・屋号（必須）').fill('Sample Design株式会社');
  await page.getByRole('textbox', { name: '担当者' }).fill('山田 花子');
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
  await expect(page.getByLabel('顧客', { exact: true })).toHaveValue(/.+/);
  await page.getByLabel('案件名').fill('秋キャンペーンLP制作');
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await expect(page.getByRole('heading', { name: '秋キャンペーンLP制作' })).toBeVisible();

  // 見積 v1（120,000円・内税）
  await page.getByTestId('next-action').click();
  await expect(page).toHaveURL(/\/quotes\//);
  for (const [i, [name, price]] of ([
    ['デザイン', '60000'],
    ['コーディング', '40000'],
    ['撮影素材手配', '20000'],
  ] as const).entries()) {
    await page.getByTestId('add-line').click();
    await page.getByLabel(`品目${i + 1}の名称`).fill(name);
    await page.getByLabel(`品目${i + 1}の単価`).fill(price);
  }
  await page.getByLabel('税の表示').selectOption('inclusive');
  await expect(page.getByTestId('totals')).toContainText('¥120,000');
  await expect(page.getByTestId('save-state')).toContainText('端末下書き');
  await noHorizontalOverflow(page);
  await page.getByTestId('finalize-quote').click();
  await expect(page.getByText('確定済み')).toBeVisible();
  await page.getByTestId('submit-quote').click();
  await page.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByText(/確定済み・提出/)).toBeVisible();

  // v2（複製して撮影素材手配を削除 → 100,000円）
  await page.getByTestId('new-version').click();
  await expect(page.getByRole('heading', { name: /v2/ })).toBeVisible();
  await page.locator('[data-testid=lines] .line-card').nth(2).getByRole('button', { name: '削除' }).click();
  await page.getByLabel(/変更メモ/).fill('素材は先方支給に変更');
  await expect(page.getByTestId('totals')).toContainText('¥100,000');
  await page.getByTestId('finalize-quote').click();
  await page.getByTestId('submit-quote').click();
  await page.getByRole('button', { name: '記録する' }).click();
  await expect(page.getByText(/確定済み・提出/)).toBeVisible();
  // 版履歴に v1 120,000 と v2 100,000
  await expect(page.getByRole('link', { name: /v1.*120,000円/ })).toBeVisible();

  // 受注
  await page.getByRole('link', { name: 'この見積で受注' }).click();
  await expect(page.getByRole('dialog')).toContainText('¥100,000');
  await page.getByRole('button', { name: '受注を登録' }).click();
  await expect(page.getByTestId('project-detail').getByText('受注', { exact: true }).first()).toBeVisible();

  // タスク
  await page.getByRole('tab', { name: /タスク/ }).click();
  for (const t of ['素材受領', '初稿', '確認', '修正', '納品']) {
    await page.getByLabel('タスク名').fill(t);
    await page.getByRole('button', { name: '追加' }).click();
    await expect(page.getByTestId('task-list')).toContainText(t);
  }
  for (const t of ['素材受領', '初稿', '確認', '修正', '納品']) {
    await page.getByLabel(`${t}を完了`).check();
    await expect(page.getByLabel(`${t}を完了`)).toBeChecked();
  }

  // 納品（請求は自動生成されない）
  await page.getByRole('tab', { name: '納品' }).click();
  await page.getByRole('button', { name: '納品を記録' }).first().click();
  await page.getByLabel('納品内容（納品書に記載）').fill('LP一式');
  await page.getByRole('dialog').getByRole('button', { name: '納品を記録' }).click();
  await expect(page.getByText(/D-\d{4}-0001/).first()).toBeVisible();
  await page.getByRole('tab', { name: '請求・入金' }).click();
  await expect(page.getByText('請求書はありません')).toBeVisible();

  // 請求書を作る → 確認 → 確定
  await page.getByRole('button', { name: '請求書を作る' }).last().click();
  await expect(page).toHaveURL(/invoice-versions/);
  await expect(page.getByTestId('totals')).toContainText('¥100,000');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('finalize-invoice').click();
  await expect(page).toHaveURL(/\/invoices\//);
  await expect(page.getByRole('heading', { name: /請求書 INV-/ })).toBeVisible();

  // 入金 30,000 → 一部入金
  await page.getByTestId('record-payment').click();
  await page.getByLabel('入金額').fill('30000');
  await page.getByTestId('save-payment').click();
  await expect(page.getByTestId('remaining')).toContainText('¥70,000');
  await expect(page.getByText('一部入金').first()).toBeVisible();
  // 入金 70,000 → 入金済み
  await page.getByTestId('record-payment').click();
  await expect(page.getByLabel('入金額')).toHaveValue('70000');
  await page.getByTestId('save-payment').click();
  await expect(page.getByTestId('remaining')).toContainText('¥0');
  await expect(page.getByText('入金済み').first()).toBeVisible();
  await noHorizontalOverflow(page);

  // 完了
  await page.getByRole('link', { name: '‹ 案件へ' }).click();
  await page.getByTestId('next-action').click();
  await expect(page.getByTestId('project-detail').getByText('完了', { exact: true }).first()).toBeVisible();
  await ctx.close();
});
