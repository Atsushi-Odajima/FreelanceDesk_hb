import { describe, expect, it } from 'vitest';
import { calculateTotals, CalcError, lineAmount, summarizePayment, type Line, type Adjustment } from '../../shared/calc';

const L = (id: string, quantity: string, unitPrice: number, taxRate = '10'): Line => ({ id, name: id, quantity, unitPrice, taxRate });
const ex = { taxMode: 'exclusive' as const, lineRounding: 'round' as const, taxRounding: 'floor' as const };

describe('明細金額（小数数量・端数処理）', () => {
  it('整数数量', () => {
    expect(lineAmount({ quantity: '3', unitPrice: 1000 }, 'round')).toBe(3000);
  });
  it('小数数量は浮動小数誤差なく計算する（0.1×3 等）', () => {
    expect(lineAmount({ quantity: '0.1', unitPrice: 3 }, 'round')).toBe(0);
    expect(lineAmount({ quantity: '1.005', unitPrice: 1000 }, 'round')).toBe(1005);
    expect(lineAmount({ quantity: '2.5', unitPrice: 5000 }, 'round')).toBe(12500);
    expect(lineAmount({ quantity: '0.333', unitPrice: 100 }, 'round')).toBe(33);
  });
  it('端数処理モード：切り捨て・四捨五入・切り上げ', () => {
    // 1.5 × 333 = 499.5
    expect(lineAmount({ quantity: '1.5', unitPrice: 333 }, 'floor')).toBe(499);
    expect(lineAmount({ quantity: '1.5', unitPrice: 333 }, 'round')).toBe(500);
    expect(lineAmount({ quantity: '1.5', unitPrice: 333 }, 'ceil')).toBe(500);
    // 1.1 × 333 = 366.3
    expect(lineAmount({ quantity: '1.1', unitPrice: 333 }, 'ceil')).toBe(367);
    expect(lineAmount({ quantity: '1.1', unitPrice: 333 }, 'round')).toBe(366);
  });
  it('不正な数量・単価を拒否', () => {
    expect(() => lineAmount({ quantity: '0', unitPrice: 1 }, 'round')).toThrow(CalcError);
    expect(() => lineAmount({ quantity: '-1', unitPrice: 1 }, 'round')).toThrow(CalcError);
    expect(() => lineAmount({ quantity: '1.2345', unitPrice: 1 }, 'round')).toThrow(CalcError);
    expect(() => lineAmount({ quantity: 'abc', unitPrice: 1 }, 'round')).toThrow(CalcError);
    expect(() => lineAmount({ quantity: '1', unitPrice: 1.5 }, 'round')).toThrow(CalcError);
    expect(() => lineAmount({ quantity: '1', unitPrice: -100 }, 'round')).toThrow(CalcError);
  });
});

