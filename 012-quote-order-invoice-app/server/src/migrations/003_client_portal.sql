-- 003: FreelanceDesk クライアントポータル（Client Portal からの統合）
-- 顧客（customers）が招待リンクから案件ごとのポータルを閲覧し、制作物の確認・ピンコメント（FreelanceDesk 修正指示）・
-- 修正依頼・承認・公開された納品のダウンロード・FreelanceDesk 写真セレクトを行う。
-- 原則は既存と同じ：全テーブルに account_id を持ち、(account_id, id) の複合外部キーで別アカウントへの関連付けを不可能にする。

-- ---- 案件のポータル設定 ----
ALTER TABLE projects
  ADD COLUMN portal_status text NOT NULL DEFAULT 'draft' CHECK (portal_status IN ('draft','published','closed')),
  ADD COLUMN portal_status_label text NOT NULL DEFAULT '',
  ADD COLUMN portal_guidance text NOT NULL DEFAULT '';

-- 履歴のうち顧客にも表示してよいもの（承認・納品公開など）
ALTER TABLE project_events ADD COLUMN client_visible boolean NOT NULL DEFAULT false;

-- 添付の用途：制作物の版（portal_version）と写真セレクトの写真（selection_photo）を追加（実体は従来どおり attachment_blobs）
ALTER TABLE attachments DROP CONSTRAINT attachments_purpose_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_purpose_check CHECK (purpose IN ('project','delivery','logo','portal_version','selection_photo'));

-- ---- 招待リンクと顧客セッション ----
-- トークンは平文を保存しない（SHA-256 のみ）。email は発行時点の顧客メール（小文字）。
CREATE TABLE portal_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text NOT NULL DEFAULT '' CHECK (revoke_reason IN ('','manual','reissued','locked','stopped')),
  -- アクセス停止（この招待で得た案件への閲覧権も止める）
  stopped_at timestamptz,
  use_count integer NOT NULL DEFAULT 0,
  failed_attempts integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id) ON DELETE CASCADE
);
CREATE INDEX portal_invites_project_idx ON portal_invites(account_id, project_id);

CREATE TABLE portal_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  invite_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id) ON DELETE CASCADE
);
CREATE INDEX portal_sessions_customer_idx ON portal_sessions(account_id, customer_id);

-- ---- 制作物・版・コメント・修正依頼・承認 ----
CREATE TABLE portal_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE
);
CREATE INDEX portal_deliverables_project_idx ON portal_deliverables(account_id, project_id);

-- 1版1ファイル。提出後の差替え不可（新しい版を提出する）。旧版は superseded として残す
CREATE TABLE portal_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  deliverable_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number >= 1),
  attachment_id uuid NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review','changes_requested','approved','superseded')),
  request_id text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (deliverable_id, version_number),
  UNIQUE (account_id, request_id),
  UNIQUE (attachment_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, deliverable_id) REFERENCES portal_deliverables(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, attachment_id) REFERENCES attachments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX portal_versions_project_idx ON portal_versions(account_id, project_id);

-- コメント（ピン付き＝FreelanceDesk 修正指示）。ピン番号は作成時に確定し、振り直さない
CREATE TABLE portal_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  parent_id uuid,
  author_type text NOT NULL CHECK (author_type IN ('operator','client')),
  customer_id uuid,
  author_name text NOT NULL,
  body text NOT NULL,
  pin_x double precision CHECK (pin_x IS NULL OR (pin_x >= 0 AND pin_x <= 1)),
  pin_y double precision CHECK (pin_y IS NULL OR (pin_y >= 0 AND pin_y <= 1)),
  pin_number integer,
  pin_type text CHECK (pin_type IS NULL OR pin_type IN ('change','delete','add','move','keep','other')),
  resolved_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, version_id) REFERENCES portal_versions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, parent_id) REFERENCES portal_comments(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id) ON DELETE CASCADE,
  CHECK ((pin_number IS NULL) = (pin_x IS NULL) AND (pin_x IS NULL) = (pin_y IS NULL))
);
CREATE INDEX portal_comments_version_idx ON portal_comments(version_id, created_at);
CREATE UNIQUE INDEX portal_comments_pin_uq ON portal_comments(version_id, pin_number) WHERE pin_number IS NOT NULL;

