// 帳票スナップショット：確定時点の宛名・発行者・明細・金額・条件を固定保存する。
// PDFはこの形の「ホワイトリスト項目」だけから生成する（内部メモ・内部ID・開発情報は含めない）。
import type { Adjustment, Line, RoundingMode, TaxMode, Totals } from '../../../shared/calc';
import { calculateTotals } from '../../../shared/calc';
import type { Queryable } from '../db';
import { one } from '../db';
import { notFound } from './errors';

export interface IssuerSnapshot {
  name: string;
  contactName: string;
  postalCode: string;
  address: string;
  phone: string;
  email: string;
  registrationNo: string;
  brandColor: string;
  logoAttachmentId: string | null;
}

export interface RecipientSnapshot {
  name: string;
  honorific: string;
  contactName: string;
  postalCode: string;
  address: string;
}

export interface SnapshotLine {
  name: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: number;
  taxRate: string;
  amount: number;
}

export interface DocSnapshot {
  docType: 'quote' | 'invoice' | 'delivery';
  number: string;
  version: number; // 見積: 版 / 請求: 訂正版番号 / 納品: 1
  issueDate: string;
  validUntil?: string | null;
  dueDate?: string | null;
  deliveredOn?: string | null;
  subject: string;
  deliveryNote?: string;
  paymentTerms: string;
  notes: string;
  bankInfo?: string;
  customerComment?: string;
  content?: string;
  issuer: IssuerSnapshot;
  recipient: RecipientSnapshot;
  lines: SnapshotLine[];
  adjustments: Array<Pick<Adjustment, 'kind' | 'label' | 'amount' | 'taxRate'>>;
  totals: Omit<Totals, 'lineAmounts'> | null;
  taxMode: TaxMode;
  lineRounding: RoundingMode;
  taxRounding: RoundingMode;
  correction?: { reason: string; previousTotal: number | null } | null;
  finalizedAt?: string | null;
}

export interface BusinessRow {
  account_id: string;
  name: string;
  contact_name: string;
  postal_code: string;
  address: string;
  phone: string;
  email: string;
  bank_info: string;
  registration_no: string;
  logo_attachment_id: string | null;
  brand_color: string;
  default_payment_terms: string;
  default_notes: string;
  default_tax_rate: string;
  tax_mode: TaxMode;
  line_rounding: RoundingMode;
  tax_rounding: RoundingMode;
  quote_valid_days: number;
  invoice_due_days: number;
}

export async function loadBusiness(q: Queryable, accountId: string): Promise<BusinessRow> {
  const b = await one<BusinessRow>(q, 'SELECT * FROM business_profiles WHERE account_id = $1', [accountId]);
  if (!b) throw notFound('事業者情報');
  return b;
}

export async function loadCustomerForProject(q: Queryable, accountId: string, projectId: string) {
  const c = await one(
    q,
    `SELECT c.* FROM projects p JOIN customers c ON c.account_id = p.account_id AND c.id = p.customer_id
     WHERE p.account_id = $1 AND p.id = $2`,
    [accountId, projectId],
  );
  if (!c) throw notFound('顧客');
  return c;
}

export function issuerFrom(b: BusinessRow): IssuerSnapshot {
  return {
    name: b.name,
    contactName: b.contact_name,
    postalCode: b.postal_code,
    address: b.address,
    phone: b.phone,
    email: b.email,
    registrationNo: b.registration_no,
    brandColor: b.brand_color,
    logoAttachmentId: b.logo_attachment_id,
  };
}

export function recipientFrom(c: any): RecipientSnapshot {
  return {
    name: c.name,
    honorific: c.honorific,
    contactName: c.contact_name,
    postalCode: c.postal_code,
    address: c.address,
  };
}

export function snapshotLines(lines: Line[], totals: Totals): SnapshotLine[] {
  return lines.map((l) => ({
    name: l.name,
    description: l.description ?? '',
    quantity: l.quantity,
    unit: l.unit ?? '',
    unitPrice: l.unitPrice,
    taxRate: l.taxRate,
    amount: totals.lineAmounts[l.id] ?? 0,
  }));
}

/** 下書き/確定前の書類行から、確定時と同じ形のスナップショットを組み立てる */
export function buildDocSnapshot(
  docType: 'quote' | 'invoice',
  row: any,
  number: string,
  business: BusinessRow,
  customer: any,
): DocSnapshot {
  const lines: Line[] = row.lines ?? [];
  const adjustments: Adjustment[] = row.adjustments ?? [];
  const totals = calculateTotals(lines, adjustments, { taxMode: row.tax_mode, lineRounding: row.line_rounding, taxRounding: row.tax_rounding });
  const { lineAmounts: _omit, ...totalsOut } = totals;
  const snap: DocSnapshot = {
    docType,
    number,
    version: docType === 'quote' ? row.version : row.revision,
    issueDate: row.issue_date,
    subject: row.subject,
    paymentTerms: row.payment_terms,
    notes: row.notes,
    issuer: issuerFrom(business),
    recipient: recipientFrom(customer),
    lines: snapshotLines(lines, totals),
    adjustments: adjustments.map((a) => ({ kind: a.kind, label: a.label, amount: a.amount, taxRate: a.taxRate })),
    totals: totalsOut,
    taxMode: row.tax_mode,
    lineRounding: row.line_rounding,
    taxRounding: row.tax_rounding,
  };
  if (docType === 'quote') {
    snap.validUntil = row.valid_until;
    snap.deliveryNote = row.delivery_note;
  } else {
    snap.dueDate = row.due_date;
    snap.bankInfo = row.bank_info;
    snap.correction = row.revision > 1 ? { reason: row.correction_reason, previousTotal: row.previous_total } : null;
  }
  return snap;
}
