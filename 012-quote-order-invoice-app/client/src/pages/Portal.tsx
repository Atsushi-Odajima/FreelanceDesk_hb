// FreelanceDesk クライアントポータル（顧客向け画面）。運営者のログインとは別で、招待リンクから入る。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, newRequestId, post } from '../api';
import { useApi } from '../hooks';
import { AsyncButton, DateText, Empty, ErrorBanner, Field, Loading, useToast } from '../components/ui';
import { InstructionSheet, VersionReview, VersionStatusBadge } from '../components/PortalReview';
import { formatDateTimeJa } from '../../../shared/dates';
import { intakeClientLabel } from './PortalIntake';

const API = '/api/portal';

export function Shell({ children, business, onLogout }: { children: ReactNode; business?: { name: string; brandColor: string } | null; onLogout?: boolean }) {
  const nav = useNavigate();
  return (
    <div className="portal" style={{ ['--brand' as string]: business?.brandColor ?? undefined }}>
      <header className="portal-top card no-print" style={{ borderRadius: 0, marginBottom: 12 }}>
        <div className="row between" style={{ maxWidth: 960, margin: '0 auto' }}>
          <Link to="/portal" style={{ textDecoration: 'none', color: 'inherit' }}>
            <strong>{business?.name || 'FreelanceDesk クライアントポータル'}</strong>
            {business?.name && <span className="small muted">　クライアントポータル</span>}
          </Link>
          {onLogout && (
            <AsyncButton
              className="btn sm ghost"
              onClick={async () => {
                await post(`${API}/logout`);
                nav('/portal');
              }}
            >
              ログアウト
            </AsyncButton>
          )}
        </div>
      </header>
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '0 12px 40px' }}>{children}</main>
    </div>
  );
}

export function NeedLink({ message }: { message?: string | null }) {
  return (
    <Shell>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>クライアントポータル</h1>
        <p>{message ?? '担当者から届いたリンクを開いてください。'}</p>
        <p className="small muted">リンクの有効期限が切れている場合は、担当者に再発行を依頼してください。</p>
      </div>
    </Shell>
  );
}

