import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get } from '../api';
import { Empty, Money, StatusBadge } from '../components/ui';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [res, setRes] = useState<any | null>(null);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) return setRes(null);
      setParams({ q }, { replace: true });
      try {
        setRes(await get(`/api/search?q=${encodeURIComponent(q.trim())}`));
      } catch {
        setRes(null);
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const total = res ? res.projects.length + res.customers.length + res.quotes.length + res.invoices.length : 0;
  return (
    <div>
      <div className="page-header">
        <h1>検索</h1>
      </div>
      <input type="search" autoFocus placeholder="案件番号・案件名・顧客名・見積番号・請求番号" value={q} onChange={(e) => setQ(e.target.value)} aria-label="検索語" />
      {res && total === 0 && <Empty>見つかりませんでした</Empty>}
      {res && (
        <div className="stack" style={{ marginTop: 12 }}>
          {res.projects.length > 0 && (
            <div className="card">
              <h2>案件</h2>
              <div className="list">
                {res.projects.map((p: any) => (
                  <Link key={p.id} to={`/projects/${p.id}`} className="list-item">
                    <div className="row between">
                      <span className="title">{p.title}</span>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="meta">
                      <span>{p.number}</span>
                      <span>{p.customerName}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {res.customers.length > 0 && (
            <div className="card">
              <h2>顧客</h2>
              <div className="list">
                {res.customers.map((c: any) => (
                  <Link key={c.id} to={`/customers/${c.id}`} className="list-item">
                    <span className="title">{c.name}</span> {c.code && <span className="small muted">{c.code}</span>}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {res.quotes.length > 0 && (
            <div className="card">
              <h2>見積</h2>
              <div className="list">
                {res.quotes.map((v: any) => (
                  <Link key={v.id} to={`/quotes/${v.id}`} className="list-item">
                    <div className="row between">
                      <span className="title">
                        {v.number} v{v.version}
                      </span>
                      <Money v={Number(v.total)} />
                    </div>
                    <div className="meta">{v.projectTitle}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {res.invoices.length > 0 && (
            <div className="card">
              <h2>請求書</h2>
              <div className="list">
                {res.invoices.map((i: any) => (
                  <Link key={i.id} to={`/invoices/${i.id}`} className="list-item">
                    <div className="row between">
                      <span className="title">{i.number}</span>
                      <Money v={Number(i.total)} />
                    </div>
                    <div className="meta">{i.projectTitle}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
