// FreelanceDesk クライアントポータル（運営者側）：案件詳細の「クライアントポータル」タブと、版の確認・修正指示書・写真セレクトの画面
import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, del, newRequestId, patch, post, put } from '../api';
import { useApi } from '../hooks';
import { AsyncButton, DateText, Empty, ErrorBanner, Field, Loading, useToast } from '../components/ui';
import { InstructionSheet, VersionReview, VersionStatusBadge } from '../components/PortalReview';
import { formatDateTimeJa } from '../../../shared/dates';

const INVITE_STATE: Record<string, [string, string]> = {
  active: ['有効', 'green'],
  expired: ['期限切れ', ''],
  revoked: ['失効', ''],
  locked: ['ロック（確認失敗）', 'red'],
  stopped: ['アクセス停止', 'red'],
};
const PORTAL_STATUS: Record<string, string> = { draft: '準備中（お客様は見られません）', published: '公開中', closed: '公開終了' };

async function uploadFiles(url: string, files: FileList, extra: Record<string, string>, onEach: (name: string) => void) {
  const errors: string[] = [];
  let ok = 0;
  for (const f of Array.from(files)) {
    onEach(f.name);
    const fd = new FormData();
    fd.append('file', f);
    fd.append('requestId', newRequestId());
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    try {
      await api('POST', url, fd);
      ok++;
    } catch (e) {
      errors.push(`${f.name}：${(e as Error).message}`);
    }
  }
  return { ok, errors };
}

function FilePickButton({ label, accept, multiple, onFiles, testId }: { label: string; accept?: string; multiple?: boolean; onFiles: (f: FileList) => Promise<void>; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn sm" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? 'アップロード中…' : label}
      </button>
      <input
        ref={ref}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        data-testid={testId}
        onChange={async (e) => {
          if (!e.target.files?.length) return;
          setBusy(true);
          try {
            await onFiles(e.target.files);
          } finally {
            setBusy(false);
            if (ref.current) ref.current.value = '';
          }
        }}
      />
    </>
  );
}

