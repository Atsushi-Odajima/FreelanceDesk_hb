// 金額計算（見積・受注・請求で共通）。詳細は CALCULATION_RULES.md。
// - 金額は整数円（number、安全整数範囲内）
// - 数量・税率は文字列の10進数として受け取り decimal.js で計算（浮動小数誤差を避ける）
import Decimal from 'decimal.js';

export type RoundingMode = 'floor' | 'round' | 'ceil';
export type TaxMode = 'exclusive' | 'inclusive';

export const ROUNDING_LABELS: Record<RoundingMode, string> = {
  floor: '切り捨て',
  round: '四捨五入',
  ceil: '切り上げ',
};
export const TAX_MODE_LABELS: Record<TaxMode, string> = {
  exclusive: '税抜価格（外税）',
  inclusive: '税込価格（内税）',
};

export interface Line {
  id: string;
  itemId?: string | null;
  name: string;
  description?: string;
  quantity: string; // 10進数文字列。最大小数3桁
  unit?: string;
  unitPrice: number; // 整数円
  taxRate: string; // %。例 "10" "8" "0"
}

export interface Adjustment {
  id: string;
  kind: 'discount' | 'fee';
  label: string;
  amount: number; // 正の整数円（値引きも正で入力）
  taxRate: string;
}

export interface TaxBreakdown {
  rate: string;
  base: number; // 税率ごとの対象額（外税: 税抜 / 内税: 税込）
  tax: number;
}

export interface Totals {
  lineAmounts: Record<string, number>;
  subtotal: number; // 明細の合計
  discountTotal: number;
  feeTotal: number;
  adjustmentTotal: number; // 追加費用 − 値引き
  taxTotal: number;
  total: number; // 請求・見積の合計（外税: 税込合計 / 内税: 税込合計）
  taxBreakdown: TaxBreakdown[];
}

export interface CalcSettings {
  taxMode: TaxMode;
  lineRounding: RoundingMode;
  taxRounding: RoundingMode;
}

export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalcError';
  }
}

export const MAX_UNIT_PRICE = 1_000_000_000; // 10億円
export const MAX_QUANTITY = new Decimal('999999.999');
export const MAX_TOTAL = 999_999_999_999; // 約1兆円未満

const QTY_RE = /^\d{1,6}(\.\d{1,3})?$/;
const RATE_RE = /^\d{1,3}(\.\d{1,2})?$/;

export function roundDecimal(value: Decimal, mode: RoundingMode): number {
  let r: Decimal;
  if (mode === 'floor') r = value.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
  else if (mode === 'ceil') r = value.toDecimalPlaces(0, Decimal.ROUND_CEIL);
  else r = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const n = r.toNumber();
  if (!Number.isSafeInteger(n)) throw new CalcError('金額が大きすぎます');
  return n === 0 ? 0 : n; // -0 を避ける
}

export function normalizeQuantity(q: string): string {
  const s = String(q ?? '').trim();
  if (!QTY_RE.test(s)) throw new CalcError(`数量「${s}」は0以上・小数3桁までの数値で入力してください`);
  const d = new Decimal(s);
  if (d.lte(0)) throw new CalcError('数量は0より大きい値を入力してください');
  if (d.gt(MAX_QUANTITY)) throw new CalcError('数量が大きすぎます');
  return d.toString();
}

export function normalizeRate(r: string): string {
  const s = String(r ?? '').trim();
  if (!RATE_RE.test(s)) throw new CalcError(`税率「${s}」は0〜100の数値で入力してください`);
  const d = new Decimal(s);
  if (d.gt(100)) throw new CalcError('税率は100%以下で入力してください');
  return d.toString();
}

function assertYen(n: number, label: string, allowZero = true) {
  if (!Number.isSafeInteger(n)) throw new CalcError(`${label}は整数円で入力してください`);
  if (n < 0 || (!allowZero && n === 0)) throw new CalcError(`${label}は0以上で入力してください`);
  if (n > MAX_UNIT_PRICE) throw new CalcError(`${label}が大きすぎます`);
}

