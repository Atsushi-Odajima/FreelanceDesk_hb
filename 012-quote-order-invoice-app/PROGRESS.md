# PROGRESS — 完了／未完了／テスト（最終更新：2026-10-08）

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
| 12 | 必須単体・結合・E2Eテスト | ✅ 単体69・結合87・E2E11 すべて成功（TEST_REPORT.md、2026-10-08 ヒアリング統合後） |
| 13 | 購入者向け説明書 | ✅ 購入者向け資料/ |
| 14 | 継続運用費用の記録 | ✅ OPERATING_COSTS.md |
| 15 | 実機未確認事項を正直に記録 | ✅ 本表・TEST_REPORT.md・RELEASE_CHECKLIST.md |

**全体完成とは報告しない**：実機確認（条件1・2・11の一部）と本番デプロイは人間の作業として残っています。

## FreelanceDesk クライアントポータル統合（2026-10-07, candidate 7）
統合元：Client Portal（hanbai14/014-client-portal、読み取りのみ）。詳細は DECISIONS.md「FreelanceDesk クライアントポータルの統合」。
| 項目 | 状態 | 根拠 |
|---|---|---|
| 招待リンク（ハッシュ保存・期限・再発行・失効・アクセス停止・メール照合・5回ロック）と顧客セッション（fd_portal） | ✅ | integration/portal.test.ts |
| 認可（顧客は自分の公開案件のみ、他アカウント/他案件IDは全ルート404、認証領域の分離） | ✅ | integration/portal.test.ts |
| 運営者：案件詳細「クライアントポータル」タブ（公開設定・招待・制作物/版・納品公開・写真セレクト）、版の確認・修正指示書・セレクト管理画面 | ✅ | e2e/portal-client.spec.ts（一部） |
| お客様：ポータル（状況・ご案内・制作物・納品・セレクト・経過）、版の確認、FreelanceDesk 修正指示（ピン・種類・定型文）、修正依頼、承認、指示書（印刷/テキスト）、納品ダウンロード、FreelanceDesk 写真セレクト | ✅ | integration + e2e/portal-client.spec.ts |
| 承認（最新版のみ・冪等・stale 409）・修正依頼・納品公開の再検証・状態連携・履歴の顧客表示 | ✅ | integration/portal.test.ts |
| バックアップへの追加（招待は除外） | ✅ | integration/portal.test.ts |
| 画面の磨き込み・実機確認 | ⬜ | NEXT_STEPS.txt |
| 未統合（分割アップロード/S3、メール・マジックリンク、ZIP、資料依頼、監査チェーン、通知センター） | ⬜（意図的に対象外） | DECISIONS.md M8 |

## FreelanceDesk ヒアリング統合（2026-10-08, candidate 8）
統合元：IntakeMint（hanbai23/024-intakemint、読み取りのみ）。詳細は DECISIONS.md「FreelanceDesk ヒアリングの統合」。
| 項目 | 状態 | 根拠 |
|---|---|---|
| 充足判定・条件分岐・形式チェック（IntakeMint 共有コードの移植） | ✅ | unit/intake-engine.test.ts |
| テンプレート（サンプル9種から作成・編集・検証・アーカイブ、作成済みヒアリングへの非影響） | ✅ | integration/intake.test.ts |
| ヒアリング（問い合わせ段階から作成・公開・回答・提出・送信・承認/差し戻し・対象外・Ready・上書き・受付終了） | ✅ | integration/intake.test.ts, e2e/intake-client.spec.ts |
| FreelanceDesk 回答チェック（ルール判定）・追加質問 | ✅ | unit + integration |
| FreelanceDesk 案件開始パック（MD/TXT/版・提出ファイルZIP） | ✅ | integration + e2e |
| 認可（お客様・運営者の全新規ルートで他アカウント/他案件 404）・レート制限・バックアップ | ✅ | integration/intake.test.ts |
| 画面（案件詳細「ヒアリング」タブ、テンプレート一覧/編集、ポータルのヒアリング画面） | ✅（最小実装） | e2e/intake-client.spec.ts（テンプレート編集画面は自動テストなし） |
| 画面の磨き込み・実機確認 | ⬜ | NEXT_STEPS.txt |
| 未統合（リマインド・メール、外部AI、MCP、RBAC、監査ログ、全文検索、S3） | ⬜（意図的に対象外） | DECISIONS.md I9 |
