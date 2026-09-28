import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, del, errorMessage, newRequestId, post, put } from '../api';
import { useApi } from '../hooks';
import { useAuth, clearLocalData } from '../auth';
import { AsyncButton, ErrorBanner, Field, Loading, useToast } from '../components/ui';
import { RecoveryCodes } from './Auth';

type Tab = 'business' | 'data' | 'account';

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'business';
  return (
    <div>
      <div className="page-header">
        <h1>設定・データ</h1>
      </div>
      <div className="tabs">
        {(
          [
            ['business', '事業者情報'],
            ['data', 'データ（CSV・バックアップ）'],
            ['account', 'アカウント'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'business' && <BusinessTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'account' && <AccountTab />}
    </div>
  );
}

function BusinessTab() {
  const { data, reload } = useApi<any>('/api/business');
  const { refresh } = useAuth();
  const [f, setF] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const logoRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (data) setF(data.business);
  }, [data]);
  if (!f) return <Loading />;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await put('/api/business', {
            name: f.name,
            contactName: f.contactName,
            postalCode: f.postalCode,
            address: f.address,
            phone: f.phone,
            email: f.email,
            bankInfo: f.bankInfo,
            registrationNo: f.registrationNo,
            brandColor: f.brandColor,
            defaultPaymentTerms: f.defaultPaymentTerms,
            defaultNotes: f.defaultNotes,
            defaultTaxRate: f.defaultTaxRate,
            taxMode: f.taxMode,
            lineRounding: f.lineRounding,
            taxRounding: f.taxRounding,
            quoteValidDays: Number(f.quoteValidDays),
            invoiceDueDays: Number(f.invoiceDueDays),
          });
          toast('保存しました');
          await reload();
          await refresh();
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <ErrorBanner message={error} />
      <div className="card">
        <h2>書類に載る事業者情報</h2>
        <div className="form-grid cols-2">
          <Field label="事業者名・屋号">
            <input value={f.name} onChange={set('name')} maxLength={200} />
          </Field>
          <Field label="担当者名">
            <input value={f.contactName} onChange={set('contactName')} maxLength={100} />
          </Field>
          <Field label="郵便番号">
            <input value={f.postalCode} onChange={set('postalCode')} maxLength={20} inputMode="numeric" />
          </Field>
          <Field label="電話">
            <input type="tel" value={f.phone} onChange={set('phone')} maxLength={50} />
          </Field>
          <Field label="住所" className="span-2">
            <textarea value={f.address} onChange={set('address')} maxLength={300} style={{ minHeight: 60 }} />
          </Field>
          <Field label="メール">
            <input type="email" value={f.email} onChange={set('email')} maxLength={254} />
          </Field>
          <Field label="登録番号など（任意の文字列）" hint="例：T1234567890123。記載内容の適否は各自でご確認ください">
            <input value={f.registrationNo} onChange={set('registrationNo')} maxLength={100} />
          </Field>
          <Field label="振込先（請求書に記載）" className="span-2">
            <textarea value={f.bankInfo} onChange={set('bankInfo')} maxLength={500} placeholder="例：○○銀行 △△支店 普通 1234567 カ）サンプル" />
          </Field>
          <Field label="基本色（書類の見出し色）">
            <input type="color" value={f.brandColor} onChange={set('brandColor')} style={{ padding: 4, height: 44 }} />
          </Field>
          <div className="field">
            <span className="label">ロゴ（PNG/JPEG）</span>
            <div className="row">
              {f.logoAttachmentId && <img src={`/api/attachments/${f.logoAttachmentId}?inline=1`} alt="ロゴ" style={{ maxHeight: 44, maxWidth: 140, border: '1px solid var(--border)', borderRadius: 4 }} />}
              <button type="button" className="btn sm" onClick={() => logoRef.current?.click()}>
                {f.logoAttachmentId ? '変更' : '選ぶ'}
              </button>
              {f.logoAttachmentId && (
                <AsyncButton
                  className="btn sm danger"
                  onClick={async () => {
                    await del(`/api/attachments/${f.logoAttachmentId}`);
                    await reload();
                  }}
                >
                  外す
                </AsyncButton>
              )}
            </div>
            <input
              ref={logoRef}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const fd = new FormData();
                fd.append('file', file);
                fd.append('purpose', 'logo');
                fd.append('requestId', newRequestId());
                try {
                  await api('POST', '/api/attachments', fd);
                  toast('ロゴを設定しました');
                  await reload();
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>
      <div className="card">
        <h2>書類の初期値</h2>
        <div className="form-grid cols-3">
          <Field label="標準支払条件" className="span-all">
            <input value={f.defaultPaymentTerms} onChange={set('defaultPaymentTerms')} maxLength={300} />
          </Field>
          <Field label="標準備考" className="span-all">
            <textarea value={f.defaultNotes} onChange={set('defaultNotes')} maxLength={2000} />
          </Field>
          <Field label="標準税率（%）">
            <input inputMode="decimal" value={f.defaultTaxRate} onChange={set('defaultTaxRate')} />
          </Field>
          <Field label="税の表示">
            <select value={f.taxMode} onChange={set('taxMode')}>
              <option value="exclusive">税抜価格（外税）</option>
              <option value="inclusive">税込価格（内税）</option>
            </select>
          </Field>
          <Field label="明細金額の端数">
            <select value={f.lineRounding} onChange={set('lineRounding')}>
              <option value="round">四捨五入</option>
              <option value="floor">切り捨て</option>
              <option value="ceil">切り上げ</option>
            </select>
          </Field>
          <Field label="消費税の端数">
            <select value={f.taxRounding} onChange={set('taxRounding')}>
              <option value="floor">切り捨て</option>
              <option value="round">四捨五入</option>
              <option value="ceil">切り上げ</option>
            </select>
          </Field>
          <Field label="見積の有効期限（日数）">
            <input type="number" min={0} max={3650} value={f.quoteValidDays} onChange={set('quoteValidDays')} />
          </Field>
          <Field label="請求の支払期限（日数）">
            <input type="number" min={0} max={3650} value={f.invoiceDueDays} onChange={set('invoiceDueDays')} />
          </Field>
        </div>
        <p className="small muted">変更は今後作る書類に反映されます。確定済みの書類は変わりません。本アプリは税務・法令への適合を保証しません。</p>
      </div>
      <button className="btn primary">保存</button>
    </form>
  );
}

