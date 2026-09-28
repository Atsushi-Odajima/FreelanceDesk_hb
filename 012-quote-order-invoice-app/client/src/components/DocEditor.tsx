import { useMemo } from 'react';
import { calculateTotals, CalcError, ROUNDING_LABELS, TAX_MODE_LABELS, type Adjustment, type Line, type RoundingMode, type TaxMode, formatQuantity } from '../../../shared/calc';
import { Field, Money, YenInput } from './ui';
import { newRequestId } from '../api';

export interface DocDraft {
  issueDate: string;
  subject: string;
  paymentTerms: string;
  notes: string;
  taxMode: TaxMode;
  lineRounding: RoundingMode;
  taxRounding: RoundingMode;
  lines: Line[];
  adjustments: Adjustment[];
  // 見積
  validUntil?: string | null;
  deliveryNote?: string;
  changeMemo?: string;
  // 請求
  dueDate?: string | null;
  bankInfo?: string;
  correctionReason?: string;
}

export function useTotals(d: DocDraft) {
  return useMemo(() => {
    try {
      return { totals: calculateTotals(d.lines, d.adjustments, d), error: null as string | null };
    } catch (e) {
      return { totals: null, error: e instanceof CalcError ? e.message : '計算できません' };
    }
  }, [d]);
}

const newLine = (taxRate = '10'): Line => ({ id: newRequestId(), itemId: null, name: '', description: '', quantity: '1', unit: '式', unitPrice: 0, taxRate });

