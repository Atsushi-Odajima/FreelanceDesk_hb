# DATA_MODEL — 主要テーブルと関連

正は `server/src/migrations/001_init.sql`、`002_integrity.sql`、`003_client_portal.sql`（FreelanceDesk クライアントポータル）と（quote_versions.project_id / based_on_version_id、invoices.current_version_id、business_profiles.logo_attachment_id にも複合外部キーを追加）。すべての業務テーブルは `account_id` を持ち、`(account_id, id)` の複合外部キーで同一アカウント内の関連のみ許可。

```
accounts ─┬─ sessions / recovery_codes / password_reset_tokens
          ├─ business_profiles (1:1)
          ├─ counters（種別×年の連番）
          ├─ customers ──< projects ─┬─< project_status_history
          │                          ├─< project_events（タイムライン・履歴）
          ├─ items                   ├─< tasks
          │                          ├─< quotes ──< quote_versions (v1,v2,…)
          │                          │                    │ 1:1
          │                          ├─< orders ──────────┘ (quote_version_id UNIQUE)
          │                          ├─< deliveries（納品書スナップショット）
          │                          ├─< invoices ──< invoice_versions（訂正版）
          │                          └─< attachments ─ attachment_blobs
          ├─ payments ──< payment_allocations >── invoices
          └─ bank_imports ──< payments（source='bank_csv'）
```

## テーブル概要

| テーブル | 主な列 | 制約・備考 |
|---|---|---|
| accounts | email, password_hash(scrypt), is_demo, demo_expires_at | lower(email) 一意 |
| sessions | token_hash(PK, SHA-256), expires_at | 生トークンは保存しない |
| recovery_codes | code_hash, used_at | 1回限り |
| password_reset_tokens | token_hash, expires_at, used_at | 運営者発行・24時間 |
| signup_codes | code_hash, used_at, used_by | 購入者コード（任意） |
| business_profiles | 名称・担当・住所・電話・メール・振込先・登録番号(任意文字列)・ロゴ・基本色・標準支払条件/備考・税/端数の既定・期限日数 | |
| counters | (account, kind, year) → next_value | 行ロックで採番 |
| customers | code, name, contact_name, honorific, 住所, 電話, メール, payment_terms, payer_name(振込名義), internal_memo, archived_at | code は空以外で一意。取引ありは削除不可→アーカイブ |
| items | code, name, description, unit_price, unit, tax_rate(文字列), archived_at | 書類で使用済みは削除不可 |
| projects | number(P-YYYY-NNNN), customer_id, title, inquiry_date, planned_start, planned_due, status(12種), internal_memo, request_id | 状態変更は status_history に記録 |
| project_events | kind, title, ref_type/ref_id, note, occurred_at | 作成・見積・提出・受注・納品・請求・入金・メモ等 |
| tasks | title, due_date, done, done_at, memo, sort_order | |
| quotes | number(Q-YYYY-NNNN), project_id | |
| quote_versions | version, status(draft/final), 発行日, 有効期限, 件名, 納期表記, 支払条件, 備考, 税/端数設定, lines(jsonb), adjustments(jsonb), 合計各種, change_memo, snapshot, finalized_at, submitted_at/on, declined_at | 下書きは見積ごとに1つ。final は snapshot 必須 |
| orders | quote_version_id(一意), order_date, amount, due_date, payment_terms, snapshot, status | 案件ごとに active 1件 |
| deliveries | number(D-YYYY-NNNN), delivered_on, content, customer_comment, internal_memo, include_lines, snapshot | 納品書PDFはスナップショットから |
| invoices | number(INV-YYYY-NNNN, 初回確定時採番), order_id, status(draft/issued/cancelled), current_version_id, issue_date, due_date, total（有効版の値） | 入金の割当先（訂正しても同じID） |
| invoice_versions | revision, status(draft/final/superseded), 明細・金額・振込先, correction_reason, previous_total, snapshot, finalized_at | 下書きは請求ごとに1つ |
| attachments / attachment_blobs | purpose(project/delivery/logo), filename, mime(実体判定), size, sha256 / data(bytea) | |
| payments | received_on, amount(>0), method, payer_name, memo, source(manual/bank_csv), bank_import_id, row_key | row_key 一意（銀行明細の重複防止） |
| payment_allocations | payment_id, invoice_id, amount(>0) | 支払の未割当額を超えない（ロックして検査） |
| bank_imports | file_sha256(取込内容ハッシュ), filename, encoding, mapping, 件数 | 同一内容は一意制約で拒否 |
| csv_imports | request_id, kind, result | 顧客・品目CSV取込の再送防止（002） |