/** /portal/invite#t=… ：招待リンク。登録メールアドレスの確認後にポータルへ */
export function PortalInvitePage() {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t') ?? '';
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const nav = useNavigate();
  useEffect(() => {
    if (!token) {
      setError('リンクが正しくありません。届いたリンクをそのまま開いてください。');
      return;
    }
    post(`${API}/invite/inspect`, { token })
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <Shell>
      <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
        <h1 style={{ marginTop: 0 }}>クライアントポータル</h1>
        {info && (
          <p>
            <strong>{info.businessName}</strong> から「{info.projectTitle}」のポータルに招待されています。
          </p>
        )}
        <ErrorBanner message={error} />
        {info && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <Field label="メールアドレス" hint="ご登録のメールアドレスを入力してください（本人確認のため）">
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <AsyncButton
              type="submit"
              className="btn primary"
              disabled={!email}
              onClick={async () => {
                try {
                  const r = await post(`${API}/invite/redeem`, { token, email });
                  // URLからトークンを消してからポータルへ
                  history.replaceState(null, '', '/portal/invite');
                  nav(`/portal/p/${r.projectId}`, { replace: true });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              ポータルを開く
            </AsyncButton>
          </form>
        )}
      </div>
    </Shell>
  );
}

/** /portal ：閲覧できる案件の一覧 */
export function PortalHomePage() {
  const { data, error, loading, status } = useApi<any>(`${API}/me`);
  if (loading && !data) return <Loading />;
  if (status === 401) return <NeedLink />;
  if (error || !data) return <NeedLink message={error} />;
  return (
    <Shell business={data.business} onLogout>
      <h1>{data.clientName} 様</h1>
      {data.projects.length === 0 ? (
        <Empty>閲覧できる案件はありません</Empty>
      ) : (
        <div className="list">
          {data.projects.map((p: any) => (
            <Link key={p.id} className="list-item" to={`/portal/p/${p.id}`}>
              <div className="row between">
                <span className="title">{p.title}</span>
                <span className="badge blue">{p.statusLabel}</span>
              </div>
              <div className="meta">{p.number}</div>
            </Link>
          ))}
        </div>
      )}
    </Shell>
  );
}

function usePortalProject(pid: string) {
  return useApi<any>(`${API}/projects/${pid}`, [pid]);
}

/** /portal/p/:pid ：案件のポータル（状況・制作物・納品・写真セレクト・履歴） */
export function PortalProjectPage() {
  const { pid = '' } = useParams();
  const { data: d, error, loading, status } = usePortalProject(pid);
  if (loading && !d) return <Loading />;
  if (status === 401) return <NeedLink />;
  if (error || !d) return <NeedLink message={error} />;
  return (
    <Shell business={d.business} onLogout>
      <div className="card">
        <div className="small muted">{d.project.number}</div>
        <h1 style={{ margin: '4px 0' }}>{d.project.title}</h1>
        <div className="row">
          <span className="badge blue" data-testid="portal-status">
            {d.project.statusLabel}
          </span>
          {d.project.plannedDue && (
            <span className="small muted">
              納期予定 <DateText v={d.project.plannedDue} />
            </span>
          )}
        </div>
        {d.project.guidance && <div className="banner info pre">{d.project.guidance}</div>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>確認していただくもの</h2>
        {d.deliverables.length === 0 ? (
          <Empty>まだ提出されたものはありません</Empty>
        ) : (
          <div className="list">
            {d.deliverables.map((dl: any) => (
              <Link key={dl.id} className="list-item" to={`/portal/p/${pid}/v/${dl.latest.id}`}>
                <div className="row between">
                  <span className="title">
                    {dl.title} v{dl.latest.versionNumber}
                  </span>
                  <VersionStatusBadge status={dl.latest.status} label={dl.latest.statusLabel} />
                </div>
                {dl.latest.file.canPin && <img className="thumb" src={`${dl.latest.file.url}?inline=1`} alt="" loading="lazy" style={{ maxHeight: 120 }} />}
                <div className="meta">
                  提出 {formatDateTimeJa(dl.latest.submittedAt)}
                  {dl.latest.commentCount > 0 && `・コメント ${dl.latest.commentCount}件`}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {d.intakes?.length > 0 && (
        <div className="card" data-testid="portal-intakes">
          <h2 style={{ marginTop: 0 }}>ヒアリング（ご回答のお願い）</h2>
          <div className="list">
            {d.intakes.map((ik: any) => (
              <Link key={ik.id} className="list-item" to={`/portal/p/${pid}/intake/${ik.id}`}>
                <div className="row between">
                  <span className="title">{ik.title}</span>
                  <span className={`badge ${ik.status === 'ready' ? 'green' : ik.status === 'needs_client' ? 'red' : 'blue'}`}>{intakeClientLabel(ik.status)}</span>
                </div>
                <div className="meta">
                  必要項目 {ik.progress?.submitted ?? 0}/{ik.progress?.denominator ?? 0} 提出済み
                  {ik.dueDate && (
                    <>
                      ・回答期限 <DateText v={ik.dueDate} />
                    </>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {d.selections.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>写真セレクト</h2>
          <div className="list">
            {d.selections.map((s: any) => (
              <Link key={s.id} className="list-item" to={`/portal/p/${pid}/select/${s.id}`}>
                <div className="row between">
                  <span className="title">{s.title}</span>
                  <span className={`badge ${s.status === 'open' ? 'blue' : ''}`}>{s.statusLabel}</span>
                </div>
                <div className="meta">
                  {s.photoCount}枚・選択中 {s.myPickCount}枚{s.submittedAt ? '・送信済み' : ''}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>納品</h2>
        {d.deliveries.length === 0 ? (
          <Empty>公開された納品はまだありません</Empty>
        ) : (
          d.deliveries.map((dv: any) => (
            <div key={dv.id} className="comment" data-testid="portal-delivery">
              <strong>
                {dv.number}・<DateText v={dv.deliveredOn} />
              </strong>
              {dv.portalMessage && <div className="pre">{dv.portalMessage}</div>}
              {dv.content && <div className="pre small">内容：{dv.content}</div>}
              {dv.customerComment && <div className="pre small">{dv.customerComment}</div>}
              <div className="btn-row" style={{ marginTop: 6 }}>
                <a className="btn sm" href={dv.pdfUrl} target="_blank" rel="noreferrer">
                  納品書（PDF）
                </a>
                {dv.versions.map((v: any) => (
                  <a key={v.versionId} className="btn sm" href={v.file.url}>
                    {v.label}（{v.file.filename}）
                  </a>
                ))}
                {dv.files.map((f: any) => (
                  <a key={f.id} className="btn sm" href={f.url}>
                    {f.filename}
                  </a>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>これまでの経過</h2>
        {d.events.length === 0 ? (
          <Empty>まだ記録はありません</Empty>
        ) : (
          <ul className="small" style={{ paddingLeft: 18 }}>
            {d.events.map((e: any) => (
              <li key={e.id}>
                {formatDateTimeJa(e.occurredAt)}　{e.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}

function ClientActions({ d, reload, pid }: { d: any; reload: () => Promise<void>; pid: string }) {
  const key = useRef(newRequestId());
  const [comment, setComment] = useState('');
  const [cr, setCr] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const toast = useToast();
  const v = d.version;
  const canAct = d.isLatest && (v.status === 'in_review' || v.status === 'changes_requested');
  const handleStale = async (e: unknown) => {
    if (e instanceof ApiError && e.code === 'stale_version') {
      setMsg(e.message);
      await reload();
      return;
    }
    throw e;
  };
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>確認結果</h3>
      <ErrorBanner message={msg} />
      {v.approval ? (
        <div className="banner ok">
          {formatDateTimeJa(v.approval.approvedAt)} に {v.approval.clientName} 様が承認しました。
        </div>
      ) : !canAct ? (
        <p className="small muted">この版は現在、承認・修正依頼の対象ではありません。</p>
      ) : (
        <div className="stack">
          <Field label="承認時のひとこと（任意）">
            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
          </Field>
          <AsyncButton
            className="btn primary"
            confirm={`「${d.deliverable.title} v${v.versionNumber}」を承認しますか？（電子契約ではありません。承認の記録として残ります）`}
            onClick={async () => {
              try {
                await post(`${API}/projects/${pid}/versions/${v.id}/approve`, { idempotencyKey: key.current, expectedVersionNumber: v.versionNumber, comment });
                toast('承認しました');
                await reload();
              } catch (e) {
                await handleStale(e);
              }
            }}
          >
            この版を承認する
          </AsyncButton>
          <hr />
          <Field label="修正のご依頼" hint="画像に置いた未対応の修正指示（ピン）も一緒に担当者へ届きます">
            <textarea rows={3} value={cr} onChange={(e) => setCr(e.target.value)} maxLength={4000} />
          </Field>
          <AsyncButton
            className="btn"
            disabled={!cr.trim()}
            onClick={async () => {
              try {
                const r = await post(`${API}/projects/${pid}/versions/${v.id}/change-requests`, { body: cr });
                setCr('');
                toast(`修正を依頼しました（修正指示 ${r.pinCount}件）`);
                await reload();
              } catch (e) {
                await handleStale(e);
              }
            }}
          >
            修正を依頼する
          </AsyncButton>
        </div>
      )}
    </div>
  );
}

/** /portal/p/:pid/v/:vid ：版の確認・修正指示・承認 */
export function PortalVersionPage() {
  const { pid = '', vid = '' } = useParams();
  const { data: me, status } = usePortalProject(pid);
  if (status === 401) return <NeedLink />;
  if (status === 404) return <NeedLink message="ページが見つかりません" />;
  return (
    <Shell business={me?.business} onLogout>
      <p className="no-print">
        <Link to={`/portal/p/${pid}`}>← {me?.project?.title ?? '案件'} に戻る</Link>
      </p>
      <VersionReview apiBase={`${API}/projects/${pid}`} linkBase={`/portal/p/${pid}`} versionId={vid} audience="client" actions={(d, reload) => <ClientActions d={d} reload={reload} pid={pid} />} />
    </Shell>
  );
}

export function PortalSheetPage() {
  const { pid = '', vid = '' } = useParams();
  const [params] = useSearchParams();
  const { data: me } = usePortalProject(pid);
  return (
    <Shell business={me?.business}>
      <InstructionSheet apiBase={`${API}/projects/${pid}`} versionId={vid} changeRequestId={params.get('cr')} backTo={`/portal/p/${pid}/v/${vid}`} />
    </Shell>
  );
}

/** /portal/p/:pid/select/:sid ：FreelanceDesk 写真セレクト（クリック or 番号入力で選んで送信） */
export function PortalSelectionPage() {
  const { pid = '', sid = '' } = useParams();
  const base = `${API}/projects/${pid}/selections/${sid}`;
  const { data: d, error, loading, reload, status } = useApi<any>(base, [base]);
  const { data: me } = usePortalProject(pid);
  const [numbers, setNumbers] = useState('');
  const [check, setCheck] = useState<any>(null);
  const [note, setNote] = useState<string | null>(null);
  const toast = useToast();
  if (status === 401) return <NeedLink />;
  if (loading && !d) return <Loading />;
  if (error || !d) return <NeedLink message={error} />;
  const open = d.set.status === 'open';
  const picked = d.photos.filter((p: any) => p.picked);
  const save = async (photoIds: string[]) => {
    await post(`${base}/picks`, { photoIds });
    await reload();
  };
  return (
    <Shell business={me?.business} onLogout>
      <p>
        <Link to={`/portal/p/${pid}`}>← {me?.project?.title ?? '案件'} に戻る</Link>
      </p>
      <div className="card">
        <div className="row between">
          <h1 style={{ margin: 0 }}>{d.set.title}</h1>
          <span className={`badge ${open ? 'blue' : ''}`}>{d.set.statusLabel}</span>
        </div>
        {d.set.message && <div className="pre" style={{ marginTop: 6 }}>{d.set.message}</div>}
        <p className="small muted">
          写真をタップして選ぶか、番号（例：001, 007、012）を入力してください。選択はその都度保存されます。
        </p>
        <div className="row">
          <strong data-testid="pick-count">選択中 {picked.length}枚</strong>
          {picked.length > 0 && <span className="small muted">（{picked.map((p: any) => p.number).join(', ')}）</span>}
        </div>
        {d.myResponse.submittedAt && (
          <div className={`banner ${d.myResponse.changedAfterSubmit ? 'warn' : 'ok'}`}>
            {formatDateTimeJa(d.myResponse.submittedAt)} に送信済み{d.myResponse.changedAfterSubmit ? '（その後に選択を変更しています。もう一度送信してください）' : ''}
          </div>
        )}
      </div>

      {open && (
        <div className="card">
          <Field label="番号で選ぶ">
            <textarea rows={2} value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="001, 007、012" />
          </Field>
          <div className="btn-row">
            {(['add', 'replace'] as const).map((mode) => (
              <AsyncButton
                key={mode}
                className={`btn ${mode === 'add' ? 'primary' : ''}`}
                disabled={!numbers.trim()}
                onClick={async () => {
                  const r = await post(`${base}/picks`, { numbersText: numbers, mode });
                  setCheck(r.check);
                  await reload();
                }}
              >
                {mode === 'add' ? '選択に追加' : 'この番号だけにする'}
              </AsyncButton>
            ))}
          </div>
          {check && (
            <div className="small" data-testid="number-check" style={{ marginTop: 8 }}>
              {check.results.filter((r: any) => r.found).length > 0 && <div>選択：{check.results.filter((r: any) => r.found).map((r: any) => r.label).join(', ')}</div>}
              {check.results.some((r: any) => !r.found) && (
                <div className="err">該当する写真がない番号：{check.results.filter((r: any) => !r.found).map((r: any) => r.label).join(', ')}</div>
              )}
              {check.invalid.length > 0 && <div className="err">読み取れなかった文字：{check.invalid.join(' ')}</div>}
              {check.duplicates.length > 0 && <div>重複して入力された番号：{check.duplicates.map((x: any) => `${x.label}（${x.count}回）`).join(', ')}</div>}
            </div>
          )}
        </div>
      )}

      <div className="photo-grid" style={{ margin: '12px 0' }}>
        {d.photos.map((p: any) => (
          <button
            key={p.id}
            type="button"
            className={`photo-cell ${p.picked ? 'picked' : ''}`}
            aria-pressed={p.picked}
            disabled={!open}
            onClick={async () => {
              const ids = d.photos.filter((x: any) => (x.id === p.id ? !x.picked : x.picked)).map((x: any) => x.id);
              try {
                await save(ids);
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }}
          >
            <img src={`${p.url}?inline=1`} alt={`写真 ${p.number}`} loading="lazy" />
            <span className="mark">{p.picked ? '✓' : ''}</span>
            <span className="cap">
              <span className="num">{p.number}</span>
              {p.name && <span className="muted">{p.name}</span>}
            </span>
          </button>
        ))}
      </div>

      {open && (
        <div className="card">
          <Field label="担当者へのコメント（任意）">
            <textarea rows={2} value={note ?? d.myResponse.note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
          <AsyncButton
            className="btn primary"
            disabled={picked.length === 0}
            confirm={`${picked.length}枚を選んで送信しますか？`}
            onClick={async () => {
              await post(`${base}/submit`, { note: note ?? d.myResponse.note });
              toast('送信しました');
              await reload();
            }}
          >
            選んだ写真を送信する
          </AsyncButton>
        </div>
      )}
    </Shell>
  );
}
