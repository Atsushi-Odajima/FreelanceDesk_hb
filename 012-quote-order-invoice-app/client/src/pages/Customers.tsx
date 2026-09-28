import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, errorMessage, newRequestId, post, put } from '../api';
import { useApi, useIsMobile } from '../hooks';
import { AsyncButton, DateText, Empty, ErrorBanner, Field, Loading, Modal, StatusBadge } from '../components/ui';

export const emptyCustomer = {
  code: '',
  name: '',
  contactName: '',
  honorific: '御中',
  postalCode: '',
  address: '',
  phone: '',
  email: '',
  paymentTerms: '',
  payerName: '',
  internalMemo: '',
};

export function CustomerForm({ initial, id, onSaved }: { initial: typeof emptyCustomer; id?: string; onSaved: (c: any) => void }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(newRequestId());
  const set = (k: keyof typeof emptyCustomer) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = id ? await put(`/api/customers/${id}`, f) : await post('/api/customers', { ...f, requestId });
          onSaved(r.customer);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBanner message={error} />
      <div className="form-grid cols-2">
        <Field label="会社名・屋号（必須）" className="span-2">
          <input value={f.name} onChange={set('name')} required maxLength={200} />
        </Field>
        <Field label="担当者">
          <input value={f.contactName} onChange={set('contactName')} maxLength={100} />
        </Field>
        <Field label="敬称" hint="担当者がいる場合は「会社名＋担当者名 様」で表示">
          <select value={f.honorific} onChange={set('honorific')}>
            <option value="御中">御中</option>
            <option value="様">様</option>
            <option value="殿">殿</option>
            <option value="">なし</option>
          </select>
        </Field>
        <Field label="顧客コード（任意）">
          <input value={f.code} onChange={set('code')} maxLength={50} />
        </Field>
        <Field label="郵便番号">
          <input value={f.postalCode} onChange={set('postalCode')} inputMode="numeric" maxLength={20} />
        </Field>
        <Field label="住所" className="span-2">
          <textarea value={f.address} onChange={set('address')} maxLength={300} style={{ minHeight: 60 }} />
        </Field>
        <Field label="電話">
          <input type="tel" value={f.phone} onChange={set('phone')} maxLength={50} />
        </Field>
        <Field label="メール">
          <input type="email" value={f.email} onChange={set('email')} maxLength={254} />
        </Field>
        <Field label="標準支払条件">
          <input value={f.paymentTerms} onChange={set('paymentTerms')} maxLength={300} placeholder="例：月末締め翌月末払い" />
        </Field>
        <Field label="振込名義（銀行明細の照合用）" hint="例：ｻﾝﾌﾟﾙﾃﾞｻﾞｲﾝ(ｶ">
          <input value={f.payerName} onChange={set('payerName')} maxLength={200} />
        </Field>
        <Field label="内部メモ（書類には載りません）" className="span-2">
          <textarea value={f.internalMemo} onChange={set('internalMemo')} maxLength={5000} />
        </Field>
      </div>
      <button className="btn primary" disabled={busy}>
        {busy ? '保存中…' : '保存'}
      </button>
    </form>
  );
}