describe('合計・税額', () => {
  it('外税：税率ごとに1回端数処理（切り捨て）', () => {
    const t = calculateTotals([L('a', '1', 1001), L('b', '1', 1001)], [], ex);
    // 2002 × 10% = 200.2 → 200（明細ごとに切り捨てると 100+100=200 だが、税率ごと1回）
    expect(t.subtotal).toBe(2002);
    expect(t.taxTotal).toBe(200);
    expect(t.total).toBe(2202);
  });
  it('複数税率（10% と 8%）', () => {
    const t = calculateTotals([L('a', '1', 10000, '10'), L('b', '2', 1080, '8')], [], ex);
    expect(t.taxBreakdown).toEqual([
      { rate: '10', base: 10000, tax: 1000 },
      { rate: '8', base: 2160, tax: 172 },
    ]);
    expect(t.total).toBe(10000 + 2160 + 1000 + 172);
  });
  it('内税：税込額から税額を逆算（合計は税込額のまま）', () => {
    const t = calculateTotals([L('a', '1', 60000), L('b', '1', 40000)], [], { ...ex, taxMode: 'inclusive' });
    expect(t.total).toBe(100000);
    expect(t.taxTotal).toBe(9090); // 100000×10/110 = 9090.9 → 切り捨て
  });
  it('値引き・追加費用（税率別に対象額へ反映）', () => {
    const adj: Adjustment[] = [
      { id: 'd', kind: 'discount', label: '値引き', amount: 5000, taxRate: '10' },
      { id: 'f', kind: 'fee', label: '交通費', amount: 1200, taxRate: '10' },
    ];
    const t = calculateTotals([L('a', '1', 80000), L('b', '2.5', 5000)], adj, ex);
    expect(t.subtotal).toBe(92500);
    expect(t.discountTotal).toBe(5000);
    expect(t.feeTotal).toBe(1200);
    expect(t.adjustmentTotal).toBe(-3800);
    expect(t.taxBreakdown[0].base).toBe(88700);
    expect(t.taxTotal).toBe(8870);
    expect(t.total).toBe(97570);
  });
  it('値引きが税率区分の対象額を超えるとエラー', () => {
    expect(() => calculateTotals([L('a', '1', 1000, '8')], [{ id: 'd', kind: 'discount', label: 'x', amount: 2000, taxRate: '8' }], ex)).toThrow(/値引き/);
  });
  it('税率0%・非整数税率（例 8.5%）も入力できる', () => {
    const t = calculateTotals([L('a', '1', 1000, '0'), L('b', '1', 1000, '8.5')], [], ex);
    expect(t.taxBreakdown.find((b) => b.rate === '0')!.tax).toBe(0);
    expect(t.taxBreakdown.find((b) => b.rate === '8.5')!.tax).toBe(85);
  });
  it('税額の端数処理モード', () => {
    const lines = [L('a', '1', 1005)];
    expect(calculateTotals(lines, [], { ...ex, taxRounding: 'floor' }).taxTotal).toBe(100);
    expect(calculateTotals(lines, [], { ...ex, taxRounding: 'round' }).taxTotal).toBe(101);
    expect(calculateTotals(lines, [], { ...ex, taxRounding: 'ceil' }).taxTotal).toBe(101);
  });
  it('大きな金額でも安全整数の範囲で計算', () => {
    const t = calculateTotals([L('a', '999999.999', 1_000_000, '0')], [], ex);
    expect(Number.isSafeInteger(t.total)).toBe(true);
    expect(t.subtotal).toBe(999_999_999_000);
    expect(() => calculateTotals([L('a', '999999.999', 1_000_000_000)], [], ex)).toThrow(CalcError);
  });
});

describe('入金状態の導出・残額・過入金・期限判定', () => {
  const today = '2026-09-28';
  it('未入金', () => {
    expect(summarizePayment(100000, 0, '2026-10-31', today)).toMatchObject({ state: 'unpaid', remaining: 100000, overdue: false });
  });
  it('一部入金', () => {
    expect(summarizePayment(100000, 30000, '2026-10-31', today)).toMatchObject({ state: 'partial', remaining: 70000 });
  });
  it('入金済み', () => {
    expect(summarizePayment(100000, 100000, '2026-09-01', today)).toMatchObject({ state: 'paid', remaining: 0, overdue: false });
  });
  it('過入金は明示し、差額を値引き等に扱わない', () => {
    expect(summarizePayment(100000, 100500, '2026-10-31', today)).toMatchObject({ state: 'overpaid', remaining: -500, overpaidAmount: 500 });
  });
  it('期限超過：期限日の翌日から。期限当日は超過ではない', () => {
    expect(summarizePayment(1000, 0, '2026-09-28', today).overdue).toBe(false);
    expect(summarizePayment(1000, 0, '2026-09-27', today).overdue).toBe(true);
    expect(summarizePayment(1000, 500, '2026-09-27', today)).toMatchObject({ state: 'partial', overdue: true });
    expect(summarizePayment(1000, 1000, '2026-09-27', today).overdue).toBe(false);
  });
});
