// FreelanceDesk クライアントポータル：版の確認（画像＋ピン＝FreelanceDesk 修正指示）・コメント・指示書の共通部品。
// 運営者画面と顧客ポータルの両方から使う（APIの基点URLだけが異なる）。
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { del, post } from '../api';
import { AsyncButton, ErrorBanner, Loading, useToast } from './ui';
import { useApi } from '../hooks';
import { PIN_PRESETS, PIN_TYPES, applyPreset, type PinType } from '../../../shared/correctionSheet';
import { formatDateTimeJa } from '../../../shared/dates';

export interface Pin {
  x: number;
  y: number;
  number: number | string;
  type?: string;
  resolved?: boolean;
}

/** 画像の上に番号付きマーカーを重ねる。onPlace を渡すとクリック位置（0〜1の相対座標）を返す */
export function PinnedImage({ src, pins, draft, onPlace, alt }: { src: string; pins: Pin[]; draft?: { x: number; y: number } | null; onPlace?: (x: number, y: number) => void; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  return (
    <div
      className={`pin-wrap ${onPlace ? 'placing' : ''}`}
      onClick={(e) => {
        if (!onPlace || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
        onPlace(Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000);
      }}
      data-testid="pin-image"
    >
      <img ref={ref} src={src} alt={alt} draggable={false} />
      {pins.map((p) => (
        <span key={String(p.number)} className={`pin ${p.type === 'keep' ? 'keep' : ''} ${p.resolved ? 'resolved' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
          {p.number}
        </span>
      ))}
      {draft && (
        <span className="pin draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}>
          ＋
        </span>
      )}
    </div>
  );
}

export const VersionStatusBadge = ({ status, label }: { status: string; label: string }) => {
  const color = status === 'approved' ? 'green' : status === 'changes_requested' ? 'yellow' : status === 'in_review' ? 'blue' : '';
  return <span className={`badge ${color}`}>{label}</span>;
};

function Preview({ file, children }: { file: any; children?: ReactNode }) {
  if (file.canPin) return <>{children}</>;
  if (file.mime === 'application/pdf')
    return (
      <p>
        <a className="btn" href={`${file.url}?inline=1`} target="_blank" rel="noreferrer">
          PDFを開く（{file.filename}）
        </a>
      </p>
    );
  if (file.mime.startsWith('image/'))
    return <img src={`${file.url}?inline=1`} alt={file.filename} style={{ maxWidth: '100%' }} />;
  return (
    <p>
      <a className="btn" href={file.url}>
        {file.filename} をダウンロード
      </a>
    </p>
  );
}

/**
 * 版の確認画面の本体。
 * apiBase: 運営者 `/api/projects/:pid/portal` / 顧客 `/api/portal/projects/:pid`
 * linkBase: 画面URLの基点（版の切替・指示書へのリンク）
 */
export function VersionReview({
  apiBase,
  linkBase,
  versionId,
  audience,
  actions,
}: {
  apiBase: string;
  linkBase: string;
  versionId: string;
  audience: 'operator' | 'client';
  actions?: (d: any, reload: () => Promise<void>) => ReactNode;
}) {
  const { data: d, error, loading, reload } = useApi<any>(`${apiBase}/versions/${versionId}`, [versionId]);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [body, setBody] = useState('');
  const [pinType, setPinType] = useState<PinType>('change');
  const toast = useToast();
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBanner message={error ?? '読み込めませんでした'} />;
  const file = d.version.file;
  const pins: Pin[] = d.comments.filter((c: any) => c.pin && !c.deleted).map((c: any) => ({ ...c.pin, resolved: c.resolved }));
  const roots = d.comments.filter((c: any) => !c.parentId);

  const send = async () => {
    await post(`${apiBase}/versions/${versionId}/comments`, { body, pin: draft, pinType: draft ? pinType : null });
    setBody('');
    setDraft(null);
    setPinMode(false);
    toast(draft ? '修正指示を追加しました' : 'コメントを送信しました');
    await reload();
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="row between wrap">
          <h2 style={{ margin: 0 }}>
            {d.deliverable.title} v{d.version.versionNumber}
          </h2>
          <VersionStatusBadge status={d.version.status} label={d.version.statusLabel} />
        </div>
        {d.versions.length > 1 && (
          <div className="chips" style={{ marginTop: 8 }}>
            {d.versions.map((v: any) => (
              <Link key={v.id} to={`${linkBase}/v/${v.id}`} className={`chip ${v.id === versionId ? 'active' : ''}`}>
                v{v.versionNumber}
              </Link>
            ))}
          </div>
        )}
        {!d.isLatest && (
          <div className="banner warn" role="status">
            この版は旧版です。<Link to={`${linkBase}/v/${d.latestVersionId}`}>最新版（v{d.latestVersionNumber}）を確認する</Link>
          </div>
        )}
        {d.version.note && <div className="pre small">{d.version.note}</div>}
        <div className="small muted">
          提出 {formatDateTimeJa(d.version.submittedAt)}・{file.filename}
        </div>
      </div>

      <div className="card">
        <Preview file={file}>
          <PinnedImage
            src={`${file.url}?inline=1`}
            alt={file.filename}
            pins={pins}
            draft={draft}
            onPlace={pinMode ? (x, y) => setDraft({ x, y }) : undefined}
          />
        </Preview>
        <div className="btn-row" style={{ marginTop: 8 }}>
          {file.canPin && (
            <button className={`btn sm ${pinMode ? 'primary' : ''}`} onClick={() => (setPinMode(!pinMode), setDraft(null))}>
              {pinMode ? 'ピンを置くのをやめる' : '画像に修正指示（ピン）を置く'}
            </button>
          )}
          <Link className="btn sm" to={`${linkBase}/v/${versionId}/sheet`}>
            修正指示書を見る
          </Link>
          <a className="btn sm" href={file.url}>
            ダウンロード
          </a>
        </div>
        {pinMode && !draft && <p className="small muted">画像の直したい場所をタップしてください。</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{draft ? '修正指示（ピン）' : 'コメント'}</h3>
        {draft && (
          <>
            <div className="chips" role="radiogroup" aria-label="指示の種類">
              {PIN_TYPES.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={pinType === t.id} className={`chip ${pinType === t.id ? 'active' : ''}`} onClick={() => setPinType(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="chips" style={{ marginTop: 6 }}>
              {PIN_PRESETS.map((p) => (
                <button
                  key={p.text}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setBody((b) => applyPreset(b, p.text));
                    setPinType(p.type);
                  }}
                >
                  {p.text}
                </button>
              ))}
            </div>
          </>
        )}
        <label className="field">
          <span className="label">{draft ? '指示の内容' : 'コメント'}</span>
          <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
        </label>
        <div className="btn-row">
          <AsyncButton className="btn primary" disabled={!body.trim()} onClick={send}>
            {draft ? '修正指示を追加' : 'コメントを送信'}
          </AsyncButton>
          {draft && (
            <button className="btn" onClick={() => setDraft(null)}>
              ピンを取り消す
            </button>
          )}
        </div>

        <div className="list" style={{ marginTop: 12 }}>
          {roots.length === 0 && <p className="small muted">まだコメントはありません。</p>}
          {roots.map((c: any) => (
            <div key={c.id} className={`comment ${c.resolved ? 'resolved' : ''}`}>
              <div className="row between wrap">
                <span>
                  {c.pin && <span className={`pin-no ${c.pin.type === 'keep' ? 'keep' : ''}`}>{c.pin.number}</span>}
                  {c.pin && <span className="badge">{c.pin.typeLabel}</span>} <strong>{c.authorName}</strong>
                  <span className="small muted">（{c.authorType === 'operator' ? '担当者' : 'お客様'}）</span>
                  {c.resolved && <span className="badge green">対応済み</span>}
                </span>
                <span className="small muted">{formatDateTimeJa(c.createdAt)}</span>
              </div>
              <div className="pre">{c.deleted ? '（削除されました）' : c.body}</div>
              {d.comments
                .filter((r: any) => r.parentId === c.id)
                .map((r: any) => (
                  <div key={r.id} className="reply small">
                    <strong>{r.authorName}</strong>：{r.deleted ? '（削除されました）' : r.body}
                  </div>
                ))}
              <div className="btn-row">
                {audience === 'operator' && !c.deleted && (
                  <AsyncButton
                    className="btn sm"
                    onClick={async () => {
                      await post(`${apiBase}/comments/${c.id}/resolve`, { resolved: !c.resolved });
                      await reload();
                    }}
                  >
                    {c.resolved ? '未対応に戻す' : '対応済みにする'}
                  </AsyncButton>
                )}
                {c.mine && !c.deleted && (
                  <AsyncButton
                    className="btn sm ghost"
                    confirm="このコメントを削除しますか？（ピン番号は振り直しません）"
                    onClick={async () => {
                      await del(`${apiBase}/comments/${c.id}`);
                      await reload();
                    }}
                  >
                    削除
                  </AsyncButton>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {d.changeRequests.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>修正依頼</h3>
          {d.changeRequests.map((r: any) => (
            <div key={r.id} className="comment">
              <div className="small muted">
                {r.clientName}・{formatDateTimeJa(r.createdAt)}・修正指示 {r.pinCount}件
              </div>
              <div className="pre">{r.body}</div>
              <Link className="btn sm" to={`${linkBase}/v/${versionId}/sheet?cr=${r.id}`}>
                この依頼の修正指示書
              </Link>
            </div>
          ))}
        </div>
      )}

      {actions?.(d, reload)}
    </div>
  );
}

/** FreelanceDesk 修正指示：指示書（番号入り画像＋指示一覧）。印刷・テキスト保存に対応 */
export function InstructionSheet({ apiBase, versionId, changeRequestId, backTo }: { apiBase: string; versionId: string; changeRequestId?: string | null; backTo: string }) {
  const [includeResolved, setIncludeResolved] = useState(false);
  const qs = new URLSearchParams();
  if (changeRequestId) qs.set('changeRequestId', changeRequestId);
  else if (includeResolved) qs.set('includeResolved', '1');
  const url = `${apiBase}/versions/${versionId}/instructions?${qs.toString()}`;
  const { data: d, error, loading } = useApi<any>(url, [url]);
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBanner message={error ?? '読み込めませんでした'} />;
  return (
    <div className="stack sheet">
      <div className="btn-row no-print">
        <Link className="btn" to={backTo}>
          ← 版の確認に戻る
        </Link>
        <button className="btn primary" onClick={() => window.print()}>
          印刷 / PDF保存
        </button>
        <a className="btn" href={`${url}&format=txt`}>
          テキストで保存
        </a>
        {!changeRequestId && (
          <label className="check">
            <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} /> 対応済みも含める
          </label>
        )}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>修正指示書</h2>
        <div className="small">
          案件：{d.info.projectName}
          <br />
          画像：{d.info.imageName}
          <br />
          作成日：{d.info.date.replace(/-/g, '/')}
        </div>
        {d.file.canPin && (
          <div style={{ marginTop: 10 }}>
            <PinnedImage src={`${d.file.url}?inline=1`} alt={d.file.filename} pins={d.pins.map((p: any) => ({ ...p }))} />
          </div>
        )}
        <pre className="pre sheet-text" data-testid="sheet-text">
          {d.text}
        </pre>
      </div>
    </div>
  );
}
