-- 004: FreelanceDesk ヒアリング（IntakeMint からの統合）／FreelanceDesk 案件開始パック
-- 案件（projects）ごとに「ヒアリング（intakes）」を作り、必要な情報・ファイルをお客様からクライアントポータル経由で回収する。
-- 充足判定（不足・要確認）と Ready 判定は決定的なルール（shared/intake/completeness.ts）で行い、案件開始パック（Markdown/TXT/ZIP）を生成する。
-- 原則は既存と同じ：全テーブルに account_id を持ち、(account_id, id) の複合外部キーで別アカウントへの関連付けを不可能にする。

-- 添付の用途：ヒアリングの提出ファイル（intake_file）を追加（実体は従来どおり attachment_blobs、10MB/ファイル）
ALTER TABLE attachments DROP CONSTRAINT attachments_purpose_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_purpose_check
  CHECK (purpose IN ('project','delivery','logo','portal_version','selection_photo','intake_file'));

-- ---- テンプレート（必要な質問・ファイルの定義） ----
-- definition は IntakeMint の TemplateDefinition（sections / questions / rules / requiredItems / completionRules / packageTemplate …）
CREATE TABLE intake_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sample_key text,
  definition jsonb NOT NULL,
  archived_at timestamptz,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, request_id)
);
CREATE INDEX intake_templates_account_idx ON intake_templates(account_id, updated_at DESC);

-- ---- ヒアリング（案件ごと。作成時にテンプレートの定義をコピーし、以後のテンプレート変更の影響を受けない） ----
CREATE TABLE intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  template_id uuid,
  title text NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','in_progress','needs_client','needs_internal_review','ready','started','cancelled')),
  due_date date,
  -- お客様（クライアントポータル）に公開した日時。NULL の間はお客様に見えない
  shared_at timestamptz,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_summary text NOT NULL DEFAULT '',
  internal_signoff_at timestamptz,
  signoff_note text,
  ready_at timestamptz,
  ready_override jsonb,
  client_submitted_at timestamptz,
  started_at timestamptz,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, template_id) REFERENCES intake_templates(account_id, id)
);
CREATE INDEX intakes_project_idx ON intakes(account_id, project_id);
CREATE INDEX intakes_status_idx ON intakes(account_id, status, updated_at DESC);

-- 回答（非表示になった質問の回答も保持し、判定・パックからは除外する＝retain_excluded）
CREATE TABLE intake_responses (
  account_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  question_id text NOT NULL,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('client','operator')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intake_id, question_id),
  FOREIGN KEY (account_id, intake_id) REFERENCES intakes(account_id, id) ON DELETE CASCADE
);

-- 必要項目ごとのレビュー状態
CREATE TABLE intake_item_states (
  account_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  item_id text NOT NULL,
  review_status text NOT NULL CHECK (review_status IN ('none','accepted','rejected','needs_review','not_applicable')),
  note text,
  reviewed_at timestamptz,
  PRIMARY KEY (intake_id, item_id),
  FOREIGN KEY (account_id, intake_id) REFERENCES intakes(account_id, id) ON DELETE CASCADE
);

-- 提出ファイル（実体は attachments(purpose='intake_file')。1ファイル1行）
CREATE TABLE intake_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  item_id text NOT NULL,
  attachment_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','accepted','rejected')),
  review_note text,
  uploaded_by_kind text NOT NULL CHECK (uploaded_by_kind IN ('client','operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, intake_id) REFERENCES intakes(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, attachment_id) REFERENCES attachments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX intake_files_intake_idx ON intake_files(account_id, intake_id, item_id);

-- 回答チェック（ルール判定）の確認候補。人間が「お客様に質問する／社内で解決／却下」を決める
CREATE TABLE intake_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('follow_up','ambiguous','contradiction','missing')),
  question_id text,
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','sent_to_client','dismissed','resolved')),
  provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (intake_id, fingerprint),
  FOREIGN KEY (account_id, intake_id) REFERENCES intakes(account_id, id) ON DELETE CASCADE
);

-- 追加質問（運営者が承認してお客様に表示するもの）
CREATE TABLE intake_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  candidate_id uuid,
  question_id text,
  text text NOT NULL,
  options jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','resolved','cancelled')),
  answer jsonb,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, intake_id) REFERENCES intakes(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, candidate_id) REFERENCES intake_candidates(account_id, id) ON DELETE CASCADE
);
CREATE INDEX intake_followups_intake_idx ON intake_followups(account_id, intake_id);

-- FreelanceDesk 案件開始パック（生成ごとに v1, v2 …）
CREATE TABLE intake_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  profile text NOT NULL,
  content jsonb NOT NULL,
  markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (intake_id, version),
  FOREIGN KEY (account_id, intake_id) REFERENCES intakes(account_id, id) ON DELETE CASCADE
);
