import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, del, newRequestId, patch, post, put } from '../api';
import { useApi } from '../hooks';
import { AsyncButton, DateText, Empty, ErrorBanner, Field, Loading, Modal, Money, PaymentBadge, StatusBadge, useToast } from '../components/ui';
import PdfActions from '../components/PdfActions';
import { PortalTab } from './PortalOperator';
import { IntakeTab } from './IntakeOperator';
import { AttachmentList, UploadButtons } from '../components/Attachments';
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectStatus } from '../../../shared/status';
import { formatDateTimeJa, todayIn } from '../../../shared/dates';

type Tab = 'overview' | 'intake' | 'quote' | 'tasks' | 'delivery' | 'invoice' | 'files' | 'portal' | 'history';
const TABS: Array<[Tab, string]> = [
  ['overview', '概要'],
  ['intake', 'ヒアリング'],
  ['quote', '見積・受注'],
  ['tasks', 'タスク'],
  ['delivery', '納品'],
  ['invoice', '請求・入金'],
  ['files', 'ファイル'],
  ['portal', 'クライアントポータル'],
  ['history', '履歴'],
];

export default function ProjectDetail({ id, onChanged, embedded }: { id: string; onChanged?: () => void; embedded?: boolean }) {
  const { data: d, error, loading, reload, status } = useApi<any>(`/api/projects/${id}`);
  const [tab, setTab] = useState<Tab>('overview');
  const [modal, setModal] = useState<null | 'order' | 'delivery' | 'status' | 'decline'>(null);
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const presetVersion = params.get('version');
  useEffect(() => {
    const t = params.get('tab');
    if (t && TABS.some(([k]) => k === t)) setTab(t as Tab);
    if (params.get('action') === 'order') {
      setTab('quote');
      setModal('order');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refresh = async () => {
    await reload();
    onChanged?.();
  };

  if (!d) return loading ? <Loading /> : <ErrorBanner message={status === 404 ? '案件が見つかりません（削除されたか、アクセス権がありません）' : error} />;
  const p = d.project;
  const closed = ['completed', 'lost', 'cancelled'].includes(p.status);
  const latestFinal = [...d.quoteVersions].filter((v: any) => v.status === 'final').pop();
  const draftVersion = d.quoteVersions.find((v: any) => v.status === 'draft');

  const createQuote = async () => {
    const r = await post(`/api/projects/${id}/quotes`, { requestId: newRequestId() });
    nav(`/quotes/${r.versionId}`);
  };
  const createInvoice = async () => {
    const requestId = newRequestId();
    let r;
    try {
      r = await post(`/api/projects/${id}/invoices`, { requestId });
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'already_invoiced')) throw e;
      if (!window.confirm(`${e.message}\n\n分割請求・追加請求として、受注内容を引き継いだ請求書をもう1通作りますか？`)) return;
      r = await post(`/api/projects/${id}/invoices`, { requestId, allowAdditional: true });
    }
    nav(`/invoice-versions/${r.versionId}`);
  };

  const runAction = async (key: string) => {
    switch (key) {
      case 'create_quote':
        return createQuote();
      case 'edit_quote':
        return nav(`/quotes/${draftVersion?.id ?? latestFinal?.id}`);
      case 'submit_quote':
        return nav(`/quotes/${latestFinal?.id}`);
      case 'create_order':
        return setModal('order');
      case 'tasks':
        return setTab('tasks');
      case 'create_delivery':
        return setModal('delivery');
      case 'create_invoice':
        return createInvoice();
      case 'edit_invoice': {
        const dr = d.invoices.find((i: any) => i.status === 'draft');
        return nav(`/invoice-versions/${dr.draftVersionId}`);
      }
      case 'record_payment': {
        const open = d.invoices.find((i: any) => i.status === 'issued' && i.remaining > 0);
        return nav(`/invoices/${open.id}`);
      }
      case 'complete':
        await post(`/api/projects/${id}/status`, { status: 'completed', note: '入金確認済み' });
        toast('案件を完了にしました');
        return refresh();
    }
  };

  const next = d.timeline.find((t: any) => t.nextAction)?.nextAction;

  return (
    <div data-testid="project-detail">
      <div className="page-header">
        {!embedded && (
          <Link to="/projects" className="back-link">
            ‹ 案件一覧
          </Link>
        )}
      </div>
      <div className="card">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="small muted">
              {p.number}・{d.customer.name}
            </div>
            <h1 style={{ margin: '2px 0 6px', overflowWrap: 'anywhere' }}>{p.title}</h1>
            <div className="row">
              <StatusBadge status={p.status} />
              {p.plannedDue && (
                <span className="small muted">
                  予定納期 <DateText v={p.plannedDue} />
                </span>
              )}
            </div>
          </div>
          <div className="btn-row">
            <button className="btn sm" onClick={() => setModal('status')}>
              状態を変更
            </button>
            <Link className="btn sm" to={`/projects/${id}/edit`}>
              編集
            </Link>
          </div>
        </div>
        {next && (
          <div className="banner info row between" style={{ marginTop: 12, marginBottom: 0 }}>
            <span>
              次の操作：<strong>{next.label}</strong>
            </span>
            <AsyncButton className="btn primary sm" onClick={() => runAction(next.key)} data-testid="next-action">
              {next.label}
            </AsyncButton>
          </div>
        )}
      </div>

      <div className="card">
        <h2>進行状況</h2>
        <ol className="timeline" data-testid="timeline">
          {d.timeline.map((t: any) => (
            <li key={t.step} className={t.state}>
              <span className="dot" />
              <div className="row between">
                <span className="step">{t.label}</span>
                <span className="small muted">{t.date ? <DateText v={t.date} /> : ''}</span>
              </div>
              {t.document && (
                <div className="small">
                  <DocLink doc={t.document} invoices={d.invoices} deliveries={d.deliveries} onTab={setTab} />
                </div>
              )}
              {t.memo && <div className="small muted">{t.memo}</div>}
              {t.nextAction && (
                <button className="btn sm" style={{ marginTop: 4 }} onClick={() => runAction(t.nextAction.key)}>
                  {t.nextAction.label}
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
            {k === 'tasks' && d.tasks.length > 0 && <span className="count">{d.tasks.filter((t: any) => t.done).length}/{d.tasks.length}</span>}
            {k === 'files' && d.attachments.length > 0 && <span className="count">{d.attachments.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview d={d} />}
      {tab === 'quote' && (
        <div className="card">
          <div className="card-title">
            <h2>見積</h2>
            {!closed && d.quoteVersions.length === 0 && (
              <AsyncButton className="btn primary sm" onClick={createQuote}>
                見積を作成
              </AsyncButton>
            )}
          </div>
          {d.quoteVersions.length === 0 ? (
            <Empty>まだ見積がありません</Empty>
          ) : (
            <div className="list">
              {d.quoteVersions.map((v: any) => (
                <Link key={v.id} to={`/quotes/${v.id}`} className="list-item">
                  <div className="row between">
                    <span className="title">
                      {v.number} v{v.version}
                    </span>
                    <Money v={Number(v.total)} />
                  </div>
                  <div className="meta">
                    <span className={`badge ${v.status === 'draft' ? 'yellow' : 'blue'}`}>{v.status === 'draft' ? '下書き' : '確定'}</span>
                    {v.submittedOn && <span className="badge green">提出済み {v.submittedOn}</span>}
                    {v.declinedAt && <span className="badge">失注</span>}
                    {d.activeOrder?.quoteVersionId === v.id && <span className="badge green">受注</span>}
                    {v.changeMemo && <span>{v.changeMemo}</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
          <h2 style={{ marginTop: 16 }}>受注</h2>
          {d.activeOrder ? (
            <dl className="kv">
              <dt>受注日</dt>
              <dd>
                <DateText v={d.activeOrder.orderDate} />
              </dd>
              <dt>受注金額</dt>
              <dd>
                <Money v={d.activeOrder.amount} />
              </dd>
              <dt>採用した見積</dt>
              <dd>
                {d.activeOrder.quoteNumber} v{d.activeOrder.quoteVersion}
              </dd>
              <dt>納期</dt>
              <dd>
                <DateText v={d.activeOrder.dueDate} />
              </dd>
              <dt>支払条件</dt>
              <dd className="pre">{d.activeOrder.paymentTerms || '—'}</dd>
            </dl>
          ) : (
            <div className="stack">
              <Empty>未受注</Empty>
              {!closed && latestFinal && (
                <div className="btn-row">
                  <button className="btn primary" onClick={() => setModal('order')}>
                    この見積で受注
                  </button>
                  <button className="btn danger" onClick={() => setModal('decline')}>
                    失注にする
                  </button>
                </div>
              )}
            </div>
          )}
          {d.orders.filter((o: any) => o.status === 'cancelled').length > 0 && <p className="small muted">取消済みの受注：{d.orders.filter((o: any) => o.status === 'cancelled').length}件</p>}
          {d.activeOrder && !d.invoices.some((i: any) => i.status !== 'cancelled') && (
            <AsyncButton
              className="btn sm danger"
              confirm="受注を取り消しますか？（見積の改訂や失注処理ができるようになります）"
              onClick={async () => {
                await post(`/api/orders/${d.activeOrder.id}/cancel`, { reason: '' });
                await refresh();
              }}
            >
              受注を取り消す
            </AsyncButton>
          )}
        </div>
      )}
      {tab === 'tasks' && <Tasks projectId={id} tasks={d.tasks} onChanged={refresh} />}
      {tab === 'delivery' && (
        <div className="card">
          <div className="card-title">
            <h2>納品</h2>
            <button className="btn primary sm" onClick={() => setModal('delivery')}>
              納品を記録
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            納品を記録しても請求書は自動では作られません。
          </p>
          {d.deliveries.length === 0 ? (
            <Empty>納品記録はありません</Empty>
          ) : (
            d.deliveries.map((dv: any) => (
              <div key={dv.id} className="card" style={{ boxShadow: 'none' }}>
                <div className="row between">
                  <strong>
                    {dv.number}・<DateText v={dv.deliveredOn} />
                  </strong>
                  <AsyncButton
                    className="btn sm danger"
                    confirm="この納品記録を削除しますか？（納品書PDFも削除されます）"
                    onClick={async () => {
                      await del(`/api/deliveries/${dv.id}`);
                      await refresh();
                    }}
                  >
                    削除
                  </AsyncButton>
                </div>
                {dv.content && <div className="pre small">内容：{dv.content}</div>}
                {dv.customerComment && <div className="pre small">顧客向けコメント：{dv.customerComment}</div>}
                {dv.internalMemo && <div className="pre small muted">内部メモ：{dv.internalMemo}</div>}
                <div style={{ marginTop: 8 }}>
                  <PdfActions url={`/api/pdf/deliveries/${dv.id}`} filename={`納品書_${dv.number}.pdf`} label="納品書" />
                </div>
                <div style={{ marginTop: 8 }}>
                  <AttachmentList items={d.attachments.filter((a: any) => a.deliveryId === dv.id)} onChanged={refresh} />
                  <UploadButtons projectId={id} deliveryId={dv.id} onUploaded={refresh} />
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {tab === 'invoice' && (
        <div className="card">
          <div className="card-title">
            <h2>請求書</h2>
            {d.activeOrder && !closed && (
              <AsyncButton className={`btn sm ${d.invoices.some((i: any) => i.status === 'issued') ? '' : 'primary'}`} onClick={createInvoice}>
                {d.invoices.some((i: any) => i.status === 'issued') ? '追加の請求書を作る' : '請求書を作る'}
              </AsyncButton>
            )}
          </div>
          {!d.activeOrder && <p className="small muted">受注を登録すると、受注内容から請求書を作成できます。</p>}
          {d.invoices.length === 0 ? (
            <Empty>請求書はありません</Empty>
          ) : (
            <div className="list">
              {d.invoices.map((i: any) => (
                <Link key={i.id} to={i.status === 'draft' ? `/invoice-versions/${i.draftVersionId}` : `/invoices/${i.id}`} className="list-item">
                  <div className="row between">
                    <span className="title">{i.number ?? '請求書（下書き）'}</span>
                    <Money v={i.status === 'draft' ? i.draftTotal : i.total} />
                  </div>
                  <div className="meta">
                    <PaymentBadge state={i.paymentState} overdue={i.overdue} status={i.status} />
                    {i.dueDate && (
                      <span>
                        期限 <DateText v={i.dueDate} />
                      </span>
                    )}
                    {i.status === 'issued' && (
                      <span>
                        残額 <Money v={i.remaining} />
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === 'files' && (
        <div className="card">
          <h2>ファイル</h2>
          <UploadButtons projectId={id} onUploaded={refresh} />
          <div style={{ marginTop: 10 }}>
            <AttachmentList items={d.attachments.filter((a: any) => !a.deliveryId)} onChanged={refresh} />
          </div>
        </div>
      )}
      {tab === 'intake' && <IntakeTab projectId={id} onChanged={refresh} />}
      {tab === 'portal' && <PortalTab projectId={id} onChanged={refresh} />}
      {tab === 'history' && <History projectId={id} events={d.events} onChanged={refresh} />}

      {modal === 'order' && !d.activeOrder && (
        <OrderModal
          d={d}
          initialVersionId={presetVersion}
          onClose={() => {
            setModal(null);
            if (params.get('action')) setParams({}, { replace: true });
          }}
          onDone={refresh}
        />
      )}
      {modal === 'delivery' && <DeliveryModal projectId={id} hasOrder={!!d.activeOrder} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'status' && <StatusModal projectId={id} current={p.status} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'decline' && latestFinal && <DeclineModal versionId={latestFinal.id} onClose={() => setModal(null)} onDone={refresh} />}
    </div>
  );
}

function DocLink({ doc, invoices, onTab }: { doc: any; invoices: any[]; deliveries: any[]; onTab: (t: Tab) => void }) {
  if (doc.type === 'quote_version') return <Link to={`/quotes/${doc.id}`}>{doc.label}</Link>;
  if (doc.type === 'invoice') {
    const inv = invoices.find((i) => i.id === doc.id);
    return <Link to={inv?.status === 'draft' ? `/invoice-versions/${inv.draftVersionId}` : `/invoices/${doc.id}`}>{doc.label}</Link>;
  }
  if (doc.type === 'delivery')
    return (
      <button className="btn ghost sm" style={{ padding: 0, minHeight: 0 }} onClick={() => onTab('delivery')}>
        {doc.label}
      </button>
    );
  return (
    <button className="btn ghost sm" style={{ padding: 0, minHeight: 0 }} onClick={() => onTab('quote')}>
      {doc.label}
    </button>
  );
}

function Overview({ d }: { d: any }) {
  const p = d.project;
  const c = d.customer;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h2>案件情報</h2>
        <dl className="kv">
          <dt>案件番号</dt>
          <dd>{p.number}</dd>
          <dt>問い合わせ日</dt>
          <dd>
            <DateText v={p.inquiryDate} />
          </dd>
          <dt>予定開始</dt>
          <dd>
            <DateText v={p.plannedStart} />
          </dd>
          <dt>予定納期</dt>
          <dd>
            <DateText v={p.plannedDue} />
          </dd>
          <dt>内部メモ</dt>
          <dd className="pre">{p.internalMemo || '—'}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>顧客</h2>
        <dl className="kv">
          <dt>会社・屋号</dt>
          <dd>
            <Link to={`/customers/${c.id}`}>{c.name}</Link>
          </dd>
          <dt>担当者</dt>
          <dd>{c.contactName ? `${c.contactName} 様` : '—'}</dd>
          <dt>電話</dt>
          <dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—'}</dd>
          <dt>メール</dt>
          <dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}</dd>
          <dt>支払条件</dt>
          <dd>{c.paymentTerms || '—'}</dd>
        </dl>
      </div>
    </div>
  );
}

function Tasks({ projectId, tasks, onChanged }: { projectId: string; tasks: any[]; onChanged: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [reqId, setReqId] = useState(newRequestId());
  const [editing, setEditing] = useState<any | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const toast = useToast();
  const move = async (idx: number, dir: -1 | 1) => {
    const ids = tasks.map((t) => t.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await put(`/api/projects/${projectId}/tasks/order`, { ids });
    await onChanged();
  };
  const presets = ['素材受領', '初稿', '顧客確認', '修正', '最終確認', '納品'];
  return (
    <div className="card">
      <h2>タスク</h2>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          try {
            await post(`/api/projects/${projectId}/tasks`, { requestId: reqId, title, dueDate: due || null });
            setTitle('');
            setDue('');
            setReqId(newRequestId());
            await onChanged();
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        }}
      >
        <input placeholder="タスク名（例：初稿）" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="タスク名" style={{ flex: '2 1 180px' }} />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="期限" style={{ flex: '1 1 140px' }} />
        <button className="btn primary" style={{ flex: '0 0 auto' }}>
          追加
        </button>
      </form>
      {tasks.length === 0 && (
        <div className="chips" style={{ marginTop: 8 }}>
          <span className="small muted">よく使うタスク：</span>
          {presets.map((t) => (
            <button key={t} className="chip" onClick={() => setTitle(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8 }} data-testid="task-list">
        {tasks.length === 0 && <Empty>タスクはありません</Empty>}
        {tasks.map((t, idx) => (
          <div key={t.id} className="file-row">
            <label className="check" style={{ flex: 1, minWidth: 0 }}>
              <input
                type="checkbox"
                checked={optimistic[t.id] ?? t.done}
                onChange={async (e) => {
                  const done = e.target.checked;
                  setOptimistic((o) => ({ ...o, [t.id]: done }));
                  try {
                    await patch(`/api/projects/${projectId}/tasks/${t.id}`, { done });
                    await onChanged();
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  } finally {
                    setOptimistic(({ [t.id]: _, ...rest }) => rest);
                  }
                }}
                aria-label={`${t.title}を完了`}
              />
              <span style={{ textDecoration: (optimistic[t.id] ?? t.done) ? 'line-through' : undefined, overflowWrap: 'anywhere' }}>
                {t.title}
                {t.dueDate && (
                  <span className="small muted">
                    {' '}
                    期限 <DateText v={t.dueDate} />
                  </span>
                )}
                {t.memo && <div className="small muted pre">{t.memo}</div>}
              </span>
            </label>
            <button className="icon-btn" aria-label="上へ" onClick={() => move(idx, -1)} disabled={idx === 0}>
              ↑
            </button>
            <button className="icon-btn" aria-label="下へ" onClick={() => move(idx, 1)} disabled={idx === tasks.length - 1}>
              ↓
            </button>
            <button className="icon-btn" aria-label="編集" onClick={() => setEditing({ ...t })}>
              ✎
            </button>
          </div>
        ))}
      </div>
      {editing && (
        <Modal title="タスクを編集" onClose={() => setEditing(null)}>
          <div className="stack">
            <Field label="タスク名">
              <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </Field>
            <Field label="期限">
              <input type="date" value={editing.dueDate ?? ''} onChange={(e) => setEditing({ ...editing, dueDate: e.target.value })} />
            </Field>
            <Field label="メモ">
              <textarea value={editing.memo} onChange={(e) => setEditing({ ...editing, memo: e.target.value })} />
            </Field>
            <div className="btn-row">
              <AsyncButton
                className="btn primary"
                onClick={async () => {
                  await patch(`/api/projects/${projectId}/tasks/${editing.id}`, { title: editing.title, dueDate: editing.dueDate || null, memo: editing.memo });
                  setEditing(null);
                  await onChanged();
                }}
              >
                保存
              </AsyncButton>
              <AsyncButton
                className="btn danger"
                confirm="このタスクを削除しますか？"
                onClick={async () => {
                  await del(`/api/projects/${projectId}/tasks/${editing.id}`);
                  setEditing(null);
                  await onChanged();
                }}
              >
                削除
              </AsyncButton>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function History({ projectId, events, onChanged }: { projectId: string; events: any[]; onChanged: () => Promise<void> }) {
  const [note, setNote] = useState('');
  return (
    <div className="card">
      <h2>履歴・メモ</h2>
      <div className="stack" style={{ gap: 6 }}>
        <textarea placeholder="打ち合わせメモなど（社内用）" value={note} onChange={(e) => setNote(e.target.value)} aria-label="メモ" />
        <AsyncButton
          className="btn"
          disabled={!note.trim()}
          onClick={async () => {
            await post(`/api/projects/${projectId}/notes`, { note });
            setNote('');
            await onChanged();
          }}
        >
          メモを追加
        </AsyncButton>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
        {events.map((e) => (
          <li key={e.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div className="small muted">{formatDateTimeJa(e.occurredAt)}</div>
            <div>{e.title}</div>
            {e.note && <div className="small pre muted">{e.note}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrderModal({ d, initialVersionId, onClose, onDone }: { d: any; initialVersionId?: string | null; onClose: () => void; onDone: () => Promise<void> }) {
  const finals = d.quoteVersions.filter((v: any) => v.status === 'final');
  const [versionId, setVersionId] = useState(finals.find((f: any) => f.id === initialVersionId)?.id ?? finals[finals.length - 1]?.id ?? '');
  const [orderDate, setOrderDate] = useState(todayIn());
  const [dueDate, setDueDate] = useState(d.project.plannedDue ?? '');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const v = finals.find((x: any) => x.id === versionId);
  return (
    <Modal title="この見積で受注" onClose={onClose}>
      <div className="stack">
        <ErrorBanner message={error} />
        <Field label="採用する見積の版">
          <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            {finals.map((f: any) => (
              <option key={f.id} value={f.id}>
                {f.number} v{f.version}（{Number(f.total).toLocaleString('ja-JP')}円）
              </option>
            ))}
          </select>
        </Field>
        <div className="banner info">
          受注金額：<strong><Money v={v ? Number(v.total) : null} /></strong>（見積の確定内容をそのまま保存します）
        </div>
        <Field label="受注日">
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} required />
        </Field>
        <Field label="納期">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="メモ（社内用）">
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
        <AsyncButton
          className="btn primary block"
          disabled={!versionId || !orderDate}
          onClick={async () => {
            try {
              await post(`/api/projects/${d.project.id}/orders`, { quoteVersionId: versionId, orderDate, dueDate: dueDate || null, memo });
              toast('受注を登録しました');
              onClose();
              await onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          受注を登録
        </AsyncButton>
      </div>
    </Modal>
  );
}

function DeliveryModal({ projectId, hasOrder, onClose, onDone }: { projectId: string; hasOrder: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ deliveredOn: todayIn(), content: '', customerComment: '', internalMemo: '', includeLines: true });
  const [reqId] = useState(newRequestId());
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Modal title="納品を記録" onClose={onClose}>
      <div className="stack">
        <ErrorBanner message={error} />
        <Field label="納品日">
          <input type="date" value={f.deliveredOn} onChange={(e) => setF({ ...f, deliveredOn: e.target.value })} />
        </Field>
        <Field label="納品内容（納品書に記載）">
          <textarea value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
        </Field>
        <Field label="顧客向けコメント（納品書に記載）">
          <textarea value={f.customerComment} onChange={(e) => setF({ ...f, customerComment: e.target.value })} />
        </Field>
        <Field label="内部メモ（納品書には載りません）">
          <textarea value={f.internalMemo} onChange={(e) => setF({ ...f, internalMemo: e.target.value })} />
        </Field>
        {hasOrder && (
          <label className="check">
            <input type="checkbox" checked={f.includeLines} onChange={(e) => setF({ ...f, includeLines: e.target.checked })} />
            受注内容（明細・金額）を納品書に記載する
          </label>
        )}
        <p className="small muted">ファイルは記録後に、この納品に添付できます。納品を記録しても請求書は作られません。</p>
        <AsyncButton
          className="btn primary block"
          onClick={async () => {
            try {
              await post(`/api/projects/${projectId}/deliveries`, { requestId: reqId, ...f });
              toast('納品を記録しました');
              onClose();
              await onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          納品を記録
        </AsyncButton>
      </div>
    </Modal>
  );
}

function StatusModal({ projectId, current, onClose, onDone }: { projectId: string; current: ProjectStatus; onClose: () => void; onDone: () => Promise<void> }) {
  const [status, setStatus] = useState<ProjectStatus>(current);
  const [note, setNote] = useState('');
  return (
    <Modal title="状態を変更" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          状態を変えても、見積書・請求書などの書類は自動では作られません。変更は履歴に残ります。
        </p>
        <Field label="状態">
          <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PROJECT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="メモ（任意）">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <AsyncButton
          className="btn primary block"
          onClick={async () => {
            await post(`/api/projects/${projectId}/status`, { status, note });
            onClose();
            await onDone();
          }}
        >
          変更する
        </AsyncButton>
      </div>
    </Modal>
  );
}

function DeclineModal({ versionId, onClose, onDone }: { versionId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="失注にする" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          案件の状態を「失注」にします。請求書は作られません。
        </p>
        <Field label="理由（任意・社内用）">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <AsyncButton
          className="btn danger solid block"
          onClick={async () => {
            await post(`/api/quote-versions/${versionId}/decline`, { reason });
            onClose();
            await onDone();
          }}
        >
          失注にする
        </AsyncButton>
      </div>
    </Modal>
  );
}
