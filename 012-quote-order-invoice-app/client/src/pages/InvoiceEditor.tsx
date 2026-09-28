import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, errorMessage, post, put } from '../api';
import { clearDraft, readDraft, useApi, useOnline, writeDraft } from '../hooks';
import { AsyncButton, ErrorBanner, Loading, Money, useToast } from '../components/ui';
import DocEditor, { DocView, type DocDraft, useTotals } from '../components/DocEditor';
import PdfActions from '../components/PdfActions';
import { formatDateTimeJa } from '../../../shared/dates';

function toDraft(v: any): DocDraft {
  return {
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    subject: v.subject,
    paymentTerms: v.paymentTerms,
    notes: v.notes,
    bankInfo: v.bankInfo,
    taxMode: v.taxMode,
    lineRounding: v.lineRounding,
    taxRounding: v.taxRounding,
    lines: v.lines,
    adjustments: v.adjustments,
    correctionReason: v.revision > 1 ? v.correctionReason : undefined,
  };
}

/** 請求書（下書き・訂正版下書き）の編集→確認→確定 */
export default function InvoiceEditorPage() {
  const { versionId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const online = useOnline();
  const { data, error, loading, reload, status } = useApi<any>(`/api/invoice-versions/${versionId}`);
  const items = useApi<{ items: any[] }>('/api/items');
  const [draft, setDraft] = useState<DocDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ value: DocDraft; savedAt: string } | null>(null);
  const key = `invoice:${versionId}`;

  useEffect(() => {
    if (!data) return;
    setDraft(toDraft(data.version));
    setDirty(false);
    const local = readDraft<DocDraft>(key);
    if (data.version.status === 'draft' && local && new Date(local.savedAt) > new Date(data.version.updatedAt)) setRestore({ value: local.value, savedAt: local.savedAt });
    else if (local) clearDraft(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const totals = useTotals(draft ?? ({ lines: [], adjustments: [], taxMode: 'exclusive', lineRounding: 'round', taxRounding: 'floor' } as unknown as DocDraft));
  if (!data || !draft) return loading ? <Loading /> : <ErrorBanner message={status === 404 ? '請求書が見つかりません' : error} />;
  const v = data.version;
  if (v.status !== 'draft') {
    return (
      <div>
        <div className="banner info">
          この版は確定済みです。<Link to={`/invoices/${v.invoiceId}`}>請求書の詳細へ</Link>
        </div>
        <DocView snap={data.preview} />
      </div>
    );
  }
  const isCorrection = v.revision > 1;
  const change = (d: DocDraft) => {
    setDraft(d);
    setDirty(true);
    writeDraft(key, d, 'n/a');
  };
  const save = async () => {
    setSaveError(null);
    try {
      await put(`/api/invoice-versions/${versionId}`, draft);
      clearDraft(key);
      setDirty(false);
      await reload();
    } catch (e) {
      setSaveError(errorMessage(e));
      throw e;
    }
  };

  return (
    <div>
      <div className="page-header">
        <Link to={isCorrection ? `/invoices/${v.invoiceId}` : `/projects/${v.projectId}`} className="back-link">
          ‹ 戻る
        </Link>
        <h1>{isCorrection ? `請求書 ${v.number} の訂正（第${v.revision}版）` : '請求書を作成'}</h1>
        <span className={`save-state ${dirty ? 'local' : 'server'}`} data-testid="save-state">
          {dirty ? '端末下書き（未保存）' : 'サーバー保存済み（未確定）'}
        </span>
      </div>
      {isCorrection ? (
        <div className="banner warn">
          訂正版を確定すると、現在の請求書（<Money v={v.previousTotal} />）は「訂正前」として履歴に残り、この版が有効になります。割当済みの入金額（<Money v={data.allocated} />）を下回る金額にはできません。
        </div>
      ) : (
        <div className="banner info">受注内容（明細・金額・支払条件）を引き継いでいます。内容を確認して「確認へ進む」→「確定して発行」してください。番号は確定時に付きます。</div>
      )}
      {restore && (
        <div className="banner warn row between">
          <span>この端末に未保存の下書きがあります（{formatDateTimeJa(restore.savedAt)}）。</span>
          <span className="btn-row">
            <button
              className="btn sm"
              onClick={() => {
                setDraft(restore.value);
                setDirty(true);
                setRestore(null);
              }}
            >
              復元する
            </button>
            <button
              className="btn sm"
              onClick={() => {
                clearDraft(key);
                setRestore(null);
              }}
            >
              破棄
            </button>
          </span>
        </div>
      )}
      <ErrorBanner message={saveError} />

      {!confirming ? (
        <DocEditor kind="invoice" value={draft} onChange={change} items={items.data?.items ?? []} />
      ) : (
        <div className="stack">
          <div className="banner info">内容を確認してください。確定後は変更できません（変更は「訂正版」で行います）。</div>
          <DocView snap={data.preview} />
        </div>
      )}

      <div className="sticky-actions">
        {!confirming ? (
          <>
            <AsyncButton className="btn" onClick={save} disabled={!online}>
              保存
            </AsyncButton>
            <AsyncButton
              className="btn primary"
              disabled={!online || !!totals.error || draft.lines.length === 0 || !draft.dueDate || (isCorrection && !draft.correctionReason?.trim())}
              onClick={async () => {
                await save();
                setConfirming(true);
                window.scrollTo(0, 0);
              }}
              data-testid="to-confirm"
            >
              確認へ進む
            </AsyncButton>
            <AsyncButton
              className="btn danger"
              confirm={isCorrection ? 'この訂正下書きを破棄しますか？' : 'この請求書の下書きを破棄しますか？'}
              onClick={async () => {
                const r = await del(`/api/invoice-versions/${versionId}`);
                clearDraft(key);
                nav(r.invoiceDeleted ? `/projects/${v.projectId}` : `/invoices/${v.invoiceId}`);
              }}
            >
              破棄
            </AsyncButton>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setConfirming(false)}>
              ‹ 修正する
            </button>
            <AsyncButton
              className="btn primary"
              disabled={!online}
              onClick={async () => {
                await post(`/api/invoice-versions/${versionId}/finalize`);
                toast(isCorrection ? '訂正版を確定しました' : '請求書を発行しました');
                nav(`/invoices/${v.invoiceId}`, { replace: true });
              }}
              data-testid="finalize-invoice"
            >
              確定して発行（<Money v={data.preview.totals?.total} />）
            </AsyncButton>
          </>
        )}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h2>PDF（下書き表示付き）</h2>
        <PdfActions url={`/api/pdf/invoice-versions/${versionId}`} filename={`請求書_下書き.pdf`} label="請求書" />
      </div>
    </div>
  );
}
