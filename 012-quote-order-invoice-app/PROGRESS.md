# PROGRESS — 完了／未完了／テスト（最終更新：2026-09-28）

凡例：✅完了（自動テストで確認）／🟡実装済み・実機未確認／⬜未実施（人間の作業が必要）

## Phase別
| Phase | 内容 | 状態 | 根拠 |
|---|---|---|---|
| 0 | 技術選定・料金/ライセンス確認・最小PWA | ✅ | DECISIONS.md, OPERATING_COSTS.md, THIRD_PARTY_NOTICES.txt, e2e PWAテスト |
| 1 | 認証・事業者・顧客・品目・DB・認可 | ✅ | tests/integration/security.test.ts, extra.test.ts, docs-data.test.ts |
| 2 | 案件・タイムライン・タスク・添付 | ✅ | flow.test.ts, unit/misc.test.ts, e2e シナリオ1・添付 |
| 3 | 見積版管理・計算・PDF・提出 | ✅ | unit/calc.test.ts, flow.test.ts, docs-data.test.ts（PDF文字・グリフ検査） |
| 4 | 受注・納品・納品書 | ✅ | flow.test.ts, idempotency.test.ts, docs-data.test.ts |
| 5 | 請求・訂正・PDF | ✅ | invoices.test.ts, docs-data.test.ts |
| 6 | 入金・銀行CSV・候補/割当・重複防止 | ✅ | flow.test.ts（シナリオ4）, idempotency.test.ts, unit/csv.test.ts, e2e シナリオ4 |
| 7 | ダッシュボード・検索・CSV・バックアップ | ✅ | flow.test.ts, docs-data.test.ts, 別環境復元チェック |
| 8 | PWA/スマホ・E2E・セキュリティ・説明書・デプロイ手順 | 🟡 | 自動E2E・説明書・Dockerfile/render.yaml・独立コードレビュー10件の修正 完了。**実機確認・Dockerイメージのビルド（この環境ではDocker不可）・本番デプロイは未実施（⬜）** |

## 完成条件
| # | 条件 | 状態 |
|---|---|---|
| 1 | PC/iPhone/Androidで主要操作可能 | 🟡 PC Chromium と スマホ幅エミュレーション（320〜430px, タッチ）で確認。iPhone/Android 実機は未確認 |
| 2 | PWAホーム画面起動可能な構成 | 🟡 manifest・アイコン・SW登録・オフライン動作を自動テストで確認。実機でのホーム画面追加は未確認 |
| 3 | 顧客→案件→見積→受注→作業→納品→請求→入金が一貫 | ✅ E2Eシナリオ1 |
| 4 | 見積版履歴と確定スナップショット | ✅ |
| 5 | 見積/納品/請求PDF | ✅（文字化け・欠字の自動検査あり。他ビューア実機は未確認） |
| 6 | 一部入金/完済/期限超過 | ✅ |
| 7 | 銀行CSV候補照合 | ✅（Shift_JIS/UTF-8 BOM、引用符・カンマ・改行、重複取込） |
| 8 | 二重登録防止 | ✅（案件・見積・受注・納品・請求・確定・入金・割当・CSV） |
| 9 | ユーザー間データ分離 | ✅（ID書換えテスト） |
| 10 | CSV/バックアップ/復元 | ✅（空環境への復元で件数・金額一致） |
| 11 | スマホ写真添付/PDF保存共有 | 🟡 ファイル選択・HEIC受入・PDF保存をエミュレーションで確認。カメラ撮影・共有シート・iOSでの保存は実機未確認 |
| 12 | 必須単体・結合・E2Eテスト | ✅ 単体41・結合57・E2E9 すべて成功（TEST_REPORT.md） |
| 13 | 購入者向け説明書 | ✅ 購入者向け資料/ |
| 14 | 継続運用費用の記録 | ✅ OPERATING_COSTS.md |
| 15 | 実機未確認事項を正直に記録 | ✅ 本表・TEST_REPORT.md・RELEASE_CHECKLIST.md |

**全体完成とは報告しない**：実機確認（条件1・2・11の一部）と本番デプロイは人間の作業として残っています。