function DataTab() {
  const stats = useApi<any>('/api/data/stats');
  const toast = useToast();
  const [importKind, setImportKind] = useState<'customers' | 'items'>('customers');
  const [importEnc, setImportEnc] = useState<'utf-8' | 'shift_jis'>('utf-8');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreResult, setRestoreResult] = useState<any | null>(null);

  const runImport = async (dry: boolean) => {
    if (!importFile) return;
    setError(null);
    const fd = new FormData();
    fd.append('file', importFile);
    fd.append('encoding', importEnc);
    if (dry) fd.append('preview', '1');
    try {
      const r = await api('POST', `/api/data/import/${importKind}`, fd);
      setPreview(r);
      if (!dry) toast(`${r.imported}件を取り込みました`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <h2>CSV出力</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Excelで開けるUTF-8（BOM付き）形式です。先頭が「=」「+」「-」「@」の文字列には数式として実行されないよう「'」を付けています。
        </p>
        <div className="btn-row">
          {(
            [
              ['customers', '顧客'],
              ['items', '品目'],
              ['projects', '案件'],
              ['invoices', '請求一覧'],
              ['payments', '入金一覧'],
            ] as Array<[string, string]>
          ).map(([k, label]) => (
            <a key={k} className="btn" href={`/api/data/export/${k}.csv`} download>
              {label}
            </a>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>CSV取込（顧客・品目）</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          テンプレートの見出し行のまま入力してください。取り込む前に内容を確認できます。元のCSVファイルは変更しません。コードが登録済みの行はスキップします。
        </p>
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <a className="btn sm" href="/api/data/templates/customers.csv" download>
            顧客テンプレート
          </a>
          <a className="btn sm" href="/api/data/templates/items.csv" download>
            品目テンプレート
          </a>
        </div>
        <div className="form-grid cols-3">
          <Field label="取込対象">
            <select value={importKind} onChange={(e) => setImportKind(e.target.value as 'customers' | 'items')}>
              <option value="customers">顧客</option>
              <option value="items">品目</option>
            </select>
          </Field>
          <Field label="文字コード">
            <select value={importEnc} onChange={(e) => setImportEnc(e.target.value as 'utf-8' | 'shift_jis')}>
              <option value="utf-8">UTF-8</option>
              <option value="shift_jis">Shift_JIS</option>
            </select>
          </Field>
          <Field label="CSVファイル">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setImportFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          </Field>
        </div>
        <ErrorBanner message={error} />
        <div className="btn-row" style={{ marginTop: 8 }}>
          <AsyncButton className="btn" disabled={!importFile} onClick={() => runImport(true)}>
            内容を確認
          </AsyncButton>
          {preview?.preview && preview.validCount > 0 && (
            <AsyncButton className="btn primary" onClick={() => runImport(false)}>
              {preview.validCount}件を取り込む
            </AsyncButton>
          )}
        </div>
        {preview && (
          <ul className="small" style={{ paddingLeft: 18 }}>
            {preview.results.map((r: any) => (
              <li key={r.line} style={{ color: r.status === 'error' ? 'var(--danger)' : r.status === 'duplicate' ? 'var(--warn)' : undefined }}>
                {r.line}行目：{r.status === 'ok' ? `OK（${r.name}）` : r.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>全データのバックアップ</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          顧客・品目・案件・見積（全版）・受注・納品・請求（訂正履歴含む）・入金・添付ファイル・事業者情報をZIPファイル1つに保存します。定期的に保存し、安全な場所に保管してください。
        </p>
        {stats.data && (
          <p className="small">
            保存容量：{(stats.data.storage / 1024 / 1024).toFixed(1)}MB / {(stats.data.storageQuota / 1024 / 1024).toFixed(0)}MB
          </p>
        )}
        <a className="btn primary" href="/api/data/backup.zip" download>
          バックアップをダウンロード
        </a>
      </div>

      <div className="card">
        <h2>バックアップから復元</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          データが空のアカウントにのみ復元できます（既存データとの混在・上書きを防ぐため）。新しいアカウントを登録してから復元してください。復元後、件数と金額がバックアップと一致するか自動で確認します。
        </p>
        <input type="file" accept=".zip,application/zip" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} aria-label="バックアップファイル" />
        <AsyncButton
          className="btn"
          disabled={!restoreFile}
          confirm="このアカウントにバックアップを復元します。よろしいですか？"
          onClick={async () => {
            const fd = new FormData();
            fd.append('file', restoreFile!);
            const r = await api('POST', '/api/data/restore', fd);
            setRestoreResult(r);
            toast('復元しました');
          }}
        >
          復元する
        </AsyncButton>
        {restoreResult && (
          <div className="banner ok" style={{ marginTop: 8 }}>
            復元が完了しました（案件 {restoreResult.stats.counts.projects}件・請求 {restoreResult.stats.counts.invoices}件・入金 {restoreResult.stats.counts.payments}件。件数・金額の一致を確認済み）
          </div>
        )}
      </div>
    </div>
  );
}

function AccountTab() {
  const { account, logout, refresh } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [codesPw, setCodesPw] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [delPw, setDelPw] = useState('');
  const [delConfirm, setDelConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!account) return null;
  return (
    <div className="stack">
      <ErrorBanner message={error} />
      <div className="card">
        <h2>ログイン情報</h2>
        <p>
          メールアドレス：{account.email}
          <br />
          <span className="small muted">未使用の復旧コード：{account.recoveryCodesLeft}個</span>
        </p>
        <div className="btn-row">
          <AsyncButton
            className="btn"
            onClick={async () => {
              await logout();
              nav('/login');
            }}
          >
            ログアウト
          </AsyncButton>
          <AsyncButton
            className="btn"
            confirm="すべての端末からログアウトしますか？"
            onClick={async () => {
              await post('/api/auth/logout-all');
              await clearLocalData();
              window.location.href = '/login';
            }}
          >
            すべての端末からログアウト
          </AsyncButton>
        </div>
      </div>
      {!account.isDemo && (
        <>
          <div className="card stack">
            <h2>パスワード変更</h2>
            <Field label="現在のパスワード">
              <input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
            </Field>
            <Field label="新しいパスワード（10文字以上）">
              <input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
            </Field>
            <AsyncButton
              className="btn"
              onClick={async () => {
                setError(null);
                try {
                  await post('/api/auth/password', pw);
                  setPw({ currentPassword: '', newPassword: '' });
                  toast('パスワードを変更しました（他の端末はログアウトされました）');
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              変更する
            </AsyncButton>
          </div>
          <div className="card stack">
            <h2>復旧コードの再発行</h2>
            <p className="small muted" style={{ margin: 0 }}>
              再発行すると、以前の復旧コードはすべて使えなくなります。
            </p>
            {codes ? (
              <RecoveryCodes codes={codes} />
            ) : (
              <>
                <Field label="パスワード">
                  <input type="password" value={codesPw} onChange={(e) => setCodesPw(e.target.value)} />
                </Field>
                <AsyncButton
                  className="btn"
                  onClick={async () => {
                    setError(null);
                    try {
                      const r = await post('/api/auth/recovery-codes', { password: codesPw });
                      setCodes(r.recoveryCodes);
                      await refresh();
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  再発行する
                </AsyncButton>
              </>
            )}
          </div>
        </>
      )}
      <div className="card stack">
        <h2>アカウント削除</h2>
        <p className="small" style={{ margin: 0 }}>
          すべてのデータ（顧客・案件・書類・入金・添付）が完全に削除され、元に戻せません。<strong>先に「データ」タブからバックアップをダウンロードしてください。</strong>
        </p>
        <Field label="パスワード">
          <input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
        </Field>
        <Field label="確認のため「削除します」と入力">
          <input value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} />
        </Field>
        <AsyncButton
          className="btn danger solid"
          disabled={delConfirm !== '削除します' || !delPw}
          confirm="本当にアカウントとすべてのデータを削除しますか？"
          onClick={async () => {
            setError(null);
            try {
              await post('/api/auth/delete-account', { password: delPw, confirm: delConfirm });
              await clearLocalData();
              window.location.href = '/login';
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          アカウントを削除
        </AsyncButton>
      </div>
    </div>
  );
}