export default function DocEditor({
  kind,
  value,
  onChange,
  items,
  defaultTaxRate = '10',
}: {
  kind: 'quote' | 'invoice';
  value: DocDraft;
  onChange: (v: DocDraft) => void;
  items: any[];
  defaultTaxRate?: string;
}) {
  const set = (patch: Partial<DocDraft>) => onChange({ ...value, ...patch });
  const setLine = (idx: number, patch: Partial<Line>) => set({ lines: value.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) });
  const setAdj = (idx: number, patch: Partial<Adjustment>) => set({ adjustments: value.adjustments.map((a, i) => (i === idx ? { ...a, ...patch } : a)) });
  const { totals, error } = useTotals(value);
  const lineAmount = (l: Line) => {
    try {
      return calculateTotals([l], [], value).subtotal;
    } catch {
      return null;
    }
  };
  const moveLine = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.lines.length) return;
    const lines = [...value.lines];
    [lines[i], lines[j]] = [lines[j], lines[i]];
    set({ lines });
  };

  return (
    <div className="stack">
      <div className="card">
        <h2>基本情報</h2>
        <div className="form-grid cols-3">
          <Field label="件名" className="span-all">
            <input value={value.subject} onChange={(e) => set({ subject: e.target.value })} maxLength={200} />
          </Field>
          <Field label="発行日">
            <input type="date" value={value.issueDate} onChange={(e) => set({ issueDate: e.target.value })} required />
          </Field>
          {kind === 'quote' ? (
            <>
              <Field label="有効期限">
                <input type="date" value={value.validUntil ?? ''} onChange={(e) => set({ validUntil: e.target.value || null })} />
              </Field>
              <Field label="予定納期（記載用）" hint="例：2026年10月31日／受注後3週間">
                <input value={value.deliveryNote ?? ''} onChange={(e) => set({ deliveryNote: e.target.value })} maxLength={200} />
              </Field>
            </>
          ) : (
            <Field label="支払期限">
              <input type="date" value={value.dueDate ?? ''} onChange={(e) => set({ dueDate: e.target.value || null })} required />
            </Field>
          )}
          <Field label="支払条件" className="span-2">
            <input value={value.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} maxLength={300} />
          </Field>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>明細</h2>
          <span className="small muted">{value.lines.length}行</span>
        </div>
        <div className="lines" data-testid="lines">
          {value.lines.map((l, i) => {
            const amt = lineAmount(l);
            return (
              <div key={l.id} className="line-card">
                <div className="line-grid">
                  <Field label={`品目 ${i + 1}`} className="name">
                    <input
                      list="item-options"
                      value={l.name}
                      aria-label={`品目${i + 1}の名称`}
                      onChange={(e) => {
                        const name = e.target.value;
                        const it = items.find((x) => x.name === name || (x.code && `${x.code} ${x.name}` === name));
                        if (it) setLine(i, { name: it.name, itemId: it.id, unitPrice: Number(it.unitPrice), unit: it.unit, taxRate: it.taxRate, description: l.description || it.description });
                        else setLine(i, { name });
                      }}
                      placeholder="品目名（登録済み品目から選択可）"
                    />
                  </Field>
                  <Field label="数量">
                    <input inputMode="decimal" value={l.quantity} aria-label={`品目${i + 1}の数量`} onChange={(e) => setLine(i, { quantity: e.target.value.replace(/[０-９．]/g, (d) => (d === '．' ? '.' : String.fromCharCode(d.charCodeAt(0) - 0xfee0))) })} />
                  </Field>
                  <Field label="単位">
                    <input value={l.unit ?? ''} onChange={(e) => setLine(i, { unit: e.target.value })} maxLength={20} />
                  </Field>
                  <Field label="単価（円）">
                    <YenInput value={l.unitPrice} onChange={(v) => setLine(i, { unitPrice: v === '' ? 0 : v })} ariaLabel={`品目${i + 1}の単価`} />
                  </Field>
                  <Field label="税率%">
                    <input inputMode="decimal" value={l.taxRate} onChange={(e) => setLine(i, { taxRate: e.target.value })} aria-label={`品目${i + 1}の税率`} />
                  </Field>
                  <div className="field">
                    <span className="label">金額</span>
                    <div className="line-amount">{amt === null ? <span className="badge red">入力を確認</span> : <Money v={amt} />}</div>
                  </div>
                  <Field label="説明（任意）" className="desc">
                    <input value={l.description ?? ''} onChange={(e) => setLine(i, { description: e.target.value })} maxLength={1000} />
                  </Field>
                </div>
                <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn sm ghost" onClick={() => moveLine(i, -1)} disabled={i === 0} aria-label="上へ">
                    ↑
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => moveLine(i, 1)} disabled={i === value.lines.length - 1} aria-label="下へ">
                    ↓
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => set({ lines: [...value.lines.slice(0, i + 1), { ...l, id: newRequestId() }, ...value.lines.slice(i + 1)] })}>
                    複製
                  </button>
                  <button type="button" className="btn sm danger" onClick={() => set({ lines: value.lines.filter((_, j) => j !== i) })}>
                    削除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <datalist id="item-options">
          {items.map((it) => (
            <option key={it.id} value={it.name}>
              {it.code} {Number(it.unitPrice).toLocaleString('ja-JP')}円/{it.unit}
            </option>
          ))}
        </datalist>
        <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => set({ lines: [...value.lines, newLine(defaultTaxRate)] })} data-testid="add-line">
          ＋ 明細を追加
        </button>

        <h3 style={{ marginTop: 16 }}>値引き・追加費用</h3>
        {value.adjustments.map((a, i) => (
          <div key={a.id} className="line-card" style={{ marginBottom: 8 }}>
            <div className="form-grid cols-3">
              <Field label="種類">
                <select value={a.kind} onChange={(e) => setAdj(i, { kind: e.target.value as 'discount' | 'fee' })}>
                  <option value="discount">値引き</option>
                  <option value="fee">追加費用</option>
                </select>
              </Field>
              <Field label="名称">
                <input value={a.label} onChange={(e) => setAdj(i, { label: e.target.value })} maxLength={100} />
              </Field>
              <Field label="金額（円・正の数）">
                <YenInput value={a.amount} onChange={(v) => setAdj(i, { amount: v === '' ? 0 : v })} />
              </Field>
              <Field label="対象の税率%">
                <input inputMode="decimal" value={a.taxRate} onChange={(e) => setAdj(i, { taxRate: e.target.value })} />
              </Field>
            </div>
            <button type="button" className="btn sm danger" style={{ marginTop: 6 }} onClick={() => set({ adjustments: value.adjustments.filter((_, j) => j !== i) })}>
              削除
            </button>
          </div>
        ))}
        <div className="btn-row">
          <button type="button" className="btn sm" onClick={() => set({ adjustments: [...value.adjustments, { id: newRequestId(), kind: 'discount', label: '値引き', amount: 0, taxRate: defaultTaxRate }] })}>
            ＋ 値引き
          </button>
          <button type="button" className="btn sm" onClick={() => set({ adjustments: [...value.adjustments, { id: newRequestId(), kind: 'fee', label: '交通費', amount: 0, taxRate: defaultTaxRate }] })}>
            ＋ 追加費用
          </button>
        </div>

        <div className="form-grid cols-3" style={{ marginTop: 16 }}>
          <Field label="税の表示">
            <select value={value.taxMode} onChange={(e) => set({ taxMode: e.target.value as TaxMode })}>
              {Object.entries(TAX_MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="明細金額の端数">
            <select value={value.lineRounding} onChange={(e) => set({ lineRounding: e.target.value as RoundingMode })}>
              {Object.entries(ROUNDING_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="消費税の端数（税率ごと）">
            <select value={value.taxRounding} onChange={(e) => set({ taxRounding: e.target.value as RoundingMode })}>
              {Object.entries(ROUNDING_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div style={{ marginTop: 12 }}>
          {error ? <div className="banner error">{error}</div> : totals && <TotalsView totals={totals} taxMode={value.taxMode} adjustments={value.adjustments} />}
        </div>
      </div>

      <div className="card">
        <h2>備考・その他</h2>
        <div className="stack">
          {kind === 'invoice' && (
            <Field label="振込先（請求書に記載）">
              <textarea value={value.bankInfo ?? ''} onChange={(e) => set({ bankInfo: e.target.value })} maxLength={500} />
            </Field>
          )}
          <Field label="備考（書類に記載）">
            <textarea value={value.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={3000} />
          </Field>
          {kind === 'quote' && (
            <Field label="変更メモ（社内用・書類には載りません）" hint="例：素材は先方支給に変更">
              <input value={value.changeMemo ?? ''} onChange={(e) => set({ changeMemo: e.target.value })} maxLength={1000} />
            </Field>
          )}
          {kind === 'invoice' && value.correctionReason !== undefined && value.correctionReason !== null && (
            <Field label="訂正理由（訂正版の請求書に記載）">
              <input value={value.correctionReason ?? ''} onChange={(e) => set({ correctionReason: e.target.value })} maxLength={1000} />
            </Field>
          )}
        </div>
      </div>
    </div>
  );
}

export function TotalsView({ totals, taxMode, adjustments }: { totals: any; taxMode: TaxMode; adjustments: Array<{ kind: string; label: string; amount: number; taxRate: string }> }) {
  return (
    <div className="totals" data-testid="totals">
      <div className="r">
        <span>{taxMode === 'inclusive' ? '小計（税込）' : '小計（税抜）'}</span>
        <Money v={totals.subtotal} />
      </div>
      {adjustments.map((a, i) => (
        <div className="r" key={i}>
          <span>
            {a.kind === 'discount' ? '値引き' : '追加費用'}：{a.label}
          </span>
          <Money v={a.kind === 'discount' ? -a.amount : a.amount} />
        </div>
      ))}
      {totals.taxBreakdown.map((b: any) => (
        <div className="r" key={b.rate}>
          <span className="small">
            {b.rate}%対象 <Money v={b.base} /> {taxMode === 'inclusive' ? 'うち消費税' : '消費税'}
          </span>
          <Money v={b.tax} />
        </div>
      ))}
      <div className="r total">
        <span>合計（税込）</span>
        <Money v={totals.total} />
      </div>
    </div>
  );
}

/** 確定済み書類（スナップショット）の読み取り表示 */
export function DocView({ snap }: { snap: any }) {
  return (
    <div className="stack">
      <div className="card">
        <div className="grid cols-2">
          <div>
            <div className="small muted">宛先</div>
            <div style={{ fontWeight: 700 }}>
              {snap.recipient.name} {snap.recipient.contactName ? '' : snap.recipient.honorific}
            </div>
            {snap.recipient.contactName && <div>{snap.recipient.contactName} 様</div>}
            <div className="small muted pre">
              {snap.recipient.postalCode && `〒${snap.recipient.postalCode} `}
              {snap.recipient.address}
            </div>
          </div>
          <div>
            <dl className="kv">
              <dt>番号</dt>
              <dd>{snap.number}</dd>
              <dt>発行日</dt>
              <dd>{snap.issueDate}</dd>
              {snap.validUntil && (
                <>
                  <dt>有効期限</dt>
                  <dd>{snap.validUntil}</dd>
                </>
              )}
              {snap.dueDate && (
                <>
                  <dt>支払期限</dt>
                  <dd>{snap.dueDate}</dd>
                </>
              )}
              {snap.deliveryNote && (
                <>
                  <dt>納期</dt>
                  <dd>{snap.deliveryNote}</dd>
                </>
              )}
              {snap.paymentTerms && (
                <>
                  <dt>支払条件</dt>
                  <dd>{snap.paymentTerms}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
        {snap.subject && <div style={{ marginTop: 8, fontWeight: 700 }}>件名：{snap.subject}</div>}
      </div>
      <div className="card">
        <h2>明細</h2>
        <div className="list">
          {snap.lines.map((l: any, i: number) => (
            <div key={i} className="row between" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 6, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ overflowWrap: 'anywhere' }}>{l.name}</div>
                {l.description && <div className="small muted pre">{l.description}</div>}
                <div className="small muted">
                  {formatQuantity(l.quantity)}
                  {l.unit} × <Money v={l.unitPrice} />（{l.taxRate}%）
                </div>
              </div>
              <Money v={l.amount} />
            </div>
          ))}
        </div>
        {snap.totals && (
          <div style={{ marginTop: 10 }}>
            <TotalsView totals={snap.totals} taxMode={snap.taxMode} adjustments={snap.adjustments} />
          </div>
        )}
      </div>
      {(snap.notes || snap.bankInfo) && (
        <div className="card">
          {snap.bankInfo && (
            <>
              <h3>振込先</h3>
              <div className="pre small">{snap.bankInfo}</div>
            </>
          )}
          {snap.notes && (
            <>
              <h3>備考</h3>
              <div className="pre small">{snap.notes}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
