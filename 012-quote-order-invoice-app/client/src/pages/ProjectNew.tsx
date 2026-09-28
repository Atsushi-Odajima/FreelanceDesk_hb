import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorMessage, get, post, put } from '../api';
import { clearDraft, readDraft, useApi, useOnline, writeDraft } from '../hooks';
import { ErrorBanner, Field, Loading, Modal } from '../components/ui';
import { CustomerForm, emptyCustomer } from './Customers';
import { todayIn, formatDateTimeJa } from '../../../shared/dates';
import { newRequestId } from '../api';

interface Form {
  customerId: string;
  title: string;
  inquiryDate: string;
  plannedStart: string;
  plannedDue: string;
  internalMemo: string;
}

const DRAFT_KEY = 'project-new';

/** 案件の新規作成・編集。新規は端末下書きを保持し、requestIdで二重登録を防ぐ */
export default function ProjectNewPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const nav = useNavigate();
  const online = useOnline();
  const customers = useApi<{ customers: any[] }>('/api/customers');
  const existing = useApi<any>(isEdit ? `/api/projects/${id}` : null);
  const saved = !isEdit ? readDraft<Form>(DRAFT_KEY) : null;
  const [form, setForm] = useState<Form>(
    saved?.value ?? { customerId: '', title: '', inquiryDate: todayIn(), plannedStart: '', plannedDue: '', internalMemo: '' },
  );
  const [requestId] = useState(saved?.requestId ?? newRequestId());
  const [localSavedAt, setLocalSavedAt] = useState<string | null>(saved?.savedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newCustomer, setNewCustomer] = useState(false);

  useEffect(() => {
    if (isEdit && existing.data) {
      const p = existing.data.project;
      setForm({ customerId: p.customerId, title: p.title, inquiryDate: p.inquiryDate ?? '', plannedStart: p.plannedStart ?? '', plannedDue: p.plannedDue ?? '', internalMemo: p.internalMemo });
    }
  }, [isEdit, existing.data]);

  const update = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (!isEdit) {
      writeDraft(DRAFT_KEY, next, requestId);
      setLocalSavedAt(new Date().toISOString());
    }
  };

  if (isEdit && !existing.data) return existing.loading ? <Loading /> : <ErrorBanner message={existing.error} />;
  const active = (customers.data?.customers ?? []).filter((c) => !c.archivedAt);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { ...form, inquiryDate: form.inquiryDate || null, plannedStart: form.plannedStart || null, plannedDue: form.plannedDue || null };
    try {
      if (isEdit) {
        await put(`/api/projects/${id}`, body);
        nav(`/projects/${id}`);
      } else {
        const r = await post<{ id: string }>('/api/projects', { ...body, requestId });
        clearDraft(DRAFT_KEY);
        nav(`/projects/${r.id}`, { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <Link to={isEdit ? `/projects/${id}` : '/projects'} className="back-link">
          ‹ 戻る
        </Link>
        <h1>{isEdit ? '案件を編集' : '案件を登録'}</h1>
        {!isEdit && localSavedAt && (
          <span className="save-state local" title="この端末だけに保存されています">
            端末下書き {formatDateTimeJa(localSavedAt).slice(-5)}
          </span>
        )}
      </div>
      <form className="card stack" onSubmit={submit} style={{ maxWidth: 760 }}>
        <ErrorBanner message={error} />
        {!online && <div className="banner warn">オフラインです。入力内容は端末に下書き保存され、通信が戻ったら登録できます（二重登録はされません）。</div>}
        <Field label="顧客">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <select value={form.customerId} onChange={(e) => update({ customerId: e.target.value })} required aria-label="顧客">
              <option value="">選択してください</option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code ? `${c.code} ` : ''}
                  {c.name}
                </option>
              ))}
            </select>
            {!isEdit && (
              <button type="button" className="btn" onClick={() => setNewCustomer(true)} style={{ flex: '0 0 auto' }}>
                ＋ 新しい顧客
              </button>
            )}
          </div>
        </Field>
        <Field label="案件名">
          <input value={form.title} onChange={(e) => update({ title: e.target.value })} required maxLength={200} placeholder="例：秋キャンペーンLP制作" />
        </Field>
        <div className="form-grid cols-3">
          <Field label="問い合わせ日">
            <input type="date" value={form.inquiryDate} onChange={(e) => update({ inquiryDate: e.target.value })} />
          </Field>
          <Field label="予定開始">
            <input type="date" value={form.plannedStart} onChange={(e) => update({ plannedStart: e.target.value })} />
          </Field>
          <Field label="予定納期">
            <input type="date" value={form.plannedDue} onChange={(e) => update({ plannedDue: e.target.value })} />
          </Field>
        </div>
        <Field label="内部メモ（書類には載りません）">
          <textarea value={form.internalMemo} onChange={(e) => update({ internalMemo: e.target.value })} />
        </Field>
        <div className="btn-row stack-mobile">
          <button className="btn primary" disabled={busy || !online}>
            {busy ? '保存中…' : isEdit ? '保存' : '登録する'}
          </button>
          {!isEdit && localSavedAt && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                clearDraft(DRAFT_KEY);
                nav('/projects');
              }}
            >
              下書きを破棄
            </button>
          )}
        </div>
      </form>
      {newCustomer && (
        <Modal title="顧客を登録" onClose={() => setNewCustomer(false)}>
          <CustomerForm
            initial={emptyCustomer}
            onSaved={async (c) => {
              setNewCustomer(false);
              await customers.reload();
              update({ customerId: c.id });
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export async function loadCustomers() {
  return get('/api/customers');
}
