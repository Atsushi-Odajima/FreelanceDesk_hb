-- 002: 参照整合性の強化（レビュー指摘対応）
-- 復元データ等で別アカウントのIDを指す行を作れないよう、残っていた参照列にも複合外部キーを追加

ALTER TABLE quote_versions
  ADD CONSTRAINT qv_project_fk FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE;

ALTER TABLE quote_versions
  ADD CONSTRAINT qv_based_on_fk FOREIGN KEY (account_id, based_on_version_id) REFERENCES quote_versions(account_id, id) ON DELETE SET NULL (based_on_version_id);

ALTER TABLE invoices
  ADD CONSTRAINT inv_current_version_fk FOREIGN KEY (account_id, current_version_id) REFERENCES invoice_versions(account_id, id) ON DELETE SET NULL (current_version_id);

ALTER TABLE business_profiles
  ADD CONSTRAINT bp_logo_fk FOREIGN KEY (account_id, logo_attachment_id) REFERENCES attachments(account_id, id) ON DELETE SET NULL (logo_attachment_id);

-- 顧客・品目CSV取込の再送防止
CREATE TABLE csv_imports (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  kind text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, request_id)
);
