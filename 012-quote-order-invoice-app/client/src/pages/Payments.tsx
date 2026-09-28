import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, get, newRequestId, post } from '../api';
import { useApi, useOnline } from '../hooks';
import { AsyncButton, DateText, Empty, ErrorBanner, Field, Loading, Modal, Money, YenInput, useToast } from '../components/ui';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '../../../shared/status';
import { formatYen } from '../../../shared/calc';
import { todayIn } from '../../../shared/dates';

export default function PaymentsPage() {
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const [tab, setTab] = useState<'unallocated' | 'all'>(focus ? 'all' : 'unallocated');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams();
  if (tab === 'unallocated') qs.set('unallocated', '1');
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const { data, error, loading, reload } = useApi<{ payments: any[] }>(`/api/payments?${qs}`);
  const [matching, setMatching] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const online = useOnline();
  useEffect(() => {
    if (focus && data) {
      const p = data.payments.find((x) => x.id === focus);
      if (p && p.unallocated > 0) setMatching(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, data]);
  const rows = data?.payments ?? [];

  return (
    <div>
      <div className="page-header">
        <Link to="/invoices" className="back-link">
          ‹ 請求・入金
        </Link>
        <h1>入金一覧</h1>
        <button className="btn" onClick={() => setAdding(true)} disabled={!online}>
          ＋ 入金を登録
        </button>
        <Link className="btn primary" to="/payments/import">
          銀行CSVを取り込む
        </Link>
      </div>
      <div className="tabs">
        <button className={tab === 'unallocated' ? 'active' : ''} onClick={() => setTab('unallocated')}>
          未割当の入金
        </button>
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
          すべての入金
        </button>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="date" aria-label="入金日（から）" value={from} onChange={(e) => setFrom(e.target.value)} style={{ maxWidth: 180 }} />〜
        <input type="date" aria-label="入金日（まで）" value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 180 }} />
      </div>
      <p className="small muted">未割当の入金は、請求書の候補を確認してから利用者が割り当てます（自動では確定しません）。</p>
      <ErrorBanner message={error} />
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>{tab === 'unallocated' ? '未割当の入金はありません' : '入金はありません'}</Empty>
      ) : (
        <div className="list" data-testid="payment-list">
          {rows.map((p) => (
            <div key={p.id} className="list-item" style={p.id === focus ? { borderColor: 'var(--accent)' } : undefined}>
              <div className="row between">
                <span className="title">
                  <Money v={p.amount} /> <span className="small muted">{p.payerName || '（名義なし）'}</span>
                </span>
                {p.unallocated > 0 ? <span className="badge yellow">未割当 {formatYen(p.unallocated)}</span> : <span className="badge green">割当済み</span>}
              </div>
              <div className="meta">
                <DateText v={p.receivedOn} />
                <span>{PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method}</span>
                <span>{p.source === 'bank_csv' ? '銀行CSV' : '手入力'}</span>
                {p.memo && <span>{p.memo}</span>}
              </div>
              {p.allocations.length > 0 && (
                <div className="small" style={{ marginTop: 4 }}>
                  {p.allocations.map((a: any) => (
                    <div key={a.id}>
                      → <Link to={`/invoices/${a.invoiceId}`}>{a.invoiceNumber}</Link>（{a.customerName}・{a.projectTitle}）<Money v={a.amount} />
                    </div>
                  ))}
                </div>
              )}
              <div className="btn-row" style={{ marginTop: 8 }}>
                {p.unallocated > 0 && (
                  <button className="btn primary sm" onClick={() => setMatching(p)} disabled={!online} data-testid="match-payment">
                    照合して割り当てる
                  </button>
                )}
                <AsyncButton
                  className="btn sm danger"
                  confirm={p.allocations.length ? 'この入金を削除すると、請求書への割当も解除されます。よろしいですか？' : 'この入金を削除しますか？'}
                  onClick={async () => {
                    await del(`/api/payments/${p.id}`);
                    await reload();
                  }}
                >
                  削除
                </AsyncButton>
              </div>
            </div>
          ))}
        </div>
      )}
      {matching && (
        <MatchModal
          payment={matching}
          onClose={() => setMatching(null)}
          onDone={async () => {
            setMatching(null);
            await reload();
          }}
        />
      )}
      {adding && (
        <AddPaymentModal
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function MatchModal({ payment, onClose, onDone }: { payment: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [cand, setCand] = useState<any | null>(null);
  const [open, setOpen] = useState<any[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [amount, setAmount] = useState<number | ''>('');
  const [requestId] = useState(newRequestId());
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    get(`/api/payments/${payment.id}/candidates`).then(setCand).catch((e) => setError(e.message));
    get('/api/invoices?state=open').then((r) => setOpen(r.invoices)).catch(() => undefined);
  }, [payment.id]);
  const pick = (invoiceId: string, remaining: number) => {
    setChosen(invoiceId);
    setAmount(Math.min(payment.unallocated, remaining));
  };
  const target = open.find((i) => i.id === chosen) ?? cand?.candidates.find((c: any) => c.invoiceId === chosen);
  const remaining = target ? target.remaining : 0;
  return (
    <Modal title="入金の照合" onClose={onClose} wide>
      <div className="stack">
        <div className="banner info">
          入金 <strong><Money v={payment.amount} /></strong>（未割当 <Money v={payment.unallocated} />）・<DateText v={payment.receivedOn} />・{payment.payerName || '名義なし'}
        </div>
        <ErrorBanner message={error} />
        {!cand ? (
          <Loading />
        ) : (
          <>
            {cand.ambiguous && <div className="banner warn">同じ金額・名義の候補が複数あります。請求書の内容を確認して選んでください。</div>}
            {cand.candidates.length === 0 && <div className="banner warn">一致する候補が見つかりません。下の一覧から請求書を選んでください。</div>}
            <h3 style={{ margin: 0 }}>候補（自動では確定しません）</h3>
            <div className="list" data-testid="candidates">
              {cand.candidates.map((c: any) => (
                <label key={c.invoiceId} className="list-item" style={{ cursor: 'pointer', borderColor: chosen === c.invoiceId ? 'var(--accent)' : undefined }}>
                  <div className="row between">
                    <span className="row">
                      <input type="radio" name="cand" checked={chosen === c.invoiceId} onChange={() => pick(c.invoiceId, c.remaining)} />
                      <span className="title">
                        {c.number}・{c.customerName}
                      </span>
                    </span>
                    <span>
                      残額 <Money v={c.remaining} />
                    </span>
                  </div>
                  <div className="meta">
                    <span>{c.projectTitle}</span>
                    <span>
                      期限 <DateText v={c.dueDate} />
                    </span>
                    {c.reasons.map((r: string) => (
                      <span key={r} className="badge blue">
                        {r}
                      </span>
                    ))}
                  </div>
                </label>
              ))}
            </div>
            <Field label="その他の未入金請求書から選ぶ">
              <select value={chosen} onChange={(e) => pick(e.target.value, open.find((i) => i.id === e.target.value)?.remaining ?? 0)}>
                <option value="">選択してください</option>
                {open.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number}・{i.customerName}・残額 {Number(i.remaining).toLocaleString('ja-JP')}円
                  </option>
                ))}
              </select>
            </Field>
            {chosen && (
              <>
                <Field label="割り当てる金額（円）">
                  <YenInput value={amount} onChange={setAmount} allowEmpty ariaLabel="割当額" />
                </Field>
                {amount !== '' && amount > remaining && <div className="banner warn">残額より {formatYen(amount - remaining)} 多く割り当てます。請求書は「過入金」になります。</div>}
                {amount !== '' && amount < remaining && <div className="small muted">一部入金になります（残り {formatYen(remaining - amount)}）。差額は値引き・手数料として処理しません。</div>}
                <AsyncButton
                  className="btn primary block"
                  disabled={amount === '' || amount <= 0}
                  onClick={async () => {
                    try {
                      await post(`/api/payments/${payment.id}/allocations`, { requestId, invoiceId: chosen, amount });
                      toast('入金を割り当てました');
                      await onDone();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                  data-testid="confirm-allocation"
                >
                  この請求書に割り当てる（確定）
                </AsyncButton>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function AddPaymentModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState<{ receivedOn: string; amount: number | ''; method: PaymentMethod; payerName: string; memo: string }>({
    receivedOn: todayIn(),
    amount: '',
    method: 'bank_transfer',
    payerName: '',
    memo: '',
  });
  const [requestId] = useState(newRequestId());
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="入金を登録（未割当）" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          請求書が決まっている場合は、請求書の画面から「入金を記録」する方が簡単です。
        </p>
        <ErrorBanner message={error} />
        <Field label="入金日">
          <input type="date" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} />
        </Field>
        <Field label="金額（円）">
          <YenInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} allowEmpty />
        </Field>
        <Field label="方法">
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PaymentMethod })}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="名義">
          <input value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} />
        </Field>
        <Field label="メモ">
          <input value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
        </Field>
        <AsyncButton
          className="btn primary block"
          disabled={!f.amount}
          onClick={async () => {
            try {
              await post('/api/payments', { requestId, ...f });
              await onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          登録する
        </AsyncButton>
      </div>
    </Modal>
  );
}