/** 案件詳細の「クライアントポータル」タブ */
export function PortalTab({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
  const base = `/api/projects/${projectId}/portal`;
  const { data: d, error, loading, reload } = useApi<any>(base, [projectId]);
  const toast = useToast();
  const [settings, setSettings] = useState<any>(null);
  const [days, setDays] = useState(14);
  const [issued, setIssued] = useState<string | null>(null);
  const [newDeliverable, setNewDeliverable] = useState('');
  const [newSel, setNewSel] = useState({ title: '', message: '', showNames: true });
  const [publishSel, setPublishSel] = useState<Record<string, string[]>>({});
  const [publishMsg, setPublishMsg] = useState<Record<string, string>>({});
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBanner message={error} />;
  const st = settings ?? d.portal;
  const refresh = async () => {
    await reload();
    onChanged?.();
  };
  const approvedVersions = d.deliverables.flatMap((dl: any) => dl.versions.filter((v: any) => v.approval).map((v: any) => ({ ...v, title: dl.title })));

  return (
    <div className="stack" data-testid="portal-tab">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>FreelanceDesk クライアントポータル</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          お客様（{d.customer.name}）専用のページです。制作物の確認・修正指示・承認、納品データの受け取り、写真セレクトができます。
        </p>
        <div className="grid cols-2">
          <Field label="公開状態">
            <select value={st.status} onChange={(e) => setSettings({ ...st, status: e.target.value })} data-testid="portal-status-select">
              {Object.entries(PORTAL_STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="お客様に見せる状況" hint="空欄なら案件の状態（作業中など）を表示">
            <input value={st.statusLabel} maxLength={40} onChange={(e) => setSettings({ ...st, statusLabel: e.target.value })} />
          </Field>
        </div>
        <Field label="お客様へのご案内">
          <textarea rows={2} value={st.guidance} maxLength={2000} onChange={(e) => setSettings({ ...st, guidance: e.target.value })} />
        </Field>
        <AsyncButton
          className="btn primary sm"
          disabled={!settings}
          onClick={async () => {
            await put(base, settings);
            setSettings(null);
            toast('保存しました');
            await refresh();
          }}
        >
          設定を保存
        </AsyncButton>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>招待リンク</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          送り先：{d.customer.email || '（顧客のメールアドレスが未登録です）'}。リンクを開いた人に、このメールアドレスの入力を求めます（5回失敗でリンクを無効化）。リンクはメールやLINEで送ってください。
        </p>
        <div className="row">
          <label className="row small">
            有効期限
            <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value) || 14)} style={{ width: 70 }} />日
          </label>
          <AsyncButton
            className="btn sm primary"
            onClick={async () => {
              const r = await post(`${base}/invites`, { expiresInDays: days });
              setIssued(`${window.location.origin}${r.path}`);
              await reload();
            }}
          >
            {d.invites.some((i: any) => i.state === 'active') ? '再発行（旧リンクは無効）' : '招待リンクを発行'}
          </AsyncButton>
          {d.invites.length > 0 && (
            <AsyncButton
              className="btn sm danger"
              confirm="すべての招待リンクを無効にし、リンクから入った端末もこの案件を見られなくします。よろしいですか？"
              onClick={async () => {
                await post(`${base}/stop-access`);
                setIssued(null);
                await reload();
              }}
            >
              アクセス停止
            </AsyncButton>
          )}
        </div>
        {issued && (
          <div className="banner ok" style={{ marginTop: 8 }}>
            <div className="small">このリンクは今だけ表示されます。コピーしてお客様に送ってください。</div>
            <div className="invite-url" data-testid="invite-url">
              {issued}
            </div>
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(issued).then(() => toast('コピーしました'))}>
              コピー
            </button>
          </div>
        )}
        {d.invites.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table small">
              <thead>
                <tr>
                  <th>発行</th>
                  <th>期限</th>
                  <th>状態</th>
                  <th>使用</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.invites.map((i: any) => (
                  <tr key={i.id}>
                    <td>{formatDateTimeJa(i.createdAt)}</td>
                    <td>{formatDateTimeJa(i.expiresAt)}</td>
                    <td>
                      <span className={`badge ${INVITE_STATE[i.state][1]}`}>{INVITE_STATE[i.state][0]}</span>
                    </td>
                    <td>
                      {i.useCount}回{i.failedAttempts > 0 && `（確認失敗${i.failedAttempts}）`}
                    </td>
                    <td>
                      {i.state === 'active' && (
                        <AsyncButton
                          className="btn sm"
                          onClick={async () => {
                            await post(`${base}/invites/${i.id}/revoke`);
                            await reload();
                          }}
                        >
                          失効
                        </AsyncButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>制作物（確認・承認）</h3>
        <div className="row">
          <input placeholder="例：トップページ デザイン" value={newDeliverable} onChange={(e) => setNewDeliverable(e.target.value)} maxLength={120} aria-label="制作物名" />
          <AsyncButton
            className="btn sm"
            disabled={!newDeliverable.trim()}
            onClick={async () => {
              await post(`${base}/deliverables`, { title: newDeliverable });
              setNewDeliverable('');
              await reload();
            }}
          >
            制作物を追加
          </AsyncButton>
        </div>
        {d.deliverables.length === 0 && <Empty>制作物を追加し、ファイルを「版」として提出するとお客様が確認できます</Empty>}
        {d.deliverables.map((dl: any) => (
          <div key={dl.id} className="comment" data-testid="deliverable">
            <div className="row between">
              <strong>{dl.title}</strong>
              <FilePickButton
                label={dl.versions.length ? '新しい版を提出' : 'ファイルを提出（v1）'}
                testId={`version-file-${dl.title}`}
                onFiles={async (files) => {
                  const r = await uploadFiles(`${base}/deliverables/${dl.id}/versions`, files, {}, () => undefined);
                  r.errors.forEach((m) => toast(m, 'error'));
                  if (r.ok) toast('提出しました');
                  await refresh();
                }}
              />
            </div>
            {dl.versions.length === 0 ? (
              <div className="small muted">まだ提出していません</div>
            ) : (
              <ul className="small" style={{ paddingLeft: 18, margin: '6px 0' }}>
                {dl.versions.map((v: any) => (
                  <li key={v.id}>
                    <Link to={`/projects/${projectId}/portal/v/${v.id}`}>v{v.versionNumber}</Link>　<VersionStatusBadge status={v.status} label={v.statusLabel} />　{v.file.filename}
                    {v.commentCount > 0 && `・コメント${v.commentCount}`}
                    {v.openPinCount > 0 && `・未対応の修正指示${v.openPinCount}`}
                    {v.changeRequestCount > 0 && `・修正依頼${v.changeRequestCount}`}
                    {v.approval && `・${v.approval.clientName}様が承認`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>納品の公開</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          「納品」タブで記録した納品（納品書PDF・添付ファイル）と、承認済みの版をポータルで公開します。
        </p>
        {d.deliveries.length === 0 && <Empty>納品記録はありません（「納品」タブで記録できます）</Empty>}
        {d.deliveries.map((dv: any) => (
          <div key={dv.id} className="comment" data-testid="portal-delivery-op">
            <div className="row between">
              <strong>
                {dv.number}・<DateText v={dv.deliveredOn} />
              </strong>
              <span className={`badge ${dv.portalStatus === 'published' ? 'green' : ''}`}>{{ private: '非公開', published: '公開中', withdrawn: '取り下げ済み' }[dv.portalStatus as string]}</span>
            </div>
            <div className="small muted">添付 {dv.files.length}件{dv.versions.length > 0 && `・公開中の版：${dv.versions.map((v: any) => v.label).join('、')}`}</div>
            {dv.portalStatus === 'published' ? (
              <AsyncButton
                className="btn sm"
                onClick={async () => {
                  await post(`${base}/deliveries/${dv.id}/withdraw`);
                  await refresh();
                }}
              >
                公開を取り下げる
              </AsyncButton>
            ) : (
              <div className="stack" style={{ gap: 4 }}>
                {approvedVersions.map((v: any) => (
                  <label key={v.id} className="check small">
                    <input
                      type="checkbox"
                      checked={(publishSel[dv.id] ?? []).includes(v.id)}
                      onChange={(e) =>
                        setPublishSel({ ...publishSel, [dv.id]: e.target.checked ? [...(publishSel[dv.id] ?? []), v.id] : (publishSel[dv.id] ?? []).filter((x) => x !== v.id) })
                      }
                    />
                    {v.title} v{v.versionNumber}（承認済み）を含める
                  </label>
                ))}
                <input placeholder="お客様へのメッセージ（任意）" value={publishMsg[dv.id] ?? ''} onChange={(e) => setPublishMsg({ ...publishMsg, [dv.id]: e.target.value })} />
                <AsyncButton
                  className="btn sm primary"
                  onClick={async () => {
                    await post(`${base}/deliveries/${dv.id}/publish`, { versionIds: publishSel[dv.id] ?? [], message: publishMsg[dv.id] ?? '' });
                    toast('ポータルで公開しました');
                    await refresh();
                  }}
                >
                  ポータルで公開
                </AsyncButton>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>FreelanceDesk 写真セレクト</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          写真に 001 からの番号を付けてお客様に選んでもらいます。公開後は番号が変わりません。
        </p>
        {d.selections.map((s: any) => (
          <Link key={s.id} className="list-item" to={`/projects/${projectId}/portal/select/${s.id}`}>
            <div className="row between">
              <span className="title">{s.title}</span>
              <span className={`badge ${s.status === 'open' ? 'blue' : ''}`}>{s.statusLabel}</span>
            </div>
            <div className="meta">
              {s.photoCount}枚{s.submittedCount > 0 && `・送信 ${s.submittedCount}件`}
            </div>
          </Link>
        ))}
        <div className="grid cols-2" style={{ marginTop: 8 }}>
          <Field label="セレクト名">
            <input value={newSel.title} maxLength={120} onChange={(e) => setNewSel({ ...newSel, title: e.target.value })} />
          </Field>
          <Field label="お客様へのメッセージ">
            <input value={newSel.message} maxLength={2000} onChange={(e) => setNewSel({ ...newSel, message: e.target.value })} />
          </Field>
        </div>
        <label className="check small">
          <input type="checkbox" checked={newSel.showNames} onChange={(e) => setNewSel({ ...newSel, showNames: e.target.checked })} /> 元のファイル名をお客様に表示する
        </label>
        <AsyncButton
          className="btn sm"
          disabled={!newSel.title.trim()}
          onClick={async () => {
            await post(`${base}/selections`, newSel);
            setNewSel({ title: '', message: '', showNames: true });
            await reload();
          }}
        >
          写真セレクトを作成
        </AsyncButton>
      </div>
    </div>
  );
}

function OpApprovalActions({ d, reload, projectId }: { d: any; reload: () => Promise<void>; projectId: string }) {
  const active = d.approvals.find((a: any) => !a.revokedAt);
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>承認</h3>
      {d.approvals.length === 0 && <p className="small muted">まだ承認されていません。</p>}
      {d.approvals.map((a: any) => (
        <div key={a.id} className="small">
          {formatDateTimeJa(a.approvedAt)}　{a.clientName}様が v{a.versionNumber} を承認{a.comment && `「${a.comment}」`}
          {a.revokedAt && `（${formatDateTimeJa(a.revokedAt)} 取消：${a.revokeReason}）`}
        </div>
      ))}
      {active && (
        <AsyncButton
          className="btn sm danger"
          onClick={async () => {
            const reason = window.prompt('承認を取り消す理由を入力してください');
            if (!reason) return;
            await post(`/api/projects/${projectId}/portal/approvals/${active.id}/revoke`, { reason });
            await reload();
          }}
        >
          承認を取り消す
        </AsyncButton>
      )}
    </div>
  );
}

/** /projects/:id/portal/v/:vid */
export function OpVersionPage() {
  const { id = '', vid = '' } = useParams();
  return (
    <div>
      <p className="no-print">
        <Link to={`/projects/${id}?tab=portal`}>← 案件のクライアントポータルに戻る</Link>
      </p>
      <VersionReview
        apiBase={`/api/projects/${id}/portal`}
        linkBase={`/projects/${id}/portal`}
        versionId={vid}
        audience="operator"
        actions={(d, reload) => <OpApprovalActions d={d} reload={reload} projectId={id} />}
      />
    </div>
  );
}

export function OpSheetPage() {
  const { id = '', vid = '' } = useParams();
  const [params] = useSearchParams();
  return <InstructionSheet apiBase={`/api/projects/${id}/portal`} versionId={vid} changeRequestId={params.get('cr')} backTo={`/projects/${id}/portal/v/${vid}`} />;
}

/** /projects/:id/portal/select/:sid ：写真セレクトの管理 */
export function OpSelectionPage() {
  const { id = '', sid = '' } = useParams();
  const base = `/api/projects/${id}/portal/selections/${sid}`;
  const { data: d, error, loading, reload } = useApi<any>(base, [base]);
  const [checked, setChecked] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const toast = useToast();
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBanner message={error} />;
  const draft = d.set.status === 'draft';
  return (
    <div className="stack">
      <p>
        <Link to={`/projects/${id}?tab=portal`}>← 案件のクライアントポータルに戻る</Link>
      </p>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{d.set.title}</h2>
          <span className={`badge ${d.set.status === 'open' ? 'blue' : ''}`}>{d.set.statusLabel}</span>
        </div>
        {d.set.message && <div className="pre small">{d.set.message}</div>}
        <div className="small muted">
          {d.set.photoCount}枚・元ファイル名を{d.set.showNames ? '表示' : '非表示'}
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <FilePickButton
            label="写真を追加"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            testId="selection-files"
            onFiles={async (files) => {
              const r = await uploadFiles(`${base}/photos`, files, {}, (n) => setProgress(`${n} を登録中…`));
              setProgress(null);
              r.errors.forEach((m) => toast(m, 'error'));
              if (r.ok) toast(`${r.ok}枚を登録しました`);
              await reload();
            }}
          />
          {d.set.status !== 'open' && (
            <AsyncButton
              className="btn sm primary"
              confirm={draft ? '公開すると番号が固定され、並べ替え・削除ができなくなります。公開しますか？' : undefined}
              onClick={async () => {
                await post(`${base}/status`, { status: 'open' });
                await reload();
              }}
            >
              {draft ? 'お客様に公開（選択受付を開始）' : '受付を再開'}
            </AsyncButton>
          )}
          {d.set.status === 'open' && (
            <AsyncButton
              className="btn sm"
              onClick={async () => {
                await post(`${base}/status`, { status: 'closed' });
                await reload();
              }}
            >
              受付を終了
            </AsyncButton>
          )}
          {draft && (
            <>
              <AsyncButton
                className="btn sm"
                onClick={async () => {
                  await post(`${base}/sort-by-name`);
                  await reload();
                }}
              >
                ファイル名順に並べる
              </AsyncButton>
              <AsyncButton
                className="btn sm danger"
                disabled={checked.length === 0}
                confirm={`${checked.length}枚を削除しますか？`}
                onClick={async () => {
                  await post(`${base}/photos/delete`, { photoIds: checked });
                  setChecked([]);
                  await reload();
                }}
              >
                選んだ写真を削除
              </AsyncButton>
              <AsyncButton
                className="btn sm ghost"
                confirm="このセレクトを削除しますか？"
                onClick={async () => {
                  await del(base);
                  history.back();
                }}
              >
                セレクトを削除
              </AsyncButton>
            </>
          )}
          {d.set.status !== 'draft' && (
            <AsyncButton
              className="btn sm ghost"
              onClick={async () => {
                const v = !d.set.showNames;
                await patch(base, { showNames: v });
                await reload();
              }}
            >
              元ファイル名を{d.set.showNames ? '非表示' : '表示'}にする
            </AsyncButton>
          )}
        </div>
        {progress && <div className="small muted">{progress}</div>}
        <div className="btn-row" style={{ marginTop: 8 }}>
          <a className="btn sm" href={`${base}/export?kind=map&format=csv`}>
            番号対応表CSV
          </a>
          <a className="btn sm" href={`${base}/export?kind=picks&format=csv`}>
            選択結果CSV
          </a>
          <a className="btn sm" href={`${base}/export?kind=picks&format=txt`}>
            選択結果テキスト
          </a>
        </div>
      </div>

      {d.responses.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>お客様の選択</h3>
          {d.responses.map((r: any) => (
            <div key={r.customerId} className="comment" data-testid="selection-response">
              <strong>{r.clientName}</strong>
              <span className="small muted">
                {r.submittedAt ? `${formatDateTimeJa(r.submittedAt)} 送信` : '未送信（選択中）'}
                {r.changedAfterSubmit && '・送信後に変更あり'}
              </span>
              <div className="small">{r.picks.length ? r.picks.map((p: any) => `${p.number} → ${p.name}`).join('\n') : '（選択なし）'}</div>
              {r.note && <div className="pre small">コメント：{r.note}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="photo-grid">
        {d.photos.map((p: any) => (
          <div key={p.id} className={`photo-cell ${p.picked ? 'picked' : ''}`}>
            <img src={`${p.url}?inline=1`} alt={`写真 ${p.number}`} loading="lazy" />
            {p.picked && <span className="mark">✓</span>}
            <span className="cap">
              {draft && (
                <input
                  type="checkbox"
                  aria-label={`${p.number}を選択`}
                  checked={checked.includes(p.id)}
                  onChange={(e) => setChecked(e.target.checked ? [...checked, p.id] : checked.filter((x) => x !== p.id))}
                />
              )}
              <span className="num">{p.number}</span>
              <span className="muted">{p.name}</span>
              {p.sameName && <span className="badge yellow">同名あり</span>}
            </span>
            {draft && (
              <span className="cap">
                <select
                  aria-label="番号を移動"
                  value=""
                  onChange={async (e) => {
                    if (!e.target.value) return;
                    await post(`${base}/photos/${p.id}/move`, { toNumber: Number(e.target.value) });
                    await reload();
                  }}
                >
                  <option value="">番号を移動…</option>
                  {d.photos.map((_: any, i: number) => (
                    <option key={i} value={i + 1}>
                      {String(i + 1).padStart(3, '0')} へ
                    </option>
                  ))}
                </select>
              </span>
            )}
          </div>
        ))}
      </div>
      {d.photos.length === 0 && <Empty>写真を追加してください（JPEG / PNG / GIF / WebP、1枚 10MB まで・最大300枚）</Empty>}
    </div>
  );
}
