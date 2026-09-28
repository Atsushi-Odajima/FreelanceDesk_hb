// 入力スキーマ（サーバー側で全入力を検証する）
import { z } from 'zod';
import { isValidDate } from '../../shared/dates';
import { PROJECT_STATUSES, PAYMENT_METHODS } from '../../shared/status';

const t = (max: number) => z.string().max(max, `${max}文字以内で入力してください`);
export const text = (max = 2000) => t(max).transform((s) => s.replace(/\u0000/g, ''));
export const requiredText = (max = 200) =>
  z
    .string()
    .transform((s) => s.replace(/\u0000/g, '').trim())
    .pipe(z.string().min(1, '必須項目です').max(max, `${max}文字以内で入力してください`));
export const dateStr = z.string().refine(isValidDate, '日付の形式が正しくありません（YYYY-MM-DD）');
export const optDate = z
  .union([dateStr, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
export const requestId = z.string().min(8).max(100).regex(/^[A-Za-z0-9_\-:.]+$/, 'requestIdの形式が不正です');
export const yen = z.number().int('整数円で入力してください').min(0, '0以上で入力してください').max(1_000_000_000, '金額が大きすぎます');
export const rateStr = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, '税率は数値で入力してください');
export const rounding = z.enum(['floor', 'round', 'ceil']);
export const taxMode = z.enum(['exclusive', 'inclusive']);
export const uuid = z.string().uuid();

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email('メールアドレスの形式が正しくありません');
export const password = z.string().min(10, 'パスワードは10文字以上にしてください').max(200);

export const signupSchema = z.object({
  email,
  password,
  signupCode: z.string().max(100).optional(),
  businessName: text(200).optional(),
});
export const loginSchema = z.object({ email, password: z.string().min(1).max(200) });
export const recoverSchema = z.object({ email, recoveryCode: z.string().min(4).max(100), newPassword: password });
export const resetTokenSchema = z.object({ token: z.string().min(10).max(200), newPassword: password });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });
export const passwordConfirmSchema = z.object({ password: z.string().min(1).max(200) });
export const deleteAccountSchema = z.object({ password: z.string().min(1).max(200), confirm: z.literal('削除します') });

export const businessSchema = z.object({
  name: text(200),
  contactName: text(100),
  postalCode: text(20),
  address: text(300),
  phone: text(50),
  email: text(254),
  bankInfo: text(500),
  registrationNo: text(100),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, '色は #RRGGBB 形式で入力してください'),
  defaultPaymentTerms: text(300),
  defaultNotes: text(2000),
  defaultTaxRate: rateStr,
  taxMode,
  lineRounding: rounding,
  taxRounding: rounding,
  quoteValidDays: z.number().int().min(0).max(3650),
  invoiceDueDays: z.number().int().min(0).max(3650),
});

export const customerSchema = z.object({
  requestId: requestId.optional(),
  code: text(50).transform((s) => s.trim()),
  name: requiredText(200),
  contactName: text(100),
  honorific: z.enum(['御中', '様', '殿', '']),
  postalCode: text(20),
  address: text(300),
  phone: text(50),
  email: text(254),
  paymentTerms: text(300),
  payerName: text(200).optional().default(''),
  internalMemo: text(5000),
});

export const itemSchema = z.object({
  requestId: requestId.optional(),
  code: text(50).transform((s) => s.trim()),
  name: requiredText(200),
  description: text(1000),
  unitPrice: yen,
  unit: text(20),
  taxRate: rateStr,
});

export const projectSchema = z.object({
  requestId: requestId.optional(),
  customerId: uuid,
  title: requiredText(200),
  inquiryDate: optDate,
  plannedStart: optDate,
  plannedDue: optDate,
  internalMemo: text(10000),
});

export const projectStatusSchema = z.object({
  status: z.enum(PROJECT_STATUSES),
  note: text(1000).optional().default(''),
});

export const projectNoteSchema = z.object({ note: requiredText(2000) });

export const taskSchema = z.object({
  requestId: requestId.optional(),
  title: requiredText(200),
  dueDate: optDate,
  memo: text(2000).optional().default(''),
});
export const taskUpdateSchema = z.object({
  title: requiredText(200).optional(),
  dueDate: z.union([dateStr, z.literal(''), z.null()]).optional(),
  memo: text(2000).optional(),
  done: z.boolean().optional(),
});
export const taskOrderSchema = z.object({ ids: z.array(uuid).max(500) });

export const lineSchema = z.object({
  id: z.string().min(1).max(64),
  itemId: uuid.nullable().optional(),
  name: requiredText(200),
  description: text(1000).optional().default(''),
  quantity: z.string().regex(/^\d{1,6}(\.\d{1,3})?$/, '数量は小数3桁までの数値で入力してください'),
  unit: text(20).optional().default(''),
  unitPrice: yen,
  taxRate: rateStr,
});
export const adjustmentSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['discount', 'fee']),
  label: requiredText(100),
  amount: yen,
  taxRate: rateStr,
});

const docBase = {
  subject: text(200),
  paymentTerms: text(300),
  notes: text(3000),
  taxMode,
  lineRounding: rounding,
  taxRounding: rounding,
  lines: z.array(lineSchema).max(300, '明細は300行までです'),
  adjustments: z.array(adjustmentSchema).max(20),
};

export const quoteDraftSchema = z.object({
  ...docBase,
  issueDate: dateStr,
  validUntil: optDate,
  deliveryNote: text(200),
  changeMemo: text(1000),
});
export const createQuoteSchema = z.object({ requestId });
export const submitQuoteSchema = z.object({ submittedOn: dateStr });
export const declineSchema = z.object({ reason: text(1000).optional().default('') });

export const orderSchema = z.object({
  quoteVersionId: uuid,
  orderDate: dateStr,
  dueDate: optDate,
  paymentTerms: text(300).optional(),
  memo: text(2000).optional().default(''),
});

export const deliverySchema = z.object({
  requestId,
  deliveredOn: dateStr,
  content: text(3000),
  customerComment: text(3000),
  internalMemo: text(3000),
  includeLines: z.boolean().default(true),
});

export const createInvoiceSchema = z.object({ requestId, orderId: uuid.optional().nullable() });
export const invoiceDraftSchema = z.object({
  ...docBase,
  issueDate: dateStr,
  dueDate: optDate,
  bankInfo: text(500),
  correctionReason: text(1000).optional().default(''),
});
export const correctionSchema = z.object({ requestId, reason: requiredText(1000) });
export const cancelInvoiceSchema = z.object({ reason: requiredText(1000) });

export const paymentSchema = z.object({
  requestId,
  receivedOn: dateStr,
  amount: z.number().int().min(1, '1円以上で入力してください').max(1_000_000_000_000),
  method: z.enum(PAYMENT_METHODS),
  payerName: text(200).optional().default(''),
  memo: text(1000).optional().default(''),
});
export const invoicePaymentSchema = paymentSchema;
export const allocationSchema = z.object({
  requestId,
  invoiceId: uuid,
  amount: z.number().int().min(1).max(1_000_000_000_000),
});

export const bankImportSchema = z.object({
  filename: text(255),
  encoding: z.enum(['utf-8', 'shift_jis']),
  mapping: z.object({
    date: z.number().int().min(0).max(200),
    name: z.number().int().min(0).max(200),
    amount: z.number().int().min(0).max(200),
    hasHeader: z.boolean(),
  }),
  rowCount: z.number().int().min(0).max(100000),
  rows: z
    .array(
      z.object({
        date: dateStr,
        name: text(200),
        amount: z.number().int().min(1).max(1_000_000_000_000),
      }),
    )
    .max(10000),
});
