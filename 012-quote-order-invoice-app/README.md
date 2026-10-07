# Freelance Desk — 見積・案件・請求管理（商品#012）

問い合わせ→見積→見積改訂→受注→作業→納品→請求→入金確認を、同じ案件情報で管理する販売用Webアプリ（PC / iPhone / Android、PWA）。

**FreelanceDesk クライアントポータル**（2026-10-07 統合）：案件ごとのお客様専用ページ（招待リンク）で、制作物の確認・**FreelanceDesk 修正指示**（画像ピン・指示書）・修正依頼・承認、納品データの受け取り、**FreelanceDesk 写真セレクト**ができます（DECISIONS.md・購入者向け資料/使い方.txt 13章）。

| 資料 | 内容 |
|---|---|
| [PLAN.md](PLAN.md) | Phaseと受入条件 |
| [PROGRESS.md](PROGRESS.md) | 完了/未完了/テスト状況 |
| [DECISIONS.md](DECISIONS.md) | 技術・データ・安全性の決定 |
| [DATA_MODEL.md](DATA_MODEL.md) | テーブル・関連 |
| [CALCULATION_RULES.md](CALCULATION_RULES.md) | 金額・丸め・状態 |
| [SECURITY.md](SECURITY.md) | 認証/認可/アップロード |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 構成・開発手順 |
| [OPERATIONS.md](OPERATIONS.md) | デプロイ・バックアップ・復旧 |
| [OPERATING_COSTS.md](OPERATING_COSTS.md) | 継続費用 |
| [TEST_REPORT.md](TEST_REPORT.md) | テスト結果 |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | 販売前確認 |
| [NEXT_STEPS.txt](NEXT_STEPS.txt) | 再開時の作業 |
| [販売ページ案.md](販売ページ案.md) | 販売ページ下書き（未公開） |
| [購入者向け資料/](購入者向け資料/) | はじめに・使い方・スマホで使う・注意事項・CSVテンプレート・サンプル説明・ライセンス |

クイックスタート（開発者）：`npm ci && npm run db:local && npm run build && DATABASE_URL=postgres://postgres@127.0.0.1:54329/freelance_desk node dist/server/index.js` → http://localhost:3000