export function lineAmount(line: Pick<Line, 'quantity' | 'unitPrice'>, mode: RoundingMode): number {
  const q = new Decimal(normalizeQuantity(line.quantity));
  assertYen(line.unitPrice, '単価');
  return roundDecimal(q.mul(line.unitPrice), mode);
}

export function calculateTotals(lines: Line[], adjustments: Adjustment[], s: CalcSettings): Totals {
  const lineAmounts: Record<string, number> = {};
  const bases = new Map<string, number>();
  const add = (rate: string, v: number) => bases.set(rate, (bases.get(rate) ?? 0) + v);

  let subtotal = 0;
  for (const line of lines) {
    const rate = normalizeRate(line.taxRate);
    const amt = lineAmount(line, s.lineRounding);
    lineAmounts[line.id] = amt;
    subtotal += amt;
    add(rate, amt);
  }
  let discountTotal = 0;
  let feeTotal = 0;
  for (const adj of adjustments) {
    const rate = normalizeRate(adj.taxRate);
    assertYen(adj.amount, adj.kind === 'discount' ? '値引き額' : '追加費用');
    if (adj.kind === 'discount') {
      discountTotal += adj.amount;
      add(rate, -adj.amount);
    } else {
      feeTotal += adj.amount;
      add(rate, adj.amount);
    }
  }

  const taxBreakdown: TaxBreakdown[] = [];
  let taxTotal = 0;
  let baseTotal = 0;
  const rates = [...bases.keys()].sort((a, b) => new Decimal(b).cmp(new Decimal(a)));
  for (const rate of rates) {
    const base = bases.get(rate)!;
    if (base < 0) throw new CalcError(`税率${rate}%の値引きが対象金額を超えています`);
    const r = new Decimal(rate);
    const tax =
      s.taxMode === 'exclusive'
        ? roundDecimal(new Decimal(base).mul(r).div(100), s.taxRounding)
        : roundDecimal(new Decimal(base).mul(r).div(r.plus(100)), s.taxRounding);
    taxBreakdown.push({ rate, base, tax });
    taxTotal += tax;
    baseTotal += base;
  }
  const total = s.taxMode === 'exclusive' ? baseTotal + taxTotal : baseTotal;
  if (total > MAX_TOTAL) throw new CalcError('合計金額が大きすぎます');
  return {
    lineAmounts,
    subtotal,
    discountTotal,
    feeTotal,
    adjustmentTotal: feeTotal - discountTotal,
    taxTotal,
    total,
    taxBreakdown,
  };
}

// 入金状態の導出（チェックボックスではなく金額から決める）
export type PaymentState = 'unpaid' | 'partial' | 'paid' | 'overpaid';
export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  unpaid: '未入金',
  partial: '一部入金',
  paid: '入金済み',
  overpaid: '過入金',
};

export interface PaymentSummary {
  total: number;
  allocated: number;
  remaining: number; // 負の値は過入金額
  state: PaymentState;
  overdue: boolean;
  overpaidAmount: number;
}

export function summarizePayment(total: number, allocated: number, dueDate: string | null, today: string): PaymentSummary {
  const remaining = total - allocated;
  let state: PaymentState;
  if (allocated > total) state = 'overpaid';
  else if (allocated === total) state = 'paid';
  else if (allocated === 0) state = 'unpaid';
  else state = 'partial';
  const overdue = (state === 'unpaid' || state === 'partial') && !!dueDate && dueDate < today;
  return { total, allocated, remaining, state, overdue, overpaidAmount: remaining < 0 ? -remaining : 0 };
}

export function formatYen(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}¥${Math.abs(n).toLocaleString('ja-JP')}`;
}

export function formatQuantity(q: string): string {
  try {
    const d = new Decimal(q);
    const [i, f] = d.toFixed().split('.');
    const grouped = Number(i).toLocaleString('ja-JP');
    return f ? `${grouped}.${f}` : grouped;
  } catch {
    return q;
  }
}
