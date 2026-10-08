// FreelanceDesk ヒアリング — お客様向け画面（クライアントポータル内 /portal/p/:pid/intake/:iid）
// 質問への回答・ファイル提出・不足の確認・追加質問への回答・送信。サーバーが常に正（保存時に再検証）。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, del, post, put } from '../api';
import { useApi } from '../hooks';
import { AsyncButton, DateText, ErrorBanner, Loading, useToast } from '../components/ui';
import { IntakeQuestions, ITEM_STATUS_COLOR, changedAnswers, formatsText } from '../components/IntakeForm';
import { NeedLink, Shell } from './Portal';
import type { Answers, RequiredItem } from '../../../shared/intake/types';

const API = '/api/portal';

export function intakeClientLabel(status: string) {
  const m: Record<string, string> = {
    sent: 'ご回答をお待ちしています',
    in_progress: 'ご回答中',
    needs_client: 'ご対応をお願いします',
    needs_internal_review: '担当者が確認中です',
    ready: '必要な情報がそろいました',
    started: '受付を終了しました',
    cancelled: '受付を終了しました',
  };
  return m[status] ?? status;
}

const FILE_STATUS: Record<string, string> = { pending_review: '確認待ち', accepted: '確認済み', rejected: '差し戻し' };

export function PortalIntakePage() {
  const { pid = '', iid = '' } = useParams();
  const base = `${API}/projects/${pid}/intakes/${iid}`;
  const proj = useApi<any>(`${API}/projects/${pid}`, [pid]);
  const { data: d, error, loading, status, reload } = useApi<any>(base, [base]);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [fuAnswers, setFuAnswers] = useState<Record<string, string>>({});
  const toast = useToast();
  useEffect(() => {
    if (d) setAnswers(d.answers);
  }, [d]);
  if ((loading && !d) || (proj.loading && !proj.data)) return <Loading />;
  if (status === 401 || proj.status === 401) return <NeedLink />;
  if (error || !d) return <NeedLink message={error} />;
  const closed: boolean = d.intake.closed;
  const dirty = Object.keys(changedAnswers(d.answers, answers)).length > 0;

  const save = async (quiet = false) => {
    const changes = changedAnswers(d.answers, answers);
    if (!Object.keys(changes).length) return true;
    const r = await put(`${base}/answers`, { answers: changes });
    const errs: Record<string, string> = {};
    for (const e of r.errors) errs[e.questionId] = e.message;
    setErrors(errs);
    await reload();
    if (r.errors.length) {
      setMsg(`${r.errors.length}件の回答を保存できませんでした。赤字の内容をご確認ください。`);
      return false;
    }
    setMsg(null);
    if (!quiet) toast('保存しました');
    return true;
  };

  const fileSlot = (item: RequiredItem) => {
    const mine = d.files.filter((f: any) => f.itemId === item.id);
    const ev = d.items.find((i: any) => i.itemId === item.id);
    return (
      <div className="stack" style={{ gap: 6 }}>
        <span className="hint">
          {formatsText(item)}
          {item.notes ? `　${item.notes}` : ''}
        </span>
        {ev && (
          <span>
            <span className={`badge ${ITEM_STATUS_COLOR[ev.status]}`} data-testid={`item-status-${item.id}`}>
              {ev.statusLabel}
              {ev.type === 'file' && ev.applicable ? `（${ev.count}/${ev.minCount}）` : ''}
            </span>
          </span>
        )}
        {ev?.note && <div className="banner error">差し戻し理由：{ev.note}</div>}
        {mine.map((f: any) => (
          <div key={f.id} className="row between file-row">
            <a href={f.url} className="small">
              {f.filename}
            </a>
            <span className="row" style={{ gap: 6 }}>
              <span className={`badge ${f.status === 'rejected' ? 'red' : f.status === 'accepted' ? 'green' : ''}`}>{FILE_STATUS[f.status]}</span>
              {!closed && f.status === 'pending_review' && f.uploadedBy === 'client' && (
                <AsyncButton
                  className="btn sm ghost"
                  confirm={`「${f.filename}」を取り消しますか？`}
                  onClick={async () => {
                    await del(`${base}/files/${f.id}`);
                    await reload();
                  }}
                >
                  取り消す
                </AsyncButton>
              )}
            </span>
            {f.reviewNote && <div className="small err">差し戻し理由：{f.reviewNote}</div>}
          </div>
        ))}
        {!closed && (
          <label className="btn sm file-btn">
            ファイルを選ぶ
            <input
              type="file"
              multiple
              accept={(item.acceptedFormats ?? []).map((x) => `.${x}`).join(',') || undefined}
              aria-label={`${item.label}を提出`}
              style={{ display: 'none' }}
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                for (const file of files) {
                  const fd = new FormData();
                  fd.append('file', file);
                  try {
                    await api('POST', `${base}/items/${encodeURIComponent(item.id)}/files`, fd);
                  } catch (err) {
                    toast(`${file.name}：${(err as Error).message}`, 'error');
                  }
                }
                await reload();
              }}
            />
          </label>
        )}
      </div>
    );
  };

  const openItems = d.items.filter((i: any) => i.applicable && i.required && i.status !== 'accepted' && i.status !== 'submitted' && i.status !== 'needs_review');
  return (
    <Shell business={proj.data?.business} onLogout>
      <Link to={`/portal/p/${pid}`} className="small">
        ← {proj.data?.project?.title ?? '案件'} に戻る
      </Link>
      <div className="card">
        <h1 style={{ margin: '4px 0' }}>{d.intake.title}</h1>
        <div className="row">
          <span className={`badge ${d.intake.status === 'ready' ? 'green' : d.intake.status === 'needs_client' ? 'red' : 'blue'}`} data-testid="intake-status">
            {intakeClientLabel(d.intake.status)}
          </span>
          <span className="small" data-testid="intake-progress">
            必要項目 {d.intake.progress.submitted}/{d.intake.progress.denominator} 提出済み（{d.intake.progress.percent}%）
          </span>
          {d.intake.dueDate && (
            <span className="small muted">
              回答期限 <DateText v={d.intake.dueDate} />
            </span>
          )}
        </div>
        {d.definition.intro && <p className="pre small">{d.definition.intro}</p>}
        {d.intake.submittedAt && d.definition.completionMessage && <div className="banner ok">{d.definition.completionMessage}</div>}
      </div>

      {openItems.length > 0 && (
        <div className="card" data-testid="intake-missing">
          <h2 style={{ marginTop: 0 }}>まだ足りないもの</h2>
          <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
            {openItems.map((i: any) => (
              <li key={i.itemId}>
                {i.label}：{i.statusLabel}
                {i.type === 'file' ? `（${i.count}/${i.minCount}）` : i.total ? `（${i.answered}/${i.total}）` : ''}
                {i.note && <span className="err">　差し戻し理由：{i.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.followups.length > 0 && (
        <div className="card" data-testid="intake-followups">
          <h2 style={{ marginTop: 0 }}>追加のご質問</h2>
          <div className="stack">
            {d.followups.map((f: any) => (
              <div key={f.id} className="comment">
                <div className="pre">{f.text}</div>
                {f.status === 'answered' && <div className="small muted">回答済み：{typeof f.answer === 'string' ? f.answer : JSON.stringify(f.answer)}</div>}
                {!closed && (
                  <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                    {Array.isArray(f.options) && f.options.length > 0 && (
                      <div className="btn-row">
                        {f.options.map((o: string) => (
                          <button key={o} type="button" className="btn sm" onClick={() => setFuAnswers({ ...fuAnswers, [f.id]: o })}>
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                    <textarea rows={2} aria-label="追加のご質問への回答" value={fuAnswers[f.id] ?? ''} onChange={(e) => setFuAnswers({ ...fuAnswers, [f.id]: e.target.value })} />
                    <AsyncButton
                      className="btn sm primary"
                      disabled={!(fuAnswers[f.id] ?? '').trim()}
                      onClick={async () => {
                        await post(`${base}/followups/${f.id}/answer`, { answer: fuAnswers[f.id].trim() });
                        setFuAnswers({ ...fuAnswers, [f.id]: '' });
                        toast('回答を送信しました');
                        await reload();
                      }}
                    >
                      回答を送る
                    </AsyncButton>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {closed && <div className="banner info">このヒアリングの受付は終了しました。内容の変更は担当者にご連絡ください。</div>}
      <ErrorBanner message={msg} />
      <IntakeQuestions
        def={d.definition}
        answers={answers}
        readOnly={closed}
        serverErrors={errors}
        onChange={(qid, v) => {
          setAnswers((a) => ({ ...a, [qid]: v }));
          setErrors((e) => {
            const n = { ...e };
            delete n[qid];
            return n;
          });
        }}
        fileSlot={fileSlot}
      />
      {!closed && (
        <div className="card sticky-actions">
          <div className="btn-row">
            <AsyncButton className="btn" disabled={!dirty} onClick={() => save()}>
              一時保存
            </AsyncButton>
            <AsyncButton
              className="btn primary"
              onClick={async () => {
                if (!(await save(true))) return;
                const r = await post(`${base}/submit`);
                await reload();
                toast(r.complete ? '送信しました。ありがとうございました' : '送信しました（まだ足りないものがあります）');
              }}
            >
              内容を送信する
            </AsyncButton>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            途中で保存して、後から続きを入力できます。ファイルは選んだ時点で提出されます。
          </p>
        </div>
      )}
    </Shell>
  );
}
