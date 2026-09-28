-- Freelance Desk 初期スキーマ
-- 原則：全業務テーブルに account_id を持ち、(account_id, id) の複合外部キーで
-- 「別アカウントのデータへの関連付け」をDBレベルでも不可能にする。

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  is_demo boolean NOT NULL DEFAULT false,
  demo_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_email_uq ON accounts (lower(email));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions(account_id);

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_account_idx ON recovery_codes(account_id);

CREATE TABLE password_reset_tokens (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signup_codes (
  code_hash text PRIMARY KEY,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  used_by uuid REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE business_profiles (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  bank_info text NOT NULL DEFAULT '',
  registration_no text NOT NULL DEFAULT '',
  logo_attachment_id uuid,
  brand_color text NOT NULL DEFAULT '#1f5fbf',
  default_payment_terms text NOT NULL DEFAULT '',
  default_notes text NOT NULL DEFAULT '',
  default_tax_rate text NOT NULL DEFAULT '10',
  tax_mode text NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('exclusive','inclusive')),
  line_rounding text NOT NULL DEFAULT 'round' CHECK (line_rounding IN ('floor','round','ceil')),
  tax_rounding text NOT NULL DEFAULT 'floor' CHECK (tax_rounding IN ('floor','round','ceil')),
  quote_valid_days integer NOT NULL DEFAULT 30 CHECK (quote_valid_days BETWEEN 0 AND 3650),
  invoice_due_days integer NOT NULL DEFAULT 30 CHECK (invoice_due_days BETWEEN 0 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE counters (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  year integer NOT NULL,
  next_value integer NOT NULL,
  PRIMARY KEY (account_id, kind, year)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code text NOT NULL DEFAULT '',
  name text NOT NULL,
  contact_name text NOT NULL DEFAULT '',
  honorific text NOT NULL DEFAULT '御中',
  postal_code text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  payment_terms text NOT NULL DEFAULT '',
  payer_name text NOT NULL DEFAULT '', -- 振込名義（銀行明細との照合候補に使用）
  internal_memo text NOT NULL DEFAULT '',
  archived_at timestamptz,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, request_id)
);
CREATE UNIQUE INDEX customers_code_uq ON customers(account_id, code) WHERE code <> '';

CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code text NOT NULL DEFAULT '',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  unit_price bigint NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit text NOT NULL DEFAULT '',
  tax_rate text NOT NULL DEFAULT '10',
  archived_at timestamptz,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, request_id)
);
CREATE UNIQUE INDEX items_code_uq ON items(account_id, code) WHERE code <> '';

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number text NOT NULL,
  customer_id uuid NOT NULL,
  title text NOT NULL,
  inquiry_date date,
  planned_start date,
  planned_due date,
  status text NOT NULL DEFAULT 'inquiry' CHECK (status IN ('inquiry','quoting','quote_submitted','considering','ordered','in_progress','awaiting_delivery','delivered','invoiced','completed','lost','cancelled')),
  internal_memo text NOT NULL DEFAULT '',
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, number),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, customer_id) REFERENCES customers(account_id, id)
);
CREATE INDEX projects_customer_idx ON projects(account_id, customer_id);
CREATE INDEX projects_status_idx ON projects(account_id, status);

CREATE TABLE project_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE
);
CREATE INDEX psh_project_idx ON project_status_history(project_id, changed_at);

CREATE TABLE project_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  ref_type text,
  ref_id uuid,
  note text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE
);
CREATE INDEX pe_project_idx ON project_events(project_id, occurred_at);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  due_date date,
  done boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  memo text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE
);
CREATE INDEX tasks_project_idx ON tasks(project_id, sort_order);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  number text NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, number),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE
);

