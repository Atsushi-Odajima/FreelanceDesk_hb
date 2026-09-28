import { useRef, useState } from 'react';
import { api, del, newRequestId } from '../api';
import { AsyncButton, useToast } from './ui';

export interface AttachmentRow {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  deliveryId?: string | null;
  createdAt: string;
}

const ACCEPT = 'image/*,.heic,.heif,application/pdf,.txt,.csv,.docx,.xlsx,.pptx,video/mp4,video/quicktime';

function fmtSize(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 写真ライブラリ・カメラ・ファイル選択からの添付（スマホ対応） */
export function UploadButtons({ projectId, deliveryId, onUploaded }: { projectId: string; deliveryId?: string; onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    let ok = 0;
    for (const f of Array.from(files)) {
      setBusy(`${f.name} をアップロード中…`);
      const fd = new FormData();
      fd.append('file', f);
      fd.append('purpose', deliveryId ? 'delivery' : 'project');
      fd.append('projectId', projectId);
      if (deliveryId) fd.append('deliveryId', deliveryId);
      fd.append('requestId', newRequestId());
      try {
        await api('POST', '/api/attachments', fd);
        ok++;
      } catch (e) {
        toast(`${f.name}：${(e as Error).message}`, 'error');
      }
    }
    setBusy(null);
    if (ok) toast(`${ok}件を添付しました`);
    if (fileRef.current) fileRef.current.value = '';
    if (camRef.current) camRef.current.value = '';
    onUploaded();
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="btn-row">
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          写真・ファイルを選ぶ
        </button>
        <button className="btn hide-desktop" onClick={() => camRef.current?.click()} disabled={!!busy}>
          カメラで撮影
        </button>
      </div>
      <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => upload(e.target.files)} data-testid="file-input" />
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files)} />
      {busy && <div className="small muted">{busy}</div>}
      <div className="small muted">画像・PDF・テキスト/CSV・Word/Excel/PowerPoint・MP4/MOV（1ファイル10MBまで）。実行ファイル等は添付できません。</div>
    </div>
  );
}

export function AttachmentList({ items, onChanged }: { items: AttachmentRow[]; onChanged: () => void }) {
  if (!items.length) return <div className="empty">添付ファイルはありません</div>;
  return (
    <div>
      {items.map((a) => {
        const isImg = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(a.mime);
        return (
          <div key={a.id} className="file-row">
            {isImg ? <img className="thumb" src={`/api/attachments/${a.id}?inline=1`} alt="" loading="lazy" /> : <div className="thumb" style={{ display: 'grid', placeItems: 'center', fontSize: 11 }}>{a.mime.split('/')[1]?.slice(0, 5).toUpperCase()}</div>}
            <div className="name">
              {a.filename}
              <div className="small muted">{fmtSize(a.sizeBytes)}</div>
            </div>
            <a className="btn sm" href={`/api/attachments/${a.id}?inline=1`} target="_blank" rel="noopener">
              開く
            </a>
            <a className="btn sm hide-mobile" href={`/api/attachments/${a.id}`}>
              保存
            </a>
            <AsyncButton
              className="btn sm danger"
              confirm={`「${a.filename}」を削除しますか？`}
              onClick={async () => {
                await del(`/api/attachments/${a.id}`);
                onChanged();
              }}
            >
              削除
            </AsyncButton>
          </div>
        );
      })}
    </div>
  );
}
