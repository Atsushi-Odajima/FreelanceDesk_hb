import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, post } from '../api';
import { useApi } from '../hooks';
import { ErrorBanner, Field, Money, useToast } from '../components/ui';
import { parseCsv, parseDateLoose, parseYenAmount } from '../../../shared/csv';
import { formatDateTimeJa } from '../../../shared/dates';

type Encoding = 'utf-8' | 'shift_jis';

/**
 * 銀行明細CSVの取込（照合用）。
 * - ファイルはブラウザ内で読み込み・解析し、サーバーへは「日付・名義・入金額」だけを送る
 * - 文字コードは UTF-8（BOM可）/ Shift_JIS を利用者が選択
 * - 取込後は未割当入金になり、照合（候補表示→利用者が確定）で請求書へ割り当てる
 */
export default function BankImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [buf, setBuf] = useState<ArrayBuffer | null>(null);
  const [encoding, setEncoding] = useState<Encoding>('utf-8');
  const [hasHeader, setHasHeader] = useState(true);
  const [map, setMap] = useState<{ date: number; name: number; amount: number }>({ date: -1, name: -1, amount: -1 });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const history = useApi<{ imports: any[] }>('/api/bank-imports');
  const toast = useToast();

  const parsed = useMemo(() => {
    if (!buf) return null;
    let text: string;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(buf);
    } catch {
      return { error: `${encoding === 'utf-8' ? 'UTF-8' : 'Shift_JIS'} として読み込めません。文字コードを切り替えてください。`, rows: [] as string[][] };
    }
    const r = parseCsv(text);
    return { error: r.errors[0] ?? null, rows: r.rows };
  }, [buf, encoding]);

  const header = parsed && hasHeader ? parsed.rows[0] ?? [] : [];
  const body = parsed ? (hasHeader ? parsed.rows.slice(1) : parsed.rows) : [];
  const colCount = parsed ? Math.max(0, ...parsed.rows.slice(0, 20).map((r) => r.length)) : 0;
  const colLabel = (i: number) => (header[i] ? `${i + 1}列目：${header[i]}` : `${i + 1}列目`);

  // 見出しから列を推測（利用者が確認・変更する）
  const guess = (rows: string[][]) => {
    const h = rows[0] ?? [];
    const find = (re: RegExp) => h.findIndex((x) => re.test(x));
    setMap({ date: find(/日付|取引日|年月日|date/i), name: find(/名義|摘要|振込依頼人|内容|取引先|name/i), amount: find(/入金|お預入|預入|入金額|credit|deposit/i) });
  };

  const mapped = useMemo(() => {
    if (map.date < 0 || map.name < 0 || map.amount < 0) return null;
    const ok: Array<{ date: string; name: string; amount: number }> = [];
    let skippedEmpty = 0;
    const bad: number[] = [];
    body.forEach((r, i) => {
      const amt = parseYenAmount(r[map.amount] ?? '');
      if (amt === null || amt <= 0) {
        skippedEmpty++; // 出金行・空欄は対象外
        return;
      }
      const date = parseDateLoose(r[map.date] ?? '');
      if (!date) {
        bad.push(i + (hasHeader ? 2 : 1));
        return;
      }
      ok.push({ date, name: (r[map.name] ?? '').trim().slice(0, 200), amount: amt });
    });
    return { ok, skippedEmpty, bad };
  }, [body, map, hasHeader]);

  return (
    <div>
      <div className="page-header">
        <Link to="/payments" className="back-link">
          ‹ 入金一覧
        </Link>
        <h1>銀行CSVの取込・照合</h1>
      </div>
      <div className="banner info">
        銀行サイトからダウンロードした入出金明細CSVを読み込み、<strong>入金だけ</strong>を「未割当の入金」として登録します。請求書への割当は、候補を確認してあなたが確定します（自動では確定しません）。
        銀行へのログイン・残高取得・送金は行いません。CSVの本文はサーバーに保存されません（日付・名義・入金額のみ送信）。
      </div>
      {result ? (
        <div className="card stack">
          <div className="banner ok">
            {result.imported}件の入金を取り込みました。{result.skipped > 0 && `（取込済みの同じ明細 ${result.skipped}件はスキップ）`}
          </div>
          <div className="btn-row">
            <Link className="btn primary" to="/payments">
              照合して割り当てる
            </Link>
            <button
              className="btn"
              onClick={() => {
                setResult(null);
                setFile(null);
                setBuf(null);
              }}
            >
              別のCSVを取り込む
            </button>
          </div>
        </div>
      ) : (
        <div className="card stack">
          <h2>1. ファイルを選ぶ</h2>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label="銀行CSVファイル"
            onChange={async (e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setError(null);
              if (!f) return setBuf(null);
              if (f.size > 5 * 1024 * 1024) {
                setError('ファイルが大きすぎます（5MBまで）');
                return;
              }
              const b = await f.arrayBuffer();
              // 文字コードの推測（UTF-8として不正ならShift_JIS）
              let enc: Encoding = 'utf-8';
              try {
                new TextDecoder('utf-8', { fatal: true }).decode(b);
              } catch {
                enc = 'shift_jis';
              }
              setEncoding(enc);
              setBuf(b);
              try {
                guess(parseCsv(new TextDecoder(enc).decode(b)).rows);
              } catch {
                /* noop */
              }
            }}
          />
          <div className="form-grid cols-2">
            <Field label="文字コード" hint="文字化けする場合は切り替えてください">
              <select value={encoding} onChange={(e) => setEncoding(e.target.value as Encoding)}>
                <option value="utf-8">UTF-8（BOM付き含む）</option>
                <option value="shift_jis">Shift_JIS（多くの銀行の既定）</option>
              </select>
            </Field>
            <label className="check">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              1行目は見出し
            </label>
          </div>
          <ErrorBanner message={error ?? parsed?.error} />

          {parsed && parsed.rows.length > 0 && (
            <>
              <h2>2. 列を指定する</h2>
              <div className="form-grid cols-3">
                {(
                  [
                    ['date', '日付の列'],
                    ['name', '名義（摘要）の列'],
                    ['amount', '入金額の列'],
                  ] as Array<[keyof typeof map, string]>
                ).map(([k, label]) => (
                  <Field key={k} label={label}>
                    <select value={map[k]} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })} aria-label={label}>
                      <option value={-1}>選択してください</option>
                      {Array.from({ length: colCount }, (_, i) => (
                        <option key={i} value={i}>
                          {colLabel(i)}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      {Array.from({ length: colCount }, (_, i) => (
                        <th key={i}>
                          {colLabel(i)}
                          {map.date === i && ' 【日付】'}
                          {map.name === i && ' 【名義】'}
                          {map.amount === i && ' 【入金額】'}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.slice(0, 5).map((r, i) => (
                      <tr key={i}>
                        {Array.from({ length: colCount }, (_, j) => (
                          <td key={j} className="small">
                            {r[j]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted">先頭5行を表示しています（全{body.length}行）。</p>
            </>
          )}

          {mapped && (
            <>
              <h2>3. 取り込む</h2>
              <p>
                入金 <strong>{mapped.ok.length}件</strong>（合計 <Money v={mapped.ok.reduce((a, r) => a + r.amount, 0)} />）を取り込みます。
                <span className="small muted">出金・空欄の行 {mapped.skippedEmpty}件は対象外。</span>
              </p>
              {mapped.bad.length > 0 && <div className="banner warn">日付を読み取れない行があります（{mapped.bad.slice(0, 10).join('、')}行目）。これらは取り込みません。</div>}
              <button
                className="btn primary"
                disabled={busy || mapped.ok.length === 0}
                data-testid="import-bank"
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const r = await post('/api/bank-imports', {
                      filename: file?.name ?? '',
                      encoding,
                      mapping: { ...map, hasHeader },
                      rowCount: body.length,
                      rows: mapped.ok,
                    });
                    setResult(r);
                    toast(`${r.imported}件を取り込みました`);
                    await history.reload();
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? '取込中…' : '未割当の入金として取り込む'}
              </button>
            </>
          )}
        </div>
      )}
      <div className="card">
        <h2>取込履歴</h2>
        {(history.data?.imports ?? []).length === 0 ? (
          <div className="empty">まだ取り込んでいません</div>
        ) : (
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {history.data!.imports.map((h) => (
              <li key={h.id} className="small">
                {formatDateTimeJa(h.createdAt)}・{h.filename || '（ファイル名なし）'}・取込 {h.importedCount}件／重複スキップ {h.skippedCount}件
              </li>
            ))}
          </ul>
        )}
        <p className="small muted">同じ内容のCSVは二重に取り込めません。期間が重なるCSVでは、取込済みの明細を自動でスキップします。</p>
      </div>
    </div>
  );
}
