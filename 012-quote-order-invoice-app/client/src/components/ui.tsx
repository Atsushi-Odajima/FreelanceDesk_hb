import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatYen, PAYMENT_STATE_LABELS, type PaymentState } from '../../../shared/calc';
import { PROJECT_STATUS_LABELS, type ProjectStatus } from '../../../shared/status';
import { formatDateJa } from '../../../shared/dates';

export const Money = ({ v, className = '' }: { v: number | null | undefined; className?: string }) => (
  <span className={`money ${className}`}>{v === null || v === undefined ? '—' : formatYen(Number(v))}</span>
);

export const DateText = ({ v }: { v: string | null | undefined }) => <span className="nowrap">{v ? formatDateJa(v) : '—'}</span>;

const STATUS_COLORS: Record<ProjectStatus, string> = {
  inquiry: '',
  quoting: 'yellow',
  quote_submitted: 'blue',
  considering: 'blue',
  ordered: 'blue',
  in_progress: 'blue',
  awaiting_delivery: 'yellow',
  delivered: 'green',
  invoiced: 'green',
  completed: 'green',
  lost: '',
  cancelled: '',
};
export const StatusBadge = ({ status }: { status: ProjectStatus }) => <span className={`badge ${STATUS_COLORS[status]}`}>{PROJECT_STATUS_LABELS[status]}</span>;

export function PaymentBadge({ state, overdue, status }: { state: PaymentState | null; overdue?: boolean; status?: string }) {
  if (status === 'draft') return <span className="badge yellow">下書き</span>;
  if (status === 'cancelled') return <span className="badge">取消</span>;
  if (!state) return null;
  const color = state === 'paid' ? 'green' : state === 'overpaid' ? 'yellow' : state === 'partial' ? 'blue' : '';
  return (
    <span className="row" style={{ gap: 4, display: 'inline-flex' }}>
      <span className={`badge ${color}`}>{PAYMENT_STATE_LABELS[state]}</span>
      {overdue && <span className="badge red">期限超過</span>}
    </span>
  );
}

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

export const Loading = () => (
  <div className="empty" role="status">
    読み込み中…
  </div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const ErrorBanner = ({ message }: { message: string | null | undefined }) => (message ? <div className="banner error" role="alert">{message}</div> : null);

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- トースト ----
interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-area" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** 非同期ボタン：実行中は無効化して二重クリックを防ぐ */
export function AsyncButton({
  onClick,
  children,
  className = 'btn',
  disabled,
  type = 'button',
  confirm,
  ...rest
}: {
  onClick: () => Promise<unknown> | unknown;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  confirm?: string;
  'data-testid'?: string;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      type={type}
      className={className}
      disabled={disabled || busy}
      aria-busy={busy}
      {...rest}
      onClick={async () => {
        if (busy) return;
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          await onClick();
        } catch (e) {
          toast(e instanceof Error ? e.message : 'エラーが発生しました', 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '処理中…' : children}
    </button>
  );
}

export function YenInput({ value, onChange, id, ariaLabel, allowEmpty }: { value: number | ''; onChange: (v: number | '') => void; id?: string; ariaLabel?: string; allowEmpty?: boolean }) {
  const [text, setText] = useState(value === '' ? '' : String(value));
  useEffect(() => {
    const cur = text.replace(/[,，¥￥\s]/g, '');
    if (String(value) !== cur && !(value === '' && cur === '')) setText(value === '' ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      inputMode="numeric"
      autoComplete="off"
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
        setText(raw);
        const cleaned = raw.replace(/[,，¥￥\s]/g, '');
        if (cleaned === '') onChange(allowEmpty ? '' : 0);
        else if (/^\d{1,13}$/.test(cleaned)) onChange(Number(cleaned));
      }}
      onBlur={() => setText(value === '' ? '' : String(value))}
    />
  );
}
