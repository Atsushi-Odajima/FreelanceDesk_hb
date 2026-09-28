import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi, useIsMobile, useIsWide } from '../hooks';
import { DateText, Empty, ErrorBanner, Loading, Money, StatusBadge } from '../components/ui';
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectStatus } from '../../../shared/status';
import ProjectDetail from './ProjectDetail';

const FILTERS: Array<[string, string]> = [
  ['open', '進行中'],
  ['quote', '見積中'],
  ['work', '受注・作業中'],
  ['billing', '請求・入金待ち'],
  ['closed', '完了・失注・キャンセル'],
  ['all', 'すべて'],
];
const FILTER_STATUS: Record<string, ProjectStatus[] | null> = {
  open: null,
  quote: ['inquiry', 'quoting', 'quote_submitted', 'considering'],
  work: ['ordered', 'in_progress', 'awaiting_delivery'],
  billing: ['delivered', 'invoiced'],
  closed: ['completed', 'lost', 'cancelled'],
  all: null,
};

export default function ProjectsPage() {
  const { id } = useParams();
  const wide = useIsWide();
  const mobile = useIsMobile();
  const nav = useNavigate();
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const params = new URLSearchParams();
  if (filter === 'open') params.set('open', '1');
  else if (FILTER_STATUS[filter]) params.set('status', FILTER_STATUS[filter]!.join(','));
  if (q.trim()) params.set('q', q.trim());
  const { data, error, loading, reload } = useApi<{ projects: any[] }>(`/api/projects?${params}`);
  const projects = useMemo(() => data?.projects ?? [], [data]);

  // スマホ・タブレット：詳細があれば詳細のみ（1画面1目的）
  if (id && !wide) return <ProjectDetail id={id} onChanged={reload} />;

  const list = (
    <div className="split-list">
      <div className="page-header">
        <h1>案件</h1>
        <Link className="btn primary" to="/projects/new">
          ＋ 新規
        </Link>
      </div>
      <div className="chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`chip ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <input type="search" placeholder="案件名・案件番号・顧客名で絞込" value={q} onChange={(e) => setQ(e.target.value)} aria-label="案件を絞り込む" style={{ marginBottom: 10 }} />
      <ErrorBanner message={error} />
      {loading && !data ? (
        <Loading />
      ) : projects.length === 0 ? (
        <Empty>
          案件がありません。<Link to="/projects/new">案件を登録</Link>
        </Empty>
      ) : mobile || id ? (
        <div className="list" data-testid="project-list">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item" style={p.id === id ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px var(--accent-weak)' } : undefined}>
              <div className="row between">
                <span className="title">{p.title}</span>
                <StatusBadge status={p.status} />
              </div>
              <div className="meta">
                <span>{p.customerName}</span>
                <span>{p.number}</span>
                {p.plannedDue && (
                  <span>
                    納期 <DateText v={p.plannedDue} />
                  </span>
                )}
                {(p.orderAmount ?? p.quoteTotal) != null && <Money v={p.orderAmount ?? p.quoteTotal} />}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table" data-testid="project-table">
            <thead>
              <tr>
                <th>案件番号</th>
                <th>案件名</th>
                <th>顧客</th>
                <th>状態</th>
                <th>予定納期</th>
                <th className="right">受注/見積額</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${p.id}`)}>
                  <td className="nowrap">{p.number}</td>
                  <td>
                    <Link to={`/projects/${p.id}`}>{p.title}</Link>
                  </td>
                  <td>{p.customerName}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>
                    <DateText v={p.plannedDue} />
                  </td>
                  <td className="right">
                    <Money v={p.orderAmount ?? p.quoteTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">状態の一覧：{PROJECT_STATUSES.map((s) => PROJECT_STATUS_LABELS[s]).join(' → ')}</p>
    </div>
  );

  if (wide && id) {
    return (
      <div className="split has-detail">
        {list}
        <div>
          <ProjectDetail id={id} onChanged={reload} embedded />
        </div>
      </div>
    );
  }
  return list;
}