-- 修正依頼（固定記録。依頼時点の未解決ピンのIDを保持）
CREATE TABLE portal_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  client_name text NOT NULL,
  body text NOT NULL,
  pin_comment_ids jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, version_id) REFERENCES portal_versions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id) ON DELETE CASCADE
);
CREATE INDEX portal_change_requests_version_idx ON portal_change_requests(version_id);

-- 承認（電子契約ではない確認記録）。有効な承認は1版1件、本体は変更不可（取消情報の追記のみ）
CREATE TABLE portal_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version_number integer NOT NULL,
  customer_id uuid NOT NULL,
  client_name text NOT NULL,
  attachment_id uuid NOT NULL,
  file_sha256 text NOT NULL,
  comment text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  UNIQUE (account_id, id),
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, version_id) REFERENCES portal_versions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, attachment_id) REFERENCES attachments(account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX portal_approvals_active_uq ON portal_approvals(version_id) WHERE revoked_at IS NULL;
CREATE INDEX portal_approvals_project_idx ON portal_approvals(account_id, project_id);

CREATE FUNCTION portal_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END $$;

CREATE TRIGGER portal_change_requests_immutable BEFORE UPDATE ON portal_change_requests
  FOR EACH ROW EXECUTE FUNCTION portal_reject_update('change request is immutable');

CREATE TRIGGER portal_approvals_immutable BEFORE UPDATE OF account_id, project_id, version_id, version_number, customer_id, attachment_id, file_sha256, approved_at, idempotency_key ON portal_approvals
  FOR EACH ROW EXECUTE FUNCTION portal_reject_update('approval record is immutable');

CREATE TRIGGER portal_versions_file_immutable BEFORE UPDATE OF attachment_id, version_number, deliverable_id, project_id ON portal_versions
  FOR EACH ROW EXECUTE FUNCTION portal_reject_update('version file is immutable; submit a new version');

-- ---- 納品の公開（既存の納品記録 deliveries をポータルに公開） ----
ALTER TABLE deliveries
  ADD COLUMN portal_status text NOT NULL DEFAULT 'private' CHECK (portal_status IN ('private','published','withdrawn')),
  ADD COLUMN portal_published_at timestamptz,
  ADD COLUMN portal_message text NOT NULL DEFAULT '';

-- 納品に含める承認済みの版
CREATE TABLE portal_delivery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  version_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  UNIQUE (account_id, id),
  UNIQUE (delivery_id, version_id),
  FOREIGN KEY (account_id, delivery_id) REFERENCES deliveries(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, version_id) REFERENCES portal_versions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, approval_id) REFERENCES portal_approvals(account_id, id) ON DELETE CASCADE
);

-- ---- FreelanceDesk 写真セレクト ----
-- draft（準備中・顧客に非表示）→ open（選択受付中）→ closed（受付終了）
CREATE TABLE selection_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  message text NOT NULL DEFAULT '',
  show_names boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE
);
CREATE INDEX selection_sets_project_idx ON selection_sets(account_id, project_id);

-- 番号 = position（1始まり）。公開後は並べ替え・削除不可（番号が変わらない）
CREATE TABLE selection_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  set_id uuid NOT NULL,
  attachment_id uuid NOT NULL UNIQUE,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (set_id, position),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, set_id) REFERENCES selection_sets(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, attachment_id) REFERENCES attachments(account_id, id) ON DELETE CASCADE
);

CREATE TABLE selection_picks (
  account_id uuid NOT NULL,
  set_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  photo_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_id, customer_id, photo_id),
  FOREIGN KEY (account_id, set_id) REFERENCES selection_sets(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, photo_id) REFERENCES selection_photos(account_id, id) ON DELETE CASCADE
);

CREATE TABLE selection_responses (
  account_id uuid NOT NULL,
  set_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  client_name text NOT NULL,
  note text NOT NULL DEFAULT '',
  picks_updated_at timestamptz,
  submitted_at timestamptz,
  submitted_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (set_id, customer_id),
  FOREIGN KEY (account_id, set_id) REFERENCES selection_sets(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id) ON DELETE CASCADE
);
