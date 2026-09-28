import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { del, newRequestId, post } from '../api';
import { useApi, useOnline } from '../hooks';
import { AsyncButton, DateText, ErrorBanner, Field, Loading, Modal, Money, PaymentBadge, YenInput, useToast } from '../components/ui';
import PdfActions from '../components/PdfActions';
import { DocView } from '../components/DocEditor';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '../../../shared/status';
import { formatDateTimeJa, todayIn } from '../../../shared/dates';
import { formatYen } from '../../../shared/calc';

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const { data, error, loading, reload, status } = useApi<any>(`/api/invoices/${id}`);
  const inv = data?.invoice;
  const current = useApi<any>(inv?.finalVersionId ? `/api/invoice-versions/${inv.finalVersionId}` : null, [inv?.finalVersionId]);
  const [modal, setModal] = useState<null | 'payment' | 'correction' | 'cancel'>(null);
  const online = useOnline();

  if (!data) return loading ? <Loading /> : <ErrorBanner message={status === 404 ? '請求書が見つかりません' : error} />;
  if (inv.status === 'draft' && inv.draftVersionId) return <Navigate to={`/invoice-versions/${inv.draftVersionId}`} replace />;
  const refresh = async () => {
    await reload();
    await current.reload();
  };

  return (
    <div>
      <div className="page-header">
        <Link to={`/projects/${inv.projectId}`} className="back-link">
          ‹ 案件へ
        </Link>
        <h1>請求書 {inv.number}</h1>
        <PaymentBadge state={inv.paymentState} overdue={inv.overdue} status={inv.status} />
      </div>

      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="label">請求額</div>
          <div className="value">
            <Money v={inv.total} />
          </div>
          <div className="basis">{inv.currentRevision > 1 ? `訂正版 第${inv.currentRevision}版` : '初版'}</div>
        </div>
        <div className="stat">
          <div className="label">入金額（割当済み）</div>
          <div className="value">
            <Money v={inv.allocated} />
          </div>
        </div>
        <div className="stat">
          <div className="label">{inv.remaining < 0 ? '過入金' : '残額'}</div>
          <div className="value" data-testid="remaining">
            <Money v={inv.remaining < 0 ? -inv.remaining : inv.remaining} />
          </div>
        </div>
        <div className="stat">
          <div className="label">支払期限</div>
          <div className="value" style={{ fontSize: '1rem' }}>
            <DateText v={inv.dueDate} />
          </div>
          <div className="basis">
            {inv.customerName}・{inv.projectTitle}
          </div>
        </div>
      </div>
      {inv.paymentState === 'overpaid' && (
        <div className="banner warn">過入金です（{formatYen(inv.overpaidAmount)}）。差額は値引き・手数料として自動処理しません。返金や次回請求への充当は、顧客と相談のうえ別途対応してください。</div>
      )}
      {inv.status === 'cancelled' && <div className="banner error">この請求書は取消済みです（理由：{inv.cancelReason}）</div>}

      {inv.status === 'issued' && (
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button className="btn primary" onClick={() => setModal('payment')} disabled={!online} data-testid="record-payment">
            入金を記録
          </button>
          {inv.draftVersionId ? (
            <Link className="btn" to={`/invoice-versions/${inv.draftVersionId}`}>
              訂正下書きを編集
            </Link>
          ) : (
            <button className="btn" onClick={() => setModal('correction')} disabled={!online}>
              訂正版を作る
            </button>
          )}
          <button className="btn danger" onClick={() => setModal('cancel')} disabled={!online || inv.allocated > 0} title={inv.allocated > 0 ? '入金の割当を解除すると取消できます' : ''}>
            取消
          </button>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>入金</h2>
          {data.allocations.length === 0 ? (
            <div className="empty">入金はまだありません</div>
          ) : (
            <div data-testid="allocations">
              {data.allocations.map((a: any) => (
                <div key={a.id} className="file-row">
                  <div className="name">
                    <strong>
                      <Money v={a.amount} />
                    </strong>{' '}
                    <DateText v={a.receivedOn} />
                    <div className="small muted">
                      {PAYMENT_METHOD_LABELS[a.method as PaymentMethod] ?? a.method}
                      {a.payerName && `・${a.payerName}`}
                      {a.source === 'bank_csv' && '・銀行CSV'}
                      {a.memo && `・${a.memo}`}
                    </div>
                  </div>
                  <AsyncButton
                    className="btn sm"
                    confirm="この入金の割当を解除しますか？（入金自体は未割当として残ります）"
                    onClick={async () => {
                      await del(`/api/allocations/${a.id}`);
                      await refresh();
                    }}
                  >
                    割当解除
                  </AsyncButton>
                </div>
              ))}
            </div>
          )}
          <p className="small muted">未割当の入金（銀行CSVなど）を割り当てるには「請求・入金」→「入金一覧」から行います。</p>
        </div>
        <div className="card">
          <h2>書類・履歴</h2>
          {inv.finalVersionId && <PdfActions url={`/api/pdf/invoice-versions/${inv.finalVersionId}`} filename={`請求書_${inv.number}${inv.currentRevision > 1 ? `_訂正第${inv.currentRevision}版` : ''}.pdf`} label="請求書" />}
          <h3 style={{ marginTop: 12 }}>版の履歴</h3>
          <ul style={{ paddingLeft: 18, margin: 0 }} data-testid="versions">
            {data.versions.map((v: any) => (
              <li key={v.id} className="small">
                第{v.revision}版：<Money v={v.total} />（{v.status === 'final' ? '有効' : v.status === 'superseded' ? '訂正前' : '下書き'}）
                {v.finalizedAt && `・確定 ${formatDateTimeJa(v.finalizedAt)}`}
                {v.revision > 1 && v.status !== 'draft' && (
                  <div className="muted">
                    訂正理由：{v.correctionReason}（<Money v={v.previousTotal} /> → <Money v={v.total} />）
                  </div>
                )}
                {v.status === 'superseded' && (
                  <div>
                    <a href={`/api/pdf/invoice-versions/${v.id}`} target="_blank" rel="noopener">
                      訂正前のPDF
                    </a>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {current.data && (
        <div style={{ marginTop: 12 }}>
          <DocView snap={current.data.preview} />
        </div>
      )}

      {modal === 'payment' && <PaymentModal invoice={inv} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'correction' && <CorrectionModal invoiceId={inv.id} onClose={() => setModal(null)} />}
      {modal === 'cancel' && <CancelModal invoiceId={inv.id} onClose={() => setModal(null)} onDone={refresh} />}
    </div>
  );
}

function PaymentModal({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState<{ receivedOn: string; amount: number | ''; method: PaymentMethod; payerName: string; memo: string }>({
    receivedOn: todayIn(),
    amount: invoice.remaining > 0 ? invoice.remaining : '',
    method: 'bank_transfer',
    payerName: '',
    memo: '',
  });
  const [requestId] = useState(newRequestId());
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const amt = f.amount === '' ? 0 : f.amount;
  const over = amt > invoice.remaining;
  return (
    <Modal title="入金を記録" onClose={onClose}>
      <div className="stack">
        <ErrorBanner message={error} />
        <div className="small">
          残額 <Money v={invoice.remaining} />
        </div>
        <Field label="入金日">
          <input type="date" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} />
        </Field>
        <Field label="入金額（円）">
          <YenInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} allowEmpty ariaLabel="入金額" />
        </Field>
        {over && <div className="banner warn">残額より {formatYen(amt - invoice.remaining)} 多い入金です。「過入金」として記録されます（差額は自動で値引き・手数料にしません）。</div>}
        {amt > 0 && amt < invoice.remaining && <div className="small muted">一部入金として記録されます（残り {formatYen(invoice.remaining - amt)}）。</div>}
        <Field label="方法">
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PaymentMethod })}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="名義（任意）">
          <input value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} />
        </Field>
        <Field label="メモ（任意）">
          <input value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
        </Field>
        <AsyncButton
          className="btn primary block"
          disabled={!amt}
          confirm={over ? `過入金（${formatYen(amt - invoice.remaining)}）として記録します。よろしいですか？` : undefined}
          onClick={async () => {
            try {
              await post(`/api/invoices/${invoice.id}/payments`, { requestId, receivedOn: f.receivedOn, amount: amt, method: f.method, payerName: f.payerName, memo: f.memo });
              toast('入金を記録しました');
              onClose();
              await onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          data-testid="save-payment"
        >
          記録する
        </AsyncButton>
      </div>
    </Modal>
  );
}

function CorrectionModal({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [requestId] = useState(newRequestId());
  const nav = useNavigate();
  return (
    <Modal title="訂正版を作る" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          確定済みの請求書は上書きせず、訂正版（新しい版）を作ります。元の請求書と訂正理由・旧金額・新金額・日時が履歴に残ります。
        </p>
        <Field label="訂正理由（必須・訂正版の請求書に記載）">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <AsyncButton
          className="btn primary block"
          disabled={!reason.trim()}
          onClick={async () => {
            const r = await post(`/api/invoices/${invoiceId}/corrections`, { requestId, reason });
            nav(`/invoice-versions/${r.versionId}`);
          }}
        >
          訂正版の下書きを作る
        </AsyncButton>
      </div>
    </Modal>
  );
}

function CancelModal({ invoiceId, onClose, onDone }: { invoiceId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="請求書を取消" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          取消した請求書は一覧に「取消」として残ります。番号は再利用されません。
        </p>
        <Field label="取消理由（必須・社内用）">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <AsyncButton
          className="btn danger solid block"
          disabled={!reason.trim()}
          onClick={async () => {
            await post(`/api/invoices/${invoiceId}/cancel`, { reason });
            onClose();
            await onDone();
          }}
        >
          取消する
        </AsyncButton>
      </div>
    </Modal>
  );
}
