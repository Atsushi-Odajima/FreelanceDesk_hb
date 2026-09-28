# DEVELOPMENT — 構成と開発手順

## ディレクトリ
```
012-quote-order-invoice-app/
├─ shared/            画面・サーバー共通（金額計算 calc.ts、CSV csv.ts、日付 dates.ts、状態 status.ts）
├─ server/
│  ├─ src/
│  │  ├─ index.ts     起動（マイグレーション→HTTP）
│  │  ├─ app.ts       Hono アプリ（セキュリティヘッダ・CSRF・認証・ルート・静的配信）
│  │  ├─ routes/      API（auth, business, customers, items, projects, quotes, orders, invoices, payments, dashboard, data, pdf, attachments）
│  │  ├─ services/    業務ロジック（quotes, orders, invoices, payments, backup, snapshot, timeline, upload, sample …）
│  │  ├─ pdf/         PDF生成（pdf-lib）
│  │  ├─ migrations/  SQL（001_init.sql）
│  │  └─ tools/       運営者用CLI（購入者コード発行・再設定リンク・サンプル）
│  └─ assets/fonts/   IPA Pゴシック＋ライセンス
├─ client/            React（Vite root）。public/ に manifest・sw.js・アイコン
├─ tests/unit         Vitest 単体
├─ tests/integration  Vitest 結合（実PostgreSQL）
├─ e2e/               Playwright（シナリオ1〜5、レスポンシブ、PWA、添付・PDF）
└─ scripts/           ビルド・ローカルDB・アイコン生成・E2E用DB初期化・復元確認
```

## 必要なもの（開発者のみ。利用者には不要）
- Node.js 22 以上、npm
- PostgreSQL 16（ローカル）…`npm run db:local` で `~/.freelance-desk-pg` に起動（port 54329）

## 手順
```bash
npm ci
npm run db:local                       # 開発DB・テストDBを作成
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/freelance_desk
npm run dev                            # API :3000 + Vite :5173（/api をプロキシ）
npm run seed:sample -- demo@example.com password1234   # 架空データ入りデモアカウント（任意）
```

## ビルド・起動（本番と同じ形）
```bash
npm run build          # dist/client（画面）＋ dist/server（API 1ファイル、SQL・フォント同梱）
DATABASE_URL=... NODE_ENV=production node dist/server/index.js
```

## テスト
```bash
npm run typecheck
npm test                     # 単体＋結合（TEST_DATABASE_URL 既定: postgres://postgres@127.0.0.1:54329/freelance_desk_test）
npm run test:e2e             # ビルド後に Playwright（E2E_DATABASE_URL 既定: …/freelance_desk_e2e、毎回作り直し）
```
- Chromium は `PLAYWRIGHT_CHROMIUM`（既定 /opt/pw-browsers/chromium-1194/chrome-linux/chrome）。存在しなければ Playwright 既定のブラウザ。
- 結合テストは起動時に `freelance_desk_test` の public スキーマを作り直します。本番DBを指定しないでください。

## 規約
- 金額計算は必ず `shared/calc.ts` を使う（画面とサーバーで結果を一致させる）。
- 作成系APIは `requestId` を受け取り冪等にする（`lockRequest` + 一意制約）。
- すべてのSQLに `account_id` 条件。IDはパスパラメータで `idParam()` を通す。
- PDF・画面の確定書類はスナップショットのみ参照。
- 新しいマイグレーションは `server/src/migrations/002_xxx.sql` として追加（適用済みファイルは変更しない）。

## よく使うスクリプト
| コマンド | 内容 |
|---|---|
| `npm run codes:create -- 10 "10月販売分"` | 購入者コード発行（ビルド後。開発時は `codes:create:dev`） |
| `npm run account:reset-link -- user@example.com` | 再設定リンク発行（運営者用） |
| `npm run icons` | PWAアイコン再生成（Chromium使用） |
| `node scripts/restore-roundtrip-check.mjs` | バックアップ→別環境へ復元→一致確認 |
