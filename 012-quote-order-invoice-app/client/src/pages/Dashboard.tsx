import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks';
import { DateText, Empty, ErrorBanner, Loading, Money, PaymentBadge, StatusBadge } from '../components/ui';
import { addDays, endOfMonth, formatDateJa, startOfMonth } from '../../../shared/dates';

type Period = 'this_month' | 'last_month' | 'this_year' | 'custom';

function periodRange(p: Period, today: string, custom: { from: string; to: string }) {
  if (p === 'this_month') return { from: startOfMonth(today), to: endOfMonth(today) };
  if (p === 'last_month') {
    const last = addDays(startOfMonth(today), -1);
    return { from: startOfMonth(last), to: last };
  }
  if (p === 'this_year') return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  return custom;
}

function Section({ title, count, children, testid }: { title: string; count: number; children: React.ReactNode; testid?: string }) {
  return (
    <div className="card" data-testid={testid}>
      <div className="card-title">
        <h2>{title}</h2>
        <span className={`badge ${count ? 'blue' : ''}`}>{count}件</span>
      </div>
      {count === 0 ? <Empty>該当なし</Empty> : <div className="list">{children}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>('this_month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [today, setToday] = useState<string | null>(null);
  const range = today ? periodRange(period, today, custom) : null;
  const path = period !== 'this_month' && range && range.from && range.to ? `/api/dashboard?from=${range.from}&to=${range.to}` : '/api/dashboard';
  const { data: d, error, loading } = useApi<any>(path);
  useEffect(() => {
    if (d?.today && d.today !== today) setToday(d.today);
  }, [d, today]);
  if (!d) return loading ? <Loading /> : <ErrorBanner message={error} />;
  const L = d.lists;
  const A = d.amounts;

  return (
    <div>
      <div className="page-header">
        <h1>ホーム</h1>
        <Link className="btn primary" to="/projects/new">
          ＋ 案件を登録
        </Link>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>金額（合算しません）</h2>
          <div className="chips" style={{ margin: 0 }}>
            {(
              [
                ['this_month', '今月'],
                ['last_month', '先月'],
                ['this_year', '今年'],
                ['custom', '期間指定'],
              ] as Array<[Period, string]>
            ).map(([k, label]) => (
              <button key={k} className={`chip ${period === k ? 'active' : ''}`} onClick={() => setPeriod(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {period === 'custom' && (
          <div className="row" style={{ marginBottom: 8 }}>
            <input type="date" aria-label="開始日" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} style={{ maxWidth: 180 }} />
            〜
            <input type="date" aria-label="終了日" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} style={{ maxWidth: 180 }} />
          </div>
        )}
        <p className="small muted" style={{ marginTop: 0 }}>
          対象期間：{formatDateJa(d.period.from)}〜{formatDateJa(d.period.to)}（「見積中」「未入金残額」は期間ではなく現在の値）
        </p>
        <div className="stats" data-testid="amount-cards">
          <div className="stat">
            <div className="label">見積中金額</div>
            <div className="value">
              <Money v={A.quoting.amount} />
            </div>
            <div className="basis">{A.quoting.count}件・{A.quoting.basis}</div>
          </div>
          <div className="stat">
            <div className="label">受注金額</div>
            <div className="value">
              <Money v={A.ordered.amount} />
            </div>
            <div className="basis">{A.ordered.count}件・{A.ordered.basis}</div>
          </div>
          <div className="stat">
            <div className="label">請求済み金額</div>
            <div className="value">
              <Money v={A.billed.amount} />
            </div>
            <div className="basis">{A.billed.count}件・{A.billed.basis}</div>
          </div>
          <div className="stat">
            <div className="label">入金済み金額</div>
            <div className="value">
              <Money v={A.received.amount} />
            </div>
            <div className="basis">
              {A.received.count}件・{A.received.basis}
              {A.received.unallocated > 0 && <>（うち未割当 <Money v={A.received.unallocated} />）</>}
            </div>
          </div>
          <div className="stat">
            <div className="label">未入金残額</div>
            <div className="value">
              <Money v={A.outstanding.amount} />
            </div>
            <div className="basis">{A.outstanding.count}件・{A.outstanding.basis}</div>
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <Section title="期限超過の請求" count={L.overdue.length} testid="list-overdue">
          {L.overdue.map((i: any) => (
            <Link key={i.id} to={`/invoices/${i.id}`} className="list-item">
              <div className="row between">
                <span className="title">{i.customerName}</span>
                <Money v={i.remaining} />
              </div>
              <div className="meta">
                <span>{i.number}</span>
                <span>期限 <DateText v={i.dueDate} /></span>
                <PaymentBadge state={i.paymentState} overdue />
              </div>
            </Link>
          ))}
        </Section>
        <Section title="今月の支払期限" count={L.dueThisMonth.length}>
          {L.dueThisMonth.map((i: any) => (
            <Link key={i.id} to={`/invoices/${i.id}`} className="list-item">
              <div className="row between">
                <span className="title">{i.customerName}</span>
                <Money v={i.remaining} />
              </div>
              <div className="meta">
                <span>{i.number}</span>
                <span>期限 <DateText v={i.dueDate} /></span>
                <PaymentBadge state={i.paymentState} overdue={i.overdue} />
              </div>
            </Link>
          ))}
        </Section>
        <Section title="未割当の入金" count={L.unallocatedPayments.length} testid="list-unallocated">
          {L.unallocatedPayments.map((p: any) => (
            <Link key={p.id} to={`/payments?focus=${p.id}`} className="list-item">
              <div className="row between">
                <span className="title">{p.payerName || '（名義なし）'}</span>
                <Money v={p.unallocated} />
              </div>
              <div className="meta">
                <DateText v={p.receivedOn} />
                <span>{p.source === 'bank_csv' ? '銀行CSV' : '手入力'}</span>
              </div>
            </Link>
          ))}
        </Section>
        <Section title="未請求（納品済み・請求書未発行）" count={L.unbilled.length} testid="list-unbilled">
          {L.unbilled.map((p: any) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item">
              <div className="row between">
                <span className="title">{p.title}</span>
                <Money v={p.amount} />
              </div>
              <div className="meta">
                <span>{p.customerName}</span>
                <span>納品 <DateText v={p.deliveredOn} /></span>
              </div>
            </Link>
          ))}
        </Section>
        <Section title="今週の納期（遅れ含む）" count={L.dueThisWeek.length}>
          {L.dueThisWeek.map((p: any) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item">
              <div className="row between">
                <span className="title">{p.title}</span>
                <StatusBadge status={p.status} />
              </div>
              <div className="meta">
                <span>{p.customerName}</span>
                <span className={p.plannedDue < d.today ? 'badge red' : ''}>
                  納期 <DateText v={p.plannedDue} />
                </span>
              </div>
            </Link>
          ))}
        </Section>
        <Section title="納品待ち" count={L.awaitingDelivery.length}>
          {L.awaitingDelivery.map((p: any) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item">
              <div className="row between">
                <span className="title">{p.title}</span>
                <Money v={p.amount} />
              </div>
              <div className="meta">
                <span>{p.customerName}</span>
                <span>納期 <DateText v={p.plannedDue} /></span>
              </div>
            </Link>
          ))}
        </Section>
        <Section title="見積の回答待ち" count={L.awaitingAnswer.length}>
          {L.awaitingAnswer.map((p: any) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item">
              <div className="row between">
                <span className="title">{p.title}</span>
                <Money v={p.total} />
              </div>
              <div className="meta">
                <span>{p.customerName}</span>
                <span>
                  {p.quoteNumber} v{p.version}・提出 <DateText v={p.submittedOn} />
                </span>
                {p.validUntil && p.validUntil < d.today && <span className="badge red">有効期限切れ</span>}
              </div>
            </Link>
          ))}
        </Section>
      </div>
    </div>
  );
}