CREATE TABLE quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  issue_date date NOT NULL,
  valid_until date,
  subject text NOT NULL DEFAULT '',
  delivery_note text NOT NULL DEFAULT '',
  payment_terms text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  tax_mode text NOT NULL CHECK (tax_mode IN ('exclusive','inclusive')),
  line_rounding text NOT NULL CHECK (line_rounding IN ('floor','round','ceil')),
  tax_rounding text NOT NULL CHECK (tax_rounding IN ('floor','round','ceil')),
  lines jsonb NOT NULL DEFAULT '[]',
  adjustments jsonb NOT NULL DEFAULT '[]',
  subtotal bigint NOT NULL DEFAULT 0,
  adjustment_total bigint NOT NULL DEFAULT 0,
  tax_total bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  tax_breakdown jsonb NOT NULL DEFAULT '[]',
  change_memo text NOT NULL DEFAULT '',
  based_on_version_id uuid,
  snapshot jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  submitted_at timestamptz,
  submitted_on date,
  declined_at timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (quote_id, version),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, quote_id) REFERENCES quotes(account_id, id) ON DELETE CASCADE,
  CHECK (status = 'draft' OR snapshot IS NOT NULL)
);
CREATE INDEX qv_project_idx ON quote_versions(project_id);
-- 1つの見積につき編集中の下書きは1つまで
CREATE UNIQUE INDEX qv_one_draft ON quote_versions(quote_id) WHERE status = 'draft';

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  order_date date NOT NULL,
  amount bigint NOT NULL,
  due_date date,
  payment_terms text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (quote_version_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, quote_version_id) REFERENCES quote_versions(account_id, id) ON DELETE CASCADE
);
-- 1案件に有効な受注は1つ
CREATE UNIQUE INDEX orders_one_active ON orders(project_id) WHERE status = 'active';

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  order_id uuid,
  number text NOT NULL,
  delivered_on date NOT NULL,
  content text NOT NULL DEFAULT '',
  customer_comment text NOT NULL DEFAULT '',
  internal_memo text NOT NULL DEFAULT '',
  include_lines boolean NOT NULL DEFAULT true,
  snapshot jsonb NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, number),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  order_id uuid,
  number text, -- 初回確定時に採番（下書き破棄による欠番を防ぐ）
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
  current_version_id uuid,
  -- 現在有効な確定版の値（検索・集計用の非正規化。確定時のみ更新）
  issue_date date,
  due_date date,
  total bigint NOT NULL DEFAULT 0,
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT '',
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, number),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id)
);
CREATE INDEX invoices_project_idx ON invoices(project_id);
CREATE INDEX invoices_due_idx ON invoices(account_id, status, due_date);

CREATE TABLE invoice_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','superseded')),
  issue_date date NOT NULL,
  due_date date,
  subject text NOT NULL DEFAULT '',
  payment_terms text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  bank_info text NOT NULL DEFAULT '',
  tax_mode text NOT NULL CHECK (tax_mode IN ('exclusive','inclusive')),
  line_rounding text NOT NULL CHECK (line_rounding IN ('floor','round','ceil')),
  tax_rounding text NOT NULL CHECK (tax_rounding IN ('floor','round','ceil')),
  lines jsonb NOT NULL DEFAULT '[]',
  adjustments jsonb NOT NULL DEFAULT '[]',
  subtotal bigint NOT NULL DEFAULT 0,
  adjustment_total bigint NOT NULL DEFAULT 0,
  tax_total bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  tax_breakdown jsonb NOT NULL DEFAULT '[]',
  correction_reason text NOT NULL DEFAULT '',
  previous_total bigint,
  snapshot jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (invoice_id, revision),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, invoice_id) REFERENCES invoices(account_id, id) ON DELETE CASCADE,
  CHECK (status = 'draft' OR snapshot IS NOT NULL)
);
CREATE UNIQUE INDEX iv_one_draft ON invoice_versions(invoice_id) WHERE status = 'draft';

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id uuid,
  delivery_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('project','delivery','logo')),
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  note text NOT NULL DEFAULT '',
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, project_id) REFERENCES projects(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, delivery_id) REFERENCES deliveries(account_id, id) ON DELETE CASCADE
);
CREATE INDEX attachments_project_idx ON attachments(project_id);

CREATE TABLE attachment_blobs (
  attachment_id uuid PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  data bytea NOT NULL
);

CREATE TABLE bank_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_sha256 text NOT NULL,
  filename text NOT NULL DEFAULT '',
  encoding text NOT NULL,
  mapping jsonb NOT NULL,
  row_count integer NOT NULL,
  imported_count integer NOT NULL,
  skipped_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, file_sha256)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  received_on date NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT 'bank_transfer',
  payer_name text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','bank_csv')),
  bank_import_id uuid,
  row_key text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, row_key),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, bank_import_id) REFERENCES bank_imports(account_id, id) ON DELETE SET NULL (bank_import_id)
);
CREATE INDEX payments_received_idx ON payments(account_id, received_on);

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, payment_id) REFERENCES payments(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, invoice_id) REFERENCES invoices(account_id, id) ON DELETE CASCADE
);
CREATE INDEX pa_invoice_idx ON payment_allocations(invoice_id);
CREATE INDEX pa_payment_idx ON payment_allocations(payment_id);
