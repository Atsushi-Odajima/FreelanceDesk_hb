// FreelanceDesk ヒアリング／FreelanceDesk 案件開始パック — 運営者画面
//   IntakeTab：案件詳細の「ヒアリング」タブ（作成・公開・不足の確認・承認/差し戻し・回答チェック・追加質問・Ready・パック）
//   IntakeTemplatesPage：テンプレート（サンプルから作成・質問とファイル項目の編集・JSON編集）
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, del, newRequestId, post, put } from '../api';
import { useApi } from '../hooks';
import { AsyncButton, DateText, Empty, ErrorBanner, Field, Loading, useToast } from '../components/ui';
import { IntakeQuestions, ITEM_STATUS_COLOR, answerText, changedAnswers } from '../components/IntakeForm';
import { STATUS_LABEL } from '../../../shared/intake/completeness';
import { INTAKE_STATUS_LABEL, PROFILE_LABEL } from '../../../shared/intake/package';
import { evaluateLogic } from '../../../shared/intake/logic';
import { lintDefinition, QUESTION_TYPE_LABEL } from '../../../shared/intake/lint';
import { QUESTION_TYPES, type Answers, type HandoffProfile, type Question, type RequiredItem, type TemplateDefinition } from '../../../shared/intake/types';
import { formatDateTimeJa } from '../../../shared/dates';

const STATUS_COLOR: Record<string, string> = {
  draft: '',
  sent: 'blue',
  in_progress: 'blue',
  needs_client: 'yellow',
  needs_internal_review: 'yellow',
  ready: 'green',
  started: 'green',
  cancelled: '',
};
const CANDIDATE_KIND: Record<string, string> = { follow_up: '追加質問の候補', ambiguous: '曖昧な回答', contradiction: '矛盾の可能性', missing: '不足' };
const FILE_STATUS: Record<string, string> = { pending_review: '確認待ち', accepted: '承認済み', rejected: '差し戻し' };

// ---------------------------------------------------------------- 案件詳細「ヒアリング」タブ

