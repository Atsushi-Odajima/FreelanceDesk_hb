import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, useIsMobile } from '../hooks';
import { DateText, Empty, ErrorBanner, Loading, Money, PaymentBadge } from '../components/ui';

const STATES: Array<[string, string]> = [
  ['open', '未入金・一部入金'],
  ['unpaid', '未入金'],
  ['partial', '一部入金'],
  ['overdue', '期限超過'],
  ['paid', '入金済み'],
  ['overpaid', '過入金'],
  ['draft', '下書き'],
  ['cancelled', '取消'],
  ['all', 'すべて'],
];

export default function InvoicesPage() {
  const [state, setState] = useState('open');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [q, setQ] = useState('');
  const mobile = useIsMobile();
  const nav = useNavigate();
  const customers = useApi<{ customers: any[] }>('/api/customers?archived=all');
  const params = new URLSearchParams({ state });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (customerId) params.set('customerId', customerId);
  if (q.trim()) params.set('q', q.trim());
  const { data, error, loading } = useApi<{ invoices: any[] }>(`/api/invoices?${params}`);
  const rows = data?.invoices ?? [];
  const sumRemaining = rows.filter((r) => r.status === 'issued').reduce((a, r) => a + Math.max(0, r.remaining), 0);
  const href = (i: any) => (i.status === 'draft' ? `/invoice-versions/${i.draftVersionId}` : `/invoices/${i.id}`);

  return (
    <div>
      <div className="page-header">
        <h1>請求・入金</h1>
        <Link className="btn" to="/payments">
          入金一覧
        </Link>
        <Link className="btn" to="/payments/import">
          銀行CSVで照合
        </Link>
      </div>
      <div className="chips">
        {STATES.map(([k, label]) => (
          <button key={k} className={`chip ${state === k ? 'active' : ''}`} onClick={() => setState(k)}>
            {label}
          </button>
        ))}
      </div>
      <details className="card filters" style={{ marginBottom: 12 }} open={!mobile}>
        <summary>絞り込み（期間・顧客・検索）</summary>
        <div className="form-grid cols-3" style={{ marginTop: 8 }}>
          <label className="field">
            <span className="label">請求日（から）</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">請求日（まで）</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">顧客</span>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">すべて</option>
              {(customers.data?.customers ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field span-all">
            <span className="label">請求番号・案件・顧客名で検索</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
      </details>
      <ErrorBanner message={error} />
      <p className="small muted">
        {rows.length}件・表示中の未入金残額 <Money v={sumRemaining} />
      </p>
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>該当する請求書はありません</Empty>
      ) : mobile ? (
        <div className="list" data-testid="invoice-list">
          {rows.map((i) => (
            <Link key={i.id} to={href(i)} className="list-item">
              <div className="row between">
                <span className="title">{i.customerName}</span>
                <Money v={i.status === 'draft' ? i.draftTotal : i.total} />
              </div>
              <div className="meta">
                <span>{i.number ?? '下書き'}</span>
                <span>{i.projectTitle}</span>
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                <PaymentBadge state={i.paymentState} overdue={i.overdue} status={i.status} />
                {i.dueDate && (
                  <span>
                    期限 <DateText v={i.dueDate} />
                  </span>
                )}
                {i.status === 'issued' && i.remaining !== 0 && (
                  <span>
                    {i.remaining < 0 ? '過入金' : '残額'} <Money v={Math.abs(i.remaining)} />
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table" data-testid="invoice-table">
            <thead>
              <tr>
                <th>請求番号</th>
                <th>顧客</th>
                <th>案件</th>
                <th>請求日</th>
                <th>支払期限</th>
                <th className="right">請求額</th>
                <th className="right">入金額</th>
                <th className="right">残額</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => nav(href(i))}>
                  <td className="nowrap">
                    <Link to={href(i)}>{i.number ?? '下書き'}</Link>
                    {i.currentRevision > 1 && <span className="badge" style={{ marginLeft: 4 }}>訂正{i.currentRevision}</span>}
                  </td>
                  <td>{i.customerName}</td>
                  <td>{i.projectTitle}</td>
                  <td>
                    <DateText v={i.issueDate} />
                  </td>
                  <td>
                    <DateText v={i.dueDate} />
                  </td>
                  <td className="right">
                    <Money v={i.status === 'draft' ? i.draftTotal : i.total} />
                  </td>
                  <td className="right">
                    <Money v={i.allocated} />
                  </td>
                  <td className="right">{i.status === 'issued' ? <Money v={i.remaining} /> : '—'}</td>
                  <td>
                    <PaymentBadge state={i.paymentState} overdue={i.overdue} status={i.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
