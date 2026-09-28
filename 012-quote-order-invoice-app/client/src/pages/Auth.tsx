import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { errorMessage, get, post } from '../api';
import { useAuth, type Account } from '../auth';
import { ErrorBanner, Field } from '../components/ui';

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="logo">Freelance Desk</div>
        <p className="muted small" style={{ textAlign: 'center', marginTop: 0 }}>
          見積・案件・請求管理
        </p>
        <h1 style={{ fontSize: '1.1rem' }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="stack">
      <div className="banner warn">
        パスワードを忘れたときに使う<strong>復旧コード</strong>です。各コードは1回だけ使えます。<strong>この画面を閉じると再表示できません。</strong>
        紙に書き写すか、パスワード管理アプリに保存してください。
      </div>
      <div className="codes" data-testid="recovery-codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <button
        className="btn"
        onClick={() => {
          void navigator.clipboard?.writeText(codes.join('\n'));
        }}
      >
        コピー
      </button>
    </div>
  );
}

export function LoginPage() {
  const { setAccount } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<{ demoEnabled: boolean } | null>(null);
  useEffect(() => {
    get('/api/auth/config').then(setCfg).catch(() => setCfg(null));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ account: Account }>('/api/auth/login', { email, password });
      setAccount(r.account);
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="ログイン">
      <form className="stack" onSubmit={submit}>
        <ErrorBanner message={error} />
        <Field label="メールアドレス">
          <input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="パスワード">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="btn primary block" disabled={busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
        <div className="row between small">
          <Link to="/signup">新規登録</Link>
          <Link to="/recover">パスワードを忘れた</Link>
        </div>
        {cfg?.demoEnabled && (
          <>
            <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />
            <button
              type="button"
              className="btn block"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await post<{ account: Account }>('/api/auth/demo');
                  setAccount(r.account);
                  nav('/', { replace: true });
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              サンプルデータで試す（デモ）
            </button>
            <p className="muted small" style={{ margin: 0 }}>
              架空データ入りの一時アカウントが作成されます。本番のデータとは混ざりません。
            </p>
          </>
        )}
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { setAccount } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ email: '', password: '', password2: '', businessName: '', signupCode: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Account | null>(null);
  const [cfg, setCfg] = useState<{ signupCodeRequired: boolean } | null>(null);
  useEffect(() => {
    get('/api/auth/config').then(setCfg).catch(() => setCfg(null));
  }, []);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  if (codes && pending) {
    return (
      <AuthShell title="登録が完了しました">
        <RecoveryCodes codes={codes} />
        <button
          className="btn primary block"
          style={{ marginTop: 12 }}
          onClick={() => {
            sessionStorage.setItem('fd-after-login', '/settings?tab=business');
            setAccount(pending);
          }}
        >
          控えました。事業者情報の設定へ進む
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="新規登録">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (form.password !== form.password2) return setError('確認用パスワードが一致しません');
          setBusy(true);
          try {
            const r = await post<{ account: Account; recoveryCodes: string[] }>('/api/auth/signup', {
              email: form.email,
              password: form.password,
              businessName: form.businessName,
              signupCode: form.signupCode || undefined,
            });
            setCodes(r.recoveryCodes);
            setPending(r.account);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBanner message={error} />
        <Field label="屋号・事業者名（あとで変更可）">
          <input value={form.businessName} onChange={set('businessName')} autoComplete="organization" />
        </Field>
        <Field label="メールアドレス">
          <input type="email" inputMode="email" autoComplete="username" value={form.email} onChange={set('email')} required />
        </Field>
        <Field label="パスワード（10文字以上）">
          <input type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={set('password')} required />
        </Field>
        <Field label="パスワード（確認）">
          <input type="password" autoComplete="new-password" minLength={10} value={form.password2} onChange={set('password2')} required />
        </Field>
        {cfg?.signupCodeRequired && (
          <Field label="購入者コード" hint="購入時にお送りしたコードを入力してください">
            <input value={form.signupCode} onChange={set('signupCode')} autoComplete="off" required />
          </Field>
        )}
        <button className="btn primary block" disabled={busy}>
          {busy ? '登録中…' : '登録する'}
        </button>
        <div className="small">
          <Link to="/login">ログインに戻る</Link>
        </div>
      </form>
    </AuthShell>
  );
}

export function RecoverPage() {
  const { setAccount } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ email: '', recoveryCode: '', newPassword: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell title="パスワードの再設定">
      <p className="small muted">登録時に表示された「復旧コード」を1つ入力してください。復旧コードもお持ちでない場合は、販売者（運営者）にお問い合わせください。</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await post<{ account: Account }>('/api/auth/recover', form);
            setAccount(r.account);
            nav('/', { replace: true });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBanner message={error} />
        <Field label="メールアドレス">
          <input type="email" inputMode="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </Field>
        <Field label="復旧コード">
          <input value={form.recoveryCode} autoCapitalize="characters" autoComplete="off" onChange={(e) => setForm({ ...form, recoveryCode: e.target.value })} required />
        </Field>
        <Field label="新しいパスワード（10文字以上）">
          <input type="password" autoComplete="new-password" minLength={10} value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} required />
        </Field>
        <button className="btn primary block" disabled={busy}>
          再設定してログイン
        </button>
        <Link to="/login" className="small">
          ログインに戻る
        </Link>
      </form>
    </AuthShell>
  );
}

export function ResetPage() {
  const { setAccount } = useAuth();
  const nav = useNavigate();
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthShell title="新しいパスワードの設定">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await post<{ account: Account }>('/api/auth/reset', { token, newPassword: pw });
            setAccount(r.account);
            nav('/', { replace: true });
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <ErrorBanner message={error ?? (token ? null : 'リンクが正しくありません')} />
        <Field label="新しいパスワード（10文字以上）">
          <input type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} required />
        </Field>
        <button className="btn primary block" disabled={!token}>
          設定してログイン
        </button>
      </form>
    </AuthShell>
  );
}