export function IntakeTab({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
  const base = `/api/projects/${projectId}/intakes`;
  const list = useApi<any>(base, [projectId]);
  const tpl = useApi<any>('/api/intake-templates', []);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ source: 'sample:web', title: '', dueDate: '' });
  const toast = useToast();
  useEffect(() => {
    if (!selected && list.data?.intakes?.length) setSelected(list.data.intakes[list.data.intakes.length - 1].id);
  }, [list.data, selected]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error || !list.data) return <ErrorBanner message={list.error} />;
  const refresh = async () => {
    await list.reload();
    onChanged?.();
  };
  return (
    <div className="stack" data-testid="intake-tab">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>FreelanceDesk ヒアリング</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          仕事を始めるために必要な情報・ファイルをお客様から回収し、足りないものを確認して「案件開始パック」にまとめます。お客様はクライアントポータルから回答・提出します（ポータルの公開と招待リンクは「クライアントポータル」タブで行います）。
        </p>
        {list.data.intakes.length > 0 && (
          <div className="list">
            {list.data.intakes.map((ik: any) => (
              <button key={ik.id} type="button" className={`list-item ${selected === ik.id ? 'active' : ''}`} style={{ textAlign: 'left' }} onClick={() => setSelected(ik.id)}>
                <div className="row between">
                  <span className="title">{ik.title}</span>
                  <span className={`badge ${STATUS_COLOR[ik.status]}`}>{ik.statusLabel}</span>
                </div>
                <div className="meta">
                  提出 {ik.progress?.submitted ?? 0}/{ik.progress?.denominator ?? 0}・承認 {ik.progress?.accepted ?? 0}/{ik.progress?.denominator ?? 0}
                  {ik.sharedAt ? '・公開中' : '・非公開'}
                  {ik.missingSummary ? `・${ik.missingSummary}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
        <details style={{ marginTop: 10 }} open={list.data.intakes.length === 0}>
          <summary>ヒアリングを追加</summary>
          <div className="grid cols-2" style={{ marginTop: 8 }}>
            <Field label="テンプレート">
              <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} data-testid="intake-template-select">
                <optgroup label="自分のテンプレート">
                  {(tpl.data?.templates ?? [])
                    .filter((t: any) => !t.archivedAt)
                    .map((t: any) => (
                      <option key={t.id} value={`tpl:${t.id}`}>
                        {t.name}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="サンプル">
                  {(tpl.data?.samples ?? []).map((x: any) => (
                    <option key={x.key} value={`sample:${x.key}`}>
                      {x.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <Field label="名前（空欄ならテンプレート名）">
              <input value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="回答期限（任意）">
              <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </Field>
          </div>
          <div className="btn-row">
            <AsyncButton
              className="btn primary sm"
              onClick={async () => {
                const [kind, key] = form.source.split(':');
                const r = await post(base, { requestId: newRequestId(), title: form.title, dueDate: form.dueDate || null, ...(kind === 'tpl' ? { templateId: key } : { sampleKey: key }) });
                setSelected(r.id);
                setForm({ ...form, title: '', dueDate: '' });
                toast('ヒアリングを作成しました');
                await refresh();
              }}
            >
              作成
            </AsyncButton>
            <Link to="/intake-templates" className="btn sm ghost">
              テンプレートを管理
            </Link>
          </div>
        </details>
      </div>
      {selected && <IntakeDetail key={selected} projectId={projectId} intakeId={selected} onChanged={refresh} onDeleted={() => setSelected(null)} />}
    </div>
  );
}

function IntakeDetail({ projectId, intakeId, onChanged, onDeleted }: { projectId: string; intakeId: string; onChanged: () => Promise<void>; onDeleted: () => void }) {
  const base = `/api/projects/${projectId}/intakes/${intakeId}`;
  const { data: d, error, loading, reload } = useApi<any>(base, [base]);
  const toast = useToast();
  const [editing, setEditing] = useState<Answers | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [fuText, setFuText] = useState('');
  const [candText, setCandText] = useState<Record<string, string>>({});
  const [overrideReason, setOverrideReason] = useState('');
  const [profile, setProfile] = useState<string>('');
  const [preview, setPreview] = useState<string | null>(null);
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBanner message={error} />;
  const refresh = async () => {
    await reload();
    await onChanged();
  };
  const def: TemplateDefinition = d.definition;
  const ik = d.intake;
  const c = d.completeness;
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const itemLabel = (id: string) => def.requiredItems.find((i) => i.id === id)?.label ?? id;
  const note = (k: string) => (notes[k] ?? '').trim();
  const closed = ik.status === 'started' || ik.status === 'cancelled';

  return (
    <div className="stack" data-testid="intake-detail">
      <div className="card">
        <div className="row between">
          <h3 style={{ margin: 0 }}>{ik.title}</h3>
          <span className={`badge ${STATUS_COLOR[ik.status]}`} data-testid="intake-op-status">
            {INTAKE_STATUS_LABEL[ik.status] ?? ik.status}
          </span>
        </div>
        <div className="small" style={{ margin: '6px 0' }} data-testid="intake-op-progress">
          必要項目：提出 {c.progress.submitted}/{c.progress.denominator}（{c.progress.percent}%）・承認 {c.progress.accepted}/{c.progress.denominator}
          {c.progress.notApplicable ? `・対象外 ${c.progress.notApplicable}` : ''}
          {ik.dueDate && (
            <>
              ・回答期限 <DateText v={ik.dueDate} />
            </>
          )}
        </div>
        {ik.missingSummary && <div className="small muted">足りないもの：{ik.missingSummary}</div>}
        <div className="btn-row" style={{ marginTop: 8 }}>
          {ik.sharedAt ? (
            <AsyncButton
              className="btn sm"
              confirm="お客様のポータルからこのヒアリングを非表示にしますか？（回答・ファイルは残ります）"
              onClick={async () => {
                await post(`${base}/share`, { shared: false });
                await refresh();
              }}
            >
              お客様に非公開にする
            </AsyncButton>
          ) : (
            <AsyncButton
              className="btn primary sm"
              disabled={closed}
              onClick={async () => {
                await post(`${base}/share`, { shared: true });
                toast('クライアントポータルに公開しました');
                await refresh();
              }}
            >
              お客様に公開する
            </AsyncButton>
          )}
          <span className="small muted">{ik.sharedAt ? `公開：${formatDateTimeJa(ik.sharedAt)}` : 'クライアントポータルの公開・招待リンクが必要です'}</span>
        </div>
      </div>

      <div className="card" data-testid="intake-ready">
        <h3 style={{ marginTop: 0 }}>開始可能（Ready）の判定</h3>
        {c.ready.ready || ik.readyOverride ? (
          <div className="banner ok">
            開始可能です{ik.readyOverride ? `（上書き：${ik.readyOverride.reason}）` : ''}
            {ik.internalSignoffAt ? `・サインオフ ${formatDateTimeJa(ik.internalSignoffAt)}` : ''}
          </div>
        ) : (
          <ul className="small" style={{ paddingLeft: 18, margin: 0 }} data-testid="ready-reasons">
            {c.ready.reasons.map((r: any, i: number) => (
              <li key={i}>{r.message}</li>
            ))}
          </ul>
        )}
        {c.ready.warnings.map((w: any, i: number) => (
          <div key={i} className="small muted">
            {w.message}
          </div>
        ))}
        {!closed && (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className="btn-row">
              <AsyncButton
                className="btn sm primary"
                disabled={!c.ready.reasons.every((r: any) => r.code === 'SIGNOFF_REQUIRED') || c.ready.ready}
                onClick={async () => {
                  await post(`${base}/signoff`, { note: '' });
                  toast('サインオフしました');
                  await refresh();
                }}
              >
                内容を確認してサインオフ
              </AsyncButton>
              <AsyncButton
                className="btn sm"
                disabled={ik.status !== 'ready'}
                confirm="開始済みにすると、お客様は回答・提出を変更できなくなります。よろしいですか？"
                onClick={async () => {
                  await post(`${base}/close`, { to: 'started' });
                  await refresh();
                }}
              >
                開始済みにする（受付終了）
              </AsyncButton>
            </div>
            {!c.ready.ready && !ik.readyOverride && (
              <div className="row" style={{ gap: 6 }}>
                <input placeholder="上書きの理由（5文字以上）" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="上書きの理由" />
                <AsyncButton
                  className="btn sm"
                  disabled={overrideReason.trim().length < 5}
                  onClick={async () => {
                    await post(`${base}/override`, { reason: overrideReason });
                    setOverrideReason('');
                    await refresh();
                  }}
                >
                  理由を記録して Ready にする
                </AsyncButton>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" data-testid="intake-items">
        <h3 style={{ marginTop: 0 }}>必要項目と提出物</h3>
        <div className="stack">
          {c.items.map((it: any) => {
            const files = d.files.filter((f: any) => f.itemId === it.itemId);
            return (
              <div key={it.itemId} className="comment" data-testid={`op-item-${it.itemId}`}>
                <div className="row between">
                  <strong>
                    {it.label}
                    {!it.required && <span className="small muted">（任意）</span>}
                  </strong>
                  <span className={`badge ${ITEM_STATUS_COLOR[it.status]}`}>
                    {STATUS_LABEL[it.status as keyof typeof STATUS_LABEL]}
                    {it.type === 'file' && it.applicable ? `（${it.count}/${it.minCount}）` : it.type === 'question' && it.total ? `（${it.answered}/${it.total}）` : ''}
                  </span>
                </div>
                {it.note && <div className="small muted">メモ：{it.note}</div>}
                {it.type === 'question' &&
                  (def.requiredItems.find((x) => x.id === it.itemId)?.questionIds ?? (it.itemId.startsWith('q:') ? [it.itemId.slice(2)] : [])).map((qid: string) => {
                    const q = qById.get(qid);
                    if (!q || c.logic.visible[qid] === false) return null;
                    return (
                      <div key={qid} className="small">
                        <span className="muted">{q.label}：</span>
                        <span className="pre">{answerText(q, c.logic.effectiveAnswers[qid])}</span>
                      </div>
                    );
                  })}
                {files.map((f: any) => (
                  <div key={f.id} className="row between file-row">
                    <a href={f.url} className="small">
                      {f.filename}
                    </a>
                    <span className="row" style={{ gap: 4 }}>
                      <span className={`badge ${f.status === 'rejected' ? 'red' : f.status === 'accepted' ? 'green' : ''}`}>{FILE_STATUS[f.status]}</span>
                      {f.status !== 'accepted' && (
                        <AsyncButton
                          className="btn sm"
                          onClick={async () => {
                            await post(`${base}/files/${f.id}/review`, { decision: 'accept' });
                            await refresh();
                          }}
                        >
                          承認
                        </AsyncButton>
                      )}
                      {f.status !== 'rejected' && (
                        <AsyncButton
                          className="btn sm ghost"
                          onClick={async () => {
                            const n = window.prompt('差し戻し理由（お客様に表示されます）');
                            if (!n?.trim()) return;
                            await post(`${base}/files/${f.id}/review`, { decision: 'reject', note: n });
                            await refresh();
                          }}
                        >
                          差し戻し
                        </AsyncButton>
                      )}
                    </span>
                    {f.reviewNote && <div className="small muted">差し戻し理由：{f.reviewNote}</div>}
                  </div>
                ))}
                {!closed && (
                  <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                    <input
                      placeholder="差し戻し・対象外の理由"
                      value={notes[it.itemId] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [it.itemId]: e.target.value })}
                      style={{ flex: 1, minWidth: 140 }}
                      aria-label={`${it.label}の理由`}
                    />
                    {it.status !== 'accepted' && it.applicable && (
                      <AsyncButton
                        className="btn sm"
                        onClick={async () => {
                          await post(`${base}/items/${encodeURIComponent(it.itemId)}/review`, { decision: 'accept' });
                          await refresh();
                        }}
                      >
                        項目を承認
                      </AsyncButton>
                    )}
                    <AsyncButton
                      className="btn sm ghost"
                      disabled={!note(it.itemId)}
                      onClick={async () => {
                        await post(`${base}/items/${encodeURIComponent(it.itemId)}/review`, { decision: 'reject', note: note(it.itemId) });
                        setNotes({ ...notes, [it.itemId]: '' });
                        await refresh();
                      }}
                    >
                      差し戻す
                    </AsyncButton>
                    {it.applicable ? (
                      <AsyncButton
                        className="btn sm ghost"
                        disabled={!note(it.itemId)}
                        onClick={async () => {
                          await post(`${base}/items/${encodeURIComponent(it.itemId)}/review`, { decision: 'not_applicable', note: note(it.itemId) });
                          await refresh();
                        }}
                      >
                        対象外にする
                      </AsyncButton>
                    ) : (
                      <AsyncButton
                        className="btn sm ghost"
                        onClick={async () => {
                          await post(`${base}/items/${encodeURIComponent(it.itemId)}/review`, { decision: 'reopen' });
                          await refresh();
                        }}
                      >
                        対象に戻す
                      </AsyncButton>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" data-testid="intake-checks">
        <div className="row between">
          <h3 style={{ margin: 0 }}>回答チェック・追加質問</h3>
          <AsyncButton
            className="btn sm"
            onClick={async () => {
              const r = await post(`${base}/check`);
              toast(r.created ? `確認候補が${r.created}件見つかりました` : '新しい確認候補はありません');
              await refresh();
            }}
          >
            回答をチェック
          </AsyncButton>
        </div>
        <p className="small muted">決まったルールで曖昧な回答・矛盾の可能性を探します（外部送信なし）。結果は候補で、回答の自動修正やお客様への自動送信はしません。</p>
        {d.candidates.filter((x: any) => x.status === 'open').length === 0 ? (
          <Empty>未処理の確認候補はありません</Empty>
        ) : (
          <div className="stack">
            {d.candidates
              .filter((x: any) => x.status === 'open')
              .map((x: any) => (
                <div key={x.id} className="comment" data-testid="intake-candidate">
                  <div className="small">
                    <span className="badge yellow">{CANDIDATE_KIND[x.kind] ?? x.kind}</span> {x.payload.stale && <span className="badge">回答が更新されています</span>}
                  </div>
                  <div className="pre">{x.payload.text}</div>
                  {x.payload.reason && <div className="small muted">理由：{x.payload.reason}</div>}
                  {x.kind !== 'contradiction' && (
                    <textarea rows={2} aria-label="お客様への質問文" value={candText[x.id] ?? x.payload.text} onChange={(e) => setCandText({ ...candText, [x.id]: e.target.value })} />
                  )}
                  <div className="btn-row">
                    <AsyncButton
                      className="btn sm primary"
                      onClick={async () => {
                        await post(`${base}/candidates/${x.id}/resolve`, { decision: 'send_to_client', text: candText[x.id] ?? x.payload.text });
                        await refresh();
                      }}
                    >
                      お客様に質問する
                    </AsyncButton>
                    <AsyncButton
                      className="btn sm"
                      onClick={async () => {
                        await post(`${base}/candidates/${x.id}/resolve`, { decision: 'resolve' });
                        await refresh();
                      }}
                    >
                      社内で解決
                    </AsyncButton>
                    <AsyncButton
                      className="btn sm ghost"
                      onClick={async () => {
                        await post(`${base}/candidates/${x.id}/resolve`, { decision: 'dismiss' });
                        await refresh();
                      }}
                    >
                      却下
                    </AsyncButton>
                  </div>
                </div>
              ))}
          </div>
        )}
        <h4>追加質問</h4>
        {d.followups.length === 0 && <div className="small muted">まだありません</div>}
        {d.followups.map((f: any) => (
          <div key={f.id} className="comment" data-testid="intake-followup">
            <div className="row between">
              <span className="pre">{f.text}</span>
              <span className="badge">{{ open: '回答待ち', answered: '回答あり', resolved: '解決済み', cancelled: '取消' }[f.status as string]}</span>
            </div>
            {f.answer !== null && f.answer !== undefined && <div className="small">回答：{typeof f.answer === 'string' ? f.answer : JSON.stringify(f.answer)}</div>}
            {(f.status === 'open' || f.status === 'answered') && (
              <div className="btn-row">
                {f.status === 'answered' && f.questionId && (
                  <AsyncButton
                    className="btn sm primary"
                    onClick={async () => {
                      await post(`${base}/followups/${f.id}/resolve`, { decision: 'resolve', applyToQuestion: true });
                      await refresh();
                    }}
                  >
                    元の回答に追記して解決
                  </AsyncButton>
                )}
                <AsyncButton
                  className="btn sm"
                  onClick={async () => {
                    await post(`${base}/followups/${f.id}/resolve`, { decision: 'resolve' });
                    await refresh();
                  }}
                >
                  解決にする
                </AsyncButton>
                <AsyncButton
                  className="btn sm ghost"
                  onClick={async () => {
                    await post(`${base}/followups/${f.id}/resolve`, { decision: 'cancel' });
                    await refresh();
                  }}
                >
                  取り消す
                </AsyncButton>
              </div>
            )}
          </div>
        ))}
        {!closed && (
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <input placeholder="お客様への追加の質問" value={fuText} maxLength={2000} onChange={(e) => setFuText(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="追加の質問" />
            <AsyncButton
              className="btn sm"
              disabled={!fuText.trim()}
              onClick={async () => {
                await post(`${base}/followups`, { text: fuText });
                setFuText('');
                await refresh();
              }}
            >
              質問を送る
            </AsyncButton>
          </div>
        )}
      </div>

      <div className="card" data-testid="intake-answers">
        <div className="row between">
          <h3 style={{ margin: 0 }}>回答</h3>
          {!closed &&
            (editing ? (
              <span className="btn-row">
                <AsyncButton
                  className="btn sm primary"
                  onClick={async () => {
                    const r = await put(`${base}/answers`, { answers: changedAnswers(d.answers, editing) });
                    if (r.errors.length) toast(`${r.errors.length}件は形式エラーのため保存していません：${r.errors.map((e: any) => e.message).join('、')}`, 'error');
                    setEditing(null);
                    await refresh();
                  }}
                >
                  回答を保存
                </AsyncButton>
                <button className="btn sm ghost" onClick={() => setEditing(null)}>
                  やめる
                </button>
              </span>
            ) : (
              <button className="btn sm ghost" onClick={() => setEditing({ ...d.answers })}>
                運営者が回答を入力・修正
              </button>
            ))}
        </div>
        {editing ? (
          <IntakeQuestions def={def} answers={editing} onChange={(qid, v) => setEditing((a) => ({ ...(a ?? {}), [qid]: v }))} />
        ) : (
          <AnswersTable def={def} answers={d.answers} />
        )}
      </div>

      <div className="card" data-testid="intake-package">
        <h3 style={{ marginTop: 0 }}>FreelanceDesk 案件開始パック</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          回答・提出物を出典付きでまとめます（制作担当・Claude Code などへの引き継ぎ用）。未回答は Unknown、未確定は Open Questions に入ります。
        </p>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <select value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="引き継ぎ先のプロファイル">
            <option value="">プロファイル：テンプレートの既定（{PROFILE_LABEL[def.packageTemplate?.profile as HandoffProfile] ?? '—'}）</option>
            {Object.entries(PROFILE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <AsyncButton
            className="btn sm primary"
            onClick={async () => {
              const r = await post(`${base}/packages`, profile ? { profile } : {});
              setPreview(r.markdown);
              toast(`案件開始パック v${r.version} を作成しました`);
              await refresh();
            }}
          >
            案件開始パックを作成
          </AsyncButton>
          <a className="btn sm" href={`${base}/files.zip`}>
            提出ファイルをZIPで保存
          </a>
        </div>
        {ik.status !== 'ready' && ik.status !== 'started' && <div className="small muted">※ まだ Ready ではありません。足りないものは Open Questions として記載されます。</div>}
        {d.packages.length > 0 && (
          <ul className="small" style={{ paddingLeft: 18 }} data-testid="package-list">
            {d.packages.map((p: any) => (
              <li key={p.id}>
                v{p.version}（{PROFILE_LABEL[p.profile as HandoffProfile] ?? p.profile}・{formatDateTimeJa(p.createdAt)}）{' '}
                <a href={`${base}/packages/${p.id}?format=md`}>Markdown</a> ／ <a href={`${base}/packages/${p.id}?format=txt`}>テキスト</a> ／{' '}
                <button
                  type="button"
                  className="btn sm ghost"
                  style={{ minHeight: 0, padding: 0 }}
                  onClick={async () => {
                    const r = await api('GET', `${base}/packages/${p.id}`);
                    setPreview(r.markdown);
                  }}
                >
                  表示
                </button>
              </li>
            ))}
          </ul>
        )}
        {preview && (
          <>
            <div className="btn-row">
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  await navigator.clipboard?.writeText(preview);
                  toast('コピーしました');
                }}
              >
                Markdownをコピー
              </button>
            </div>
            <pre className="package-preview" data-testid="package-preview">
              {preview}
            </pre>
          </>
        )}
      </div>

      <div className="btn-row">
        {!closed && (
          <AsyncButton
            className="btn sm ghost"
            confirm="このヒアリングを中止しますか？（お客様のポータルから非表示になります）"
            onClick={async () => {
              await post(`${base}/close`, { to: 'cancelled' });
              await refresh();
            }}
          >
            中止する
          </AsyncButton>
        )}
        <AsyncButton
          className="btn sm ghost danger"
          confirm="このヒアリングを削除しますか？回答・提出ファイル・案件開始パックも削除され、元に戻せません。"
          onClick={async () => {
            await del(base);
            onDeleted();
            await onChanged();
          }}
        >
          削除
        </AsyncButton>
      </div>
    </div>
  );
}

function AnswersTable({ def, answers }: { def: TemplateDefinition; answers: Answers }) {
  const logic = evaluateLogic(def, answers);
  const qs = def.questions.filter((q) => q.type !== 'file' && q.type !== 'image');
  return (
    <div className="table-wrap">
      <table className="table">
        <tbody>
          {qs.map((q) => {
            const hidden = logic.visible[q.id] === false;
            if (hidden && answers[q.id] === undefined) return null;
            return (
              <tr key={q.id} style={hidden ? { opacity: 0.5 } : undefined}>
                <th style={{ width: '35%' }}>
                  {q.label}
                  {hidden && <span className="small muted">（非表示）</span>}
                </th>
                <td className="pre">{answerText(q, answers[q.id])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- テンプレート

export function IntakeTemplatesPage() {
  const { data, error, loading, reload } = useApi<any>('/api/intake-templates', []);
  const nav = useNavigate();
  const toast = useToast();
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBanner message={error} />;
  const create = async (body: object) => {
    const r = await post('/api/intake-templates', { requestId: newRequestId(), ...body });
    toast('テンプレートを作成しました');
    nav(`/intake-templates/${r.template.id}`);
  };
  return (
    <div>
      <div className="page-header">
        <h1>ヒアリングのテンプレート</h1>
      </div>
      <p className="small muted">FreelanceDesk ヒアリングで使う「必要な情報（質問）」と「必要なファイル」の定義です。案件にヒアリングを作成した時点の内容がコピーされるため、テンプレートを変更しても作成済みのヒアリングには影響しません。</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>自分のテンプレート</h2>
        {data.templates.length === 0 ? (
          <Empty>まだありません。下のサンプルから作成できます</Empty>
        ) : (
          <div className="list">
            {data.templates.map((t: any) => (
              <Link key={t.id} to={`/intake-templates/${t.id}`} className="list-item">
                <div className="row between">
                  <span className="title">{t.name}</span>
                  {t.archivedAt && <span className="badge">アーカイブ</span>}
                </div>
                <div className="meta">
                  質問 {t.questionCount}・ファイル項目 {t.fileItemCount}
                </div>
              </Link>
            ))}
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 8 }}>
          <AsyncButton className="btn sm" onClick={() => create({ name: '新しいヒアリング' })}>
            空のテンプレートを作成
          </AsyncButton>
        </div>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>サンプル</h2>
        <p className="small muted">サンプルは出発点です。業種ごとの法的な必要書類を網羅することは保証しません。</p>
        <div className="list">
          {data.samples.map((x: any) => (
            <div key={x.key} className="list-item">
              <div className="row between">
                <span className="title">{x.name}</span>
                <AsyncButton className="btn sm" onClick={() => create({ sampleKey: x.key })}>
                  これを元に作成
                </AsyncButton>
              </div>
              <div className="meta">{x.description}</div>
            </div>
          ))}
        </div>
      </div>
      <button type="button" className="btn ghost sm" onClick={() => void reload()}>
        再読み込み
      </button>
    </div>
  );
}

let idSeq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function IntakeTemplateEditPage() {
  const { id = '' } = useParams();
  const url = `/api/intake-templates/${id}`;
  const { data, error, loading, reload } = useApi<any>(url, [url]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [def, setDef] = useState<TemplateDefinition | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (data) {
      setName(data.template.name);
      setDescription(data.template.description);
      setDef(data.template.definition);
    }
  }, [data]);
  if (loading && !data) return <Loading />;
  if (error || !data || !def) return <ErrorBanner message={error} />;
  const archived = !!data.template.archivedAt;
  const lint = lintDefinition(def);
  const setQ = (i: number, patch: Partial<Question>) => setDef({ ...def, questions: def.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const setItem = (i: number, patch: Partial<RequiredItem>) => setDef({ ...def, requiredItems: def.requiredItems.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const sectionId = def.sections[0]?.id ?? 's1';
  return (
    <div>
      <div className="page-header">
        <h1>テンプレートの編集</h1>
        <Link to="/intake-templates" className="btn sm ghost">
          一覧へ
        </Link>
      </div>
      {archived && <div className="banner info">アーカイブ済みのため編集できません。</div>}
      <div className="card">
        <div className="grid cols-2">
          <Field label="名前">
            <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="説明">
            <input value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>質問</h2>
        <div className="stack">
          {def.questions.map((q, i) => (
            <div key={q.id} className="comment template-row">
              <div className="grid cols-2">
                <Field label={`質問 ${i + 1}`}>
                  <input value={q.label} maxLength={500} onChange={(e) => setQ(i, { label: e.target.value })} />
                </Field>
                <Field label="種類">
                  <select value={q.type} onChange={(e) => setQ(i, { type: e.target.value as Question['type'] })}>
                    {QUESTION_TYPES.filter((t) => t !== 'file' && t !== 'image').map((t) => (
                      <option key={t} value={t}>
                        {QUESTION_TYPE_LABEL[t]}
                      </option>
                    ))}
                    {(q.type === 'file' || q.type === 'image') && <option value={q.type}>{QUESTION_TYPE_LABEL[q.type]}（ファイル項目に紐づけ）</option>}
                  </select>
                </Field>
                <Field label="セクション">
                  <select value={q.sectionId} onChange={(e) => setQ(i, { sectionId: e.target.value })}>
                    {def.sections.map((sct) => (
                      <option key={sct.id} value={sct.id}>
                        {sct.title}
                      </option>
                    ))}
                  </select>
                </Field>
                {(q.type === 'single_choice' || q.type === 'multiple_choice') && (
                  <Field label="選択肢（読点・カンマ区切り）">
                    <input
                      value={(q.options ?? []).map((o) => o.label).join('、')}
                      onChange={(e) =>
                        setQ(i, {
                          options: e.target.value
                            .split(/[、,]/)
                            .map((x) => x.trim())
                            .filter(Boolean)
                            .map((label, k) => ({ value: q.options?.find((o) => o.label === label)?.value ?? `opt${k + 1}`, label })),
                        })
                      }
                    />
                  </Field>
                )}
              </div>
              <div className="row" style={{ gap: 12 }}>
                <label className="choice">
                  <input type="checkbox" checked={!!q.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> 必須
                </label>
                <span className="small muted">ID: {q.id}</span>
                <button type="button" className="btn sm ghost" onClick={() => setDef({ ...def, questions: def.questions.filter((_, j) => j !== i) })}>
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 8 }}
          onClick={() => setDef({ ...def, questions: [...def.questions, { id: newId('q'), sectionId, type: 'short_text', label: '新しい質問', required: false }] })}
        >
          ＋ 質問を追加
        </button>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>必要なファイル</h2>
        <div className="stack">
          {def.requiredItems.map((it, i) =>
            it.type !== 'file' ? null : (
              <div key={it.id} className="comment template-row">
                <div className="grid cols-2">
                  <Field label="名前">
                    <input value={it.label} maxLength={200} onChange={(e) => setItem(i, { label: e.target.value })} />
                  </Field>
                  <Field label="受け付ける形式（拡張子、カンマ区切り。空欄なら制限なし）" hint="対応形式：jpg/png/gif/webp/heic/pdf/ai(PDF互換)/docx/xlsx/pptx/txt/csv/mp4/mov">
                    <input
                      value={(it.acceptedFormats ?? []).join(',')}
                      onChange={(e) =>
                        setItem(i, {
                          acceptedFormats: e.target.value
                            .split(',')
                            .map((x) => x.trim().toLowerCase().replace(/^\./, ''))
                            .filter(Boolean),
                        })
                      }
                    />
                  </Field>
                  <Field label="必要数">
                    <input type="number" min={1} value={it.minCount ?? 1} onChange={(e) => setItem(i, { minCount: Math.max(1, Number(e.target.value) || 1) })} />
                  </Field>
                  <Field label="最大数（空欄なら制限なし）">
                    <input type="number" min={1} value={it.maxCount ?? ''} onChange={(e) => setItem(i, { maxCount: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })} />
                  </Field>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <label className="choice">
                    <input type="checkbox" checked={it.required} onChange={(e) => setItem(i, { required: e.target.checked })} /> 必須
                  </label>
                  <label className="choice">
                    <input type="checkbox" checked={it.requireReview !== false} onChange={(e) => setItem(i, { requireReview: e.target.checked })} /> 提出後に確認（承認）が必要
                  </label>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() =>
                      setDef({ ...def, requiredItems: def.requiredItems.filter((_, j) => j !== i), questions: def.questions.filter((q) => q.fileItemId !== it.id) })
                    }
                  >
                    削除
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 8 }}
          onClick={() =>
            setDef({ ...def, requiredItems: [...def.requiredItems, { id: newId('file'), label: '新しいファイル', type: 'file', required: true, minCount: 1, requireReview: true }] })
          }
        >
          ＋ ファイル項目を追加
        </button>
      </div>

      <div className="card">
        <details>
          <summary>詳細設定（JSON：セクション・条件分岐・項目のまとめ方・パックの割り当て）</summary>
          <p className="small muted">条件分岐（rules）や案件開始パックへの割り当て（packageTemplate.mapping）はここで編集します。</p>
          <textarea rows={16} style={{ fontFamily: 'monospace', width: '100%' }} value={json ?? JSON.stringify(def, null, 2)} onChange={(e) => setJson(e.target.value)} aria-label="テンプレート定義（JSON）" />
          <button
            type="button"
            className="btn sm"
            disabled={json === null}
            onClick={() => {
              try {
                setDef(JSON.parse(json!));
                setJson(null);
              } catch {
                toast('JSONの形式が正しくありません', 'error');
              }
            }}
          >
            JSONを反映
          </button>
        </details>
      </div>

      {(lint.errors.length > 0 || lint.warnings.length > 0) && (
        <div className="card">
          {lint.errors.map((e) => (
            <div key={e} className="err small">
              {e}
            </div>
          ))}
          {lint.warnings.map((w) => (
            <div key={w} className="small muted">
              {w}
            </div>
          ))}
        </div>
      )}
      <ErrorBanner message={saveError} />
      <div className="btn-row">
        <AsyncButton
          className="btn primary"
          disabled={archived || lint.errors.length > 0}
          onClick={async () => {
            try {
              await put(url, { name, description, definition: def });
              setSaveError(null);
              toast('保存しました');
              await reload();
            } catch (e) {
              setSaveError((e as Error).message);
            }
          }}
        >
          保存
        </AsyncButton>
        <AsyncButton
          className="btn ghost"
          onClick={async () => {
            await post(`${url}/archive`, { archived: !archived });
            await reload();
          }}
        >
          {archived ? 'アーカイブを解除' : 'アーカイブ'}
        </AsyncButton>
      </div>
    </div>
  );
}