## JSON列の形
- `lines`: `[{ id, itemId|null, name, description, quantity:"1.5", unit, unitPrice:12000, taxRate:"10" }]`
- `adjustments`: `[{ id, kind:"discount"|"fee", label, amount, taxRate }]`
- `snapshot`（DocSnapshot）: `{ docType, number, version, issueDate, validUntil?, dueDate?, deliveredOn?, subject, deliveryNote?, paymentTerms, notes, bankInfo?, content?, customerComment?, issuer{…}, recipient{…}, lines[{name,description,quantity,unit,unitPrice,taxRate,amount}], adjustments, totals{subtotal,discountTotal,feeTotal,adjustmentTotal,taxTotal,total,taxBreakdown[]}, taxMode, lineRounding, taxRounding, correction?{reason,previousTotal}, finalizedAt }`
  - 受注の snapshot は見積スナップショット＋`orderDate/orderDueDate/orderPaymentTerms/quoteNumber/quoteVersion`

## 導出値（保存しない）
- 請求の入金状態：`summarizePayment(total, Σallocations, due_date, today)`
- 未割当入金：`payment.amount − Σallocations`
- タイムライン：`server/src/services/timeline.ts`

## FreelanceDesk クライアントポータル（003_client_portal.sql）
```
projects（+ portal_status draft/published/closed, portal_status_label, portal_guidance）
 ├─< portal_invites（token_hash UNIQUE, email, expires_at, revoked_at, revoke_reason ''/manual/reissued/locked/stopped, stopped_at, use_count, failed_attempts）
 ├─< portal_deliverables ──< portal_versions（version_number 連番, attachment_id UNIQUE → attachments(purpose='portal_version'), status in_review/changes_requested/approved/superseded）
 │                                ├─< portal_comments（parent_id, author_type operator/client, customer_id, pin_x/pin_y 0..1, pin_number（版内UNIQUE・振り直さない）, pin_type change/delete/add/move/keep/other, resolved_at, deleted_at）
 │                                ├─< portal_change_requests（body, pin_comment_ids jsonb = 依頼時点の未解決ピン）※UPDATE禁止トリガー
 │                                └─< portal_approvals（version_number, customer_id, attachment_id, file_sha256, idempotency_key（アカウント内UNIQUE）, revoked_at/revoke_reason）
 │                                      ※ 有効な承認は1版1件（部分UNIQUE）、本体列の UPDATE 禁止トリガー
 ├─< deliveries（+ portal_status private/published/withdrawn, portal_published_at, portal_message）──< portal_delivery_items（version_id, approval_id）
 └─< selection_sets（status draft/open/closed, show_names）──< selection_photos（position=番号, attachment_id UNIQUE → attachments(purpose='selection_photo')）
                                                       ├─< selection_picks（PK set_id+customer_id+photo_id）
                                                       └─< selection_responses（PK set_id+customer_id, note, picks_updated_at, submitted_at, submitted_count）
customers ──< portal_sessions（token_hash PK, customer_id, invite_id, expires_at, last_seen_at）
project_events（+ client_visible boolean）
attachments.purpose に 'portal_version' / 'selection_photo' を追加
```
- すべて `account_id` を持ち、`(account_id, …)` の複合外部キーで同一アカウント内のみ関連付け可能。案件削除・アカウント削除で連鎖削除。
- バックアップ（BACKUP_TABLES）に portal_deliverables / portal_versions / portal_comments / portal_change_requests / portal_approvals / portal_delivery_items / selection_sets / selection_photos / selection_picks / selection_responses を追加（形式バージョンは1のまま。旧バックアップも復元可）。**招待リンク・顧客セッションは含めない**（復元後に招待リンクを再発行）。
