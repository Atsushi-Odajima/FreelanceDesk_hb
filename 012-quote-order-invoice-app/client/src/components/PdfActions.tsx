import { useState } from 'react';
import { fetchBlob } from '../api';
import { useIsMobile } from '../hooks';
import { Modal, useToast } from './ui';

/**
 * PDFの表示・保存・共有。
 * - PC：モーダル内の iframe でプレビュー
 * - スマホ：新しいタブで開く（iOS Safari/PWA でも閲覧→共有シートから保存可能）
 * - 共有：Web Share API（ファイル共有）に対応した端末のみ表示
 */
export default function PdfActions({ url, filename, label = 'PDF' }: { url: string; filename: string; label?: string }) {
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const mobile = useIsMobile();
  const toast = useToast();
  const canShareFiles =
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    (() => {
      try {
        return navigator.canShare({ files: [new File([new Blob(['x'], { type: 'application/pdf' })], 'x.pdf', { type: 'application/pdf' })] });
      } catch {
        return false;
      }
    })();

  const share = async () => {
    setBusy(true);
    try {
      const blob = await fetchBlob(url);
      const file = new File([blob], filename, { type: 'application/pdf' });
      await navigator.share({ files: [file], title: filename });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(`共有できませんでした：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="btn-row">
        {mobile ? (
          <a className="btn" href={url} target="_blank" rel="noopener">
            {label}を開く
          </a>
        ) : (
          <button className="btn" onClick={() => setPreview(true)}>
            {label}プレビュー
          </button>
        )}
        <a className="btn" href={`${url}${url.includes('?') ? '&' : '?'}download=1`} download={filename}>
          {label}を保存
        </a>
        {canShareFiles && (
          <button className="btn" onClick={share} disabled={busy}>
            共有
          </button>
        )}
      </div>
      {preview && (
        <Modal title={filename} onClose={() => setPreview(false)} wide>
          <iframe className="pdf-frame" src={url} title={filename} />
          <p className="small muted">表示されない場合は「{label}を保存」から保存して開いてください。</p>
        </Modal>
      )}
    </>
  );
}