export default function CustomersPage() {
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi<{ customers: any[] }>(`/api/customers?archived=${archived ? '1' : '0'}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const [adding, setAdding] = useState(false);
  const mobile = useIsMobile();
  const nav = useNavigate();
  const rows = data?.customers ?? [];
  return (
    <div>
      <div className="page-header">
        <h1>顧客</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>
          ＋ 顧客を登録
        </button>
      </div>
      <div className="chips">
        <button className={`chip ${!archived ? 'active' : ''}`} onClick={() => setArchived(false)}>
          有効
        </button>
        <button className={`chip ${archived ? 'active' : ''}`} onClick={() => setArchived(true)}>
          アーカイブ
        </button>
      </div>
      <input type="search" placeholder="会社名・担当者・コードで検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="顧客を検索" style={{ marginBottom: 10 }} />
      <ErrorBanner message={error} />
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>顧客がいません</Empty>
      ) : mobile ? (
        <div className="list">
          {rows.map((c) => (
            <Link key={c.id} to={`/customers/${c.id}`} className="list-item">
              <div className="title">{c.name}</div>
              <div className="meta">
                {c.code && <span>{c.code}</span>}
                {c.contactName && <span>{c.contactName} 様</span>}
                <span>案件 {c.projectCount}件</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>コード</th>
                <th>会社名・屋号</th>
                <th>担当者</th>
                <th>電話</th>
                <th>メール</th>
                <th className="right">案件数</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/customers/${c.id}`)}>
                  <td>{c.code}</td>
                  <td>
                    <Link to={`/customers/${c.id}`}>{c.name}</Link>
                  </td>
                  <td>{c.contactName}</td>
                  <td>{c.phone}</td>
                  <td>{c.email}</td>
                  <td className="right">{c.projectCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <Modal title="顧客を登録" onClose={() => setAdding(false)}>
          <CustomerForm
            initial={emptyCustomer}
            onSaved={async () => {
              setAdding(false);
              await reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export function CustomerDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload, status } = useApi<any>(`/api/customers/${id}`);
  const [editing, setEditing] = useState(false);
  if (!data) return loading ? <Loading /> : <ErrorBanner message={status === 404 ? '顧客が見つかりません' : error} />;
  const c = data.customer;
  return (
    <div>
      <div className="page-header">
        <Link to="/customers" className="back-link">
          ‹ 顧客一覧
        </Link>
        <h1>{c.name}</h1>
        {c.archivedAt && <span className="badge">アーカイブ</span>}
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">
            <h2>顧客情報</h2>
            <button className="btn sm" onClick={() => setEditing(true)}>
              編集
            </button>
          </div>
          <dl className="kv">
            <dt>コード</dt>
            <dd>{c.code || '—'}</dd>
            <dt>担当者</dt>
            <dd>{c.contactName ? `${c.contactName} 様` : '—'}</dd>
            <dt>敬称</dt>
            <dd>{c.honorific || 'なし'}</dd>
            <dt>住所</dt>
            <dd className="pre">
              {c.postalCode && `〒${c.postalCode}\n`}
              {c.address || '—'}
            </dd>
            <dt>電話</dt>
            <dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—'}</dd>
            <dt>メール</dt>
            <dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}</dd>
            <dt>支払条件</dt>
            <dd>{c.paymentTerms || '—'}</dd>
            <dt>振込名義</dt>
            <dd>{c.payerName || '—'}</dd>
            <dt>内部メモ</dt>
            <dd className="pre">{c.internalMemo || '—'}</dd>
          </dl>
          <div className="btn-row" style={{ marginTop: 12 }}>
            {c.archivedAt ? (
              <AsyncButton
                className="btn"
                onClick={async () => {
                  await post(`/api/customers/${id}/unarchive`);
                  await reload();
                }}
              >
                アーカイブを解除
              </AsyncButton>
            ) : (
              <AsyncButton
                className="btn"
                confirm="この顧客をアーカイブしますか？（過去の書類・案件はそのまま残ります）"
                onClick={async () => {
                  await post(`/api/customers/${id}/archive`);
                  await reload();
                }}
              >
                アーカイブ
              </AsyncButton>
            )}
            {data.projects.length === 0 && (
              <AsyncButton
                className="btn danger"
                confirm="この顧客を削除しますか？"
                onClick={async () => {
                  await del(`/api/customers/${id}`);
                  nav('/customers');
                }}
              >
                削除
              </AsyncButton>
            )}
          </div>
          {data.projects.length > 0 && <p className="small muted">取引（案件）がある顧客は削除できません。使わなくなったらアーカイブしてください。</p>}
        </div>
        <div className="card">
          <div className="card-title">
            <h2>案件</h2>
            {!c.archivedAt && (
              <Link className="btn sm" to="/projects/new">
                ＋ 案件
              </Link>
            )}
          </div>
          {data.projects.length === 0 ? (
            <Empty>案件はありません</Empty>
          ) : (
            <div className="list">
              {data.projects.map((p: any) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="list-item">
                  <div className="row between">
                    <span className="title">{p.title}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="meta">
                    <span>{p.number}</span>
                    <span>
                      納期 <DateText v={p.plannedDue} />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      {editing && (
        <Modal title="顧客を編集" onClose={() => setEditing(false)}>
          <CustomerForm
            id={id}
            initial={{
              code: c.code,
              name: c.name,
              contactName: c.contactName,
              honorific: c.honorific,
              postalCode: c.postalCode,
              address: c.address,
              phone: c.phone,
              email: c.email,
              paymentTerms: c.paymentTerms,
              payerName: c.payerName,
              internalMemo: c.internalMemo,
            }}
            onSaved={async () => {
              setEditing(false);
              await reload();
            }}
          />
          <p className="small muted">変更しても、確定済みの見積書・請求書・納品書の宛名は変わりません。</p>
        </Modal>
      )}
    </div>
  );
}
