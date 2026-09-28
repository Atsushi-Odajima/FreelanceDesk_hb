import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, errorMessage, newRequestId, post, put } from '../api';
import { clearDraft, readDraft, useApi, useOnline, writeDraft } from '../hooks';
import { AsyncButton, ErrorBanner, Field, Loading, Modal, Money, useToast } from '../components/ui';
import DocEditor, { DocView, type DocDraft } from '../components/DocEditor';
import PdfActions from '../components/PdfActions';
import { formatDateTimeJa, todayIn } from '../../../shared/dates';

function toDraft(v: any): DocDraft {
  return {
    issueDate: v.issueDate,
    validUntil: v.validUntil,
    subject: v.subject,
    deliveryNote: v.deliveryNote,
    paymentTerms: v.paymentTerms,
    notes: v.notes,
    taxMode: v.taxMode,
    lineRounding: v.lineRounding,
    taxRounding: v.taxRounding,
    lines: v.lines,
    adjustments: v.adjustments,
    changeMemo: v.changeMemo,
  };
}

export default function QuoteEditorPage() {
  const { versionId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const online = useOnline();
  const { data, error, loading, reload, status } = useApi<any>(`/api/quote-versions/${versionId}`);
  const items = useApi<{ items: any[] }>('/api/items');
  const biz = useApi<any>('/api/business');
  const [draft, setDraft] = useState<DocDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [localAt, setLocalAt] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ value: DocDraft; savedAt: string } | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const key = `quote:${versionId}`;

  useEffect(() => {
    if (!data) return;
    const v = data.version;
    setDraft(toDraft(v));
    setDirty(false);
    if (v.status === 'draft') {
      const local = readDraft<DocDraft>(key);
      if (local && new Date(local.savedAt) > new Date(v.updatedAt)) setRestore({ value: local.value, savedAt: local.savedAt });
      else if (local) clearDraft(key);
    } else clearDraft(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!data || !draft) return loading ? <Loading /> : <ErrorBanner message={status === 404 ? '見積が見つかりません' : error} />;
  const v = data.version;
  const isDraft = v.status === 'draft';

  const change = (d: DocDraft) => {
    setDraft(d);
    setDirty(true);
    writeDraft(key, d, 'n/a');
    setLocalAt(new Date().toISOString());
  };
  const save = async () => {
    setSaveError(null);
    try {
      await put(`/api/quote-versions/${versionId}`, draft);
      clearDraft(key);
      setDirty(false);
      setLocalAt(null);
      await reload();
      return true;
    } catch (e) {
      setSaveError(errorMessage(e));
      throw e;
    }
  };

  return (
    <div>
      <div className="page-header">
        <Link to={`/projects/${v.projectId}`} className="back-link">
          ‹ 案件へ
        </Link>
        <h1>
          見積 {v.number} v{v.version}
        </h1>
        {isDraft ? (
          dirty ? (
            <span className="save-state local" data-testid="save-state">
              端末下書き（未保存）{localAt ? ` ${formatDateTimeJa(localAt).slice(-5)}` : ''}
            </span>
          ) : (
            <span className="save-state server" data-testid="save-state">
              サーバー保存済み
            </span>
          )
        ) : (
          <span className="badge blue">確定済み{v.submittedOn ? `・提出 ${v.submittedOn}` : ''}</span>
        )}
      </div>

      {data.versions.length > 1 && (
        <div className="chips" aria-label="版の履歴">
          {data.versions.map((x: any) => (
            <Link key={x.id} to={`/quotes/${x.id}`} className={`chip ${x.id === v.id ? 'active' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
              v{x.version} {x.status === 'draft' ? '下書き' : ''} {Number(x.total).toLocaleString('ja-JP')}円
            </Link>
          ))}
        </div>
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

      {isDraft ? (
        <DocEditor kind="quote" value={draft} onChange={change} items={items.data?.items ?? []} defaultTaxRate={biz.data?.business?.defaultTaxRate ?? '10'} />
      ) : (
        <>
          {v.changeMemo && <div className="banner info">変更メモ（社内）：{v.changeMemo}</div>}
          <DocView snap={data.preview} />
        </>
      )}

      <div className="sticky-actions">
        {isDraft ? (
          <>
            <AsyncButton className="btn" onClick={save} disabled={!online} data-testid="save-quote">
              保存
            </AsyncButton>
            <AsyncButton
              className="btn primary"
              disabled={!online || draft.lines.length === 0}
              confirm="この版を確定します。確定後は内容を変更できません（変更は新しい版で行います）。よろしいですか？"
              onClick={async () => {
                await save();
                await post(`/api/quote-versions/${versionId}/finalize`);
                toast('見積を確定しました');
                await reload();
              }}
              data-testid="finalize-quote"
            >
              確定する
            </AsyncButton>
            <AsyncButton
              className="btn danger"
              confirm="この下書きを破棄しますか？"
              onClick={async () => {
                await del(`/api/quote-versions/${versionId}`);
                clearDraft(key);
                nav(`/projects/${v.projectId}`);
              }}
            >
              下書きを破棄
            </AsyncButton>
          </>
        ) : (
          <>
            {!v.submittedOn && (
              <button className="btn primary" onClick={() => setSubmitOpen(true)} data-testid="submit-quote">
                提出済みにする
              </button>
            )}
            {!data.order && (
              <AsyncButton
                className="btn"
                onClick={async () => {
                  const r = await post(`/api/quote-versions/${versionId}/new-version`, { requestId: newRequestId() });
                  nav(`/quotes/${r.versionId}`);
                }}
                data-testid="new-version"
              >
                この版をもとに新しい版を作る
              </AsyncButton>
            )}
            {!data.order && (
              <Link className="btn" to={`/projects/${v.projectId}?action=order&version=${v.id}`}>
                この見積で受注
              </Link>
            )}
            {data.order && <span className="badge green">この版で受注済み</span>}
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h2>PDF{isDraft ? '（下書き表示付き）' : ''}</h2>
        {isDraft && dirty && <p className="small muted">未保存の変更はPDFに反映されません。先に保存してください。</p>}
        <PdfActions url={`/api/pdf/quote-versions/${versionId}`} filename={`見積書_${v.number}_v${v.version}.pdf`} label="見積書" />
        <p className="small muted">「提出済みにする」は提出日と版を記録するだけで、メール送信は行いません。PDFを保存・共有して顧客へお送りください。</p>
      </div>

      {submitOpen && <SubmitModal versionId={versionId!} total={v.total} onClose={() => setSubmitOpen(false)} onDone={reload} />}
    </div>
  );
}

function SubmitModal({ versionId, total, onClose, onDone }: { versionId: string; total: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [date, setDate] = useState(todayIn());
  const toast = useToast();
  return (
    <Modal title="提出済みにする" onClose={onClose}>
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>
          顧客へ見積書を渡した日を記録します（金額 <Money v={total} />）。このアプリからメールは送信されません。
        </p>
        <Field label="提出日">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <AsyncButton
          className="btn primary block"
          onClick={async () => {
            await post(`/api/quote-versions/${versionId}/submit`, { submittedOn: date });
            toast('提出済みにしました');
            onClose();
            await onDone();
          }}
        >
          記録する
        </AsyncButton>
      </div>
    </Modal>
  );
}
