# OPERATIONS — デプロイ・バックアップ・復旧（運営者向け）

> 本番公開・有料プランの契約は運営者自身の判断で行ってください。開発時点ではいずれも実施していません。

## 1. デプロイ（推奨：Render、Docker）
1. GitHub にこのフォルダを含むリポジトリを用意。
2. Render ダッシュボード → New → Blueprint → リポジトリを選択（`012-quote-order-invoice-app/render.yaml`）。
   - Blueprint を使わない場合：PostgreSQL（Basic-256mb 以上）を作成 → Web Service（Docker、Root Directory=`012-quote-order-invoice-app`、Health Check Path=`/api/health`）。
3. 環境変数（`.env.example` 参照）：
   - `DATABASE_URL`（Render内部接続文字列）
   - `APP_ORIGIN`（例 `https://desk.example.com`。カスタムドメイン設定後の値）
   - `SIGNUP_CODE_REQUIRED=true`（購入者のみ登録させる場合）
   - `TRUST_PROXY=true`、`TRUST_PROXY_HOPS=1`（前段プロキシの段数。Render での X-Forwarded-For の付き方は**未確認**のため、デプロイ後に Render の X-Forwarded-For の形式を確認し、必要なら調整。アプリのログにはIPを出力しません）
4. デプロイ後、起動時にマイグレーションが自動適用されます（アドバイザリロックで多重実行防止）。
5. 動作確認：`/api/health` が `{"ok":true}`、ログイン画面の表示、デモで一連の操作、PDF保存。
6. 購入者コード発行：Render の Shell で `npm run codes:create -- 20 "2026年10月販売分"`。表示されたコードを購入者へ個別に通知（再表示不可）。

他社（Fly.io 等）でも `Dockerfile` で同様に動作する想定（未検証）。PostgreSQL 16 を推奨（`ON DELETE SET NULL (列)` 構文のため 15 以上必須）。

## 2. バックアップ
| 種類 | 方法 | 頻度 |
|---|---|---|
| DB全体（運営者） | Render Postgres の自動バックアップ／PITR（有料プラン。Hobby 3日・Pro 7日） | 自動 |
| DB全体のオフサイト（推奨） | `pg_dump --format=custom "$DATABASE_URL" > fd_$(date +%F).dump` を Cloudflare R2 / Backblaze B2 へ保存 | 毎日 |
| 利用者ごと | 画面「設定・データ → バックアップをダウンロード」（ZIP：全データ＋添付） | 利用者に月1回以上を推奨 |

## 3. 復旧
- **DB全体**：Render の復元機能、または `pg_restore --clean --if-exists -d "$DATABASE_URL" fd_YYYY-MM-DD.dump`。
- **利用者単位**：新しいアカウントを作成し「バックアップから復元」。空のアカウントにのみ復元でき、復元後に件数・金額を自動照合。
- 復元確認の自動チェック：`SRC_URL=… DST_URL=… node scripts/restore-roundtrip-check.mjs`（実施記録は TEST_REPORT.md）。

## 4. 障害時の確認手順
1. `/api/health` を確認（DB接続を含む）。
2. ログ（Render Logs）：`METHOD /path STATUS ms` 形式。本文・個人情報は出ません。`[error]` 行を確認。
3. DB接続切れはプロセスを落とさず次のリクエストで再接続（`pool.on('error')`）。
4. 復旧コードを失った利用者：本人確認後 `npm run account:reset-link -- user@example.com`（24時間有効、画面表示のみ）。

## 5. 定期作業
- 期限切れセッション・再設定トークン・デモアカウントはアプリが1時間ごとに自動削除。
- 依存パッケージの更新：月1回 `npm outdated` → 更新 → `npm test && npm run test:e2e` → デプロイ。
- 容量監視：Render のDB容量。添付は1アカウント500MB上限（`ACCOUNT_STORAGE_QUOTA_BYTES`）。

## 6. サービス終了・移転時
- 利用者へ十分な期間をもって告知し、「バックアップをダウンロード」「CSV出力」を案内（注意事項.txt に記載）。
- 移転先へは `pg_dump`/`pg_restore` で丸ごと移行可能（アプリのバージョンを揃える）。

## 7. スケール時の注意
- レート制限はプロセス内メモリのため、複数インスタンスにする場合は共有ストア（Redis等）へ置き換えること。
- 添付が増えた場合は外部オブジェクトストレージへの移行を検討（NEXT_STEPS.txt）。
