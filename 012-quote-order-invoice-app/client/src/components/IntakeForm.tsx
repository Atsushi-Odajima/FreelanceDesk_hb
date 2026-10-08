// FreelanceDesk ヒアリング — 質問フォーム（お客様のポータルと運営者の回答入力で共用）。
// 表示/必須は shared/intake/logic.ts をブラウザでも同じコードで即時評価する（保存時はサーバーが再検証する）。
import type { ReactNode } from 'react';
import { evaluateLogic, isAnswered } from '../../../shared/intake/logic';
import { validateAnswer } from '../../../shared/intake/validate';
import type { Answers, Question, RequiredItem, TemplateDefinition } from '../../../shared/intake/types';

export const ITEM_STATUS_COLOR: Record<string, string> = {
  missing: 'red',
  partial: 'yellow',
  submitted: 'blue',
  needs_review: 'yellow',
  accepted: 'green',
  rejected: 'red',
  not_applicable: '',
};

function QuestionInput({ q, value, onChange, readOnly }: { q: Question; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean }) {
  const name = `q-${q.id}`;
  switch (q.type) {
    case 'long_text':
      return <textarea id={name} rows={4} value={(value as string) ?? ''} placeholder={q.placeholder} disabled={readOnly} onChange={(e) => onChange(e.target.value)} />;
    case 'short_text':
    case 'email':
    case 'phone':
    case 'url':
      return (
        <input
          id={name}
          type={q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : q.type === 'url' ? 'url' : 'text'}
          value={(value as string) ?? ''}
          placeholder={q.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <input
          id={name}
          type="number"
          inputMode="decimal"
          value={value === undefined || value === null ? '' : String(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      );
    case 'date':
      return <input id={name} type="date" value={(value as string) ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value)} />;
    case 'single_choice':
    case 'yes_no': {
      const opts = q.type === 'yes_no' ? [{ value: 'yes', label: 'はい' }, { value: 'no', label: 'いいえ' }] : (q.options ?? []);
      return (
        <div className="choice-group" role="radiogroup" aria-label={q.label}>
          {opts.map((o) => (
            <label key={o.value} className="choice">
              <input type="radio" name={name} checked={value === o.value} disabled={readOnly} onChange={() => onChange(o.value)} /> {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'multiple_choice': {
      const cur = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="choice-group" role="group" aria-label={q.label}>
          {(q.options ?? []).map((o) => (
            <label key={o.value} className="choice">
              <input
                type="checkbox"
                checked={cur.includes(o.value)}
                disabled={readOnly}
                onChange={(e) => onChange(e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value))}
              />{' '}
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'acknowledgement':
      return (
        <label className="choice">
          <input type="checkbox" checked={value === true} disabled={readOnly} onChange={(e) => onChange(e.target.checked ? true : null)} /> 確認しました
        </label>
      );
    case 'repeating_group': {
      const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
      const setRow = (i: number, k: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
      return (
        <div className="stack">
          {rows.map((row, i) => (
            <div key={i} className="repeat-row">
              {(q.fields ?? []).map((f) => (
                <label key={f.id} className="field">
                  <span className="label">
                    {f.label}（{i + 1}）
                  </span>
                  {f.type === 'long_text' ? (
                    <textarea rows={2} value={(row[f.id] as string) ?? ''} disabled={readOnly} onChange={(e) => setRow(i, f.id, e.target.value)} />
                  ) : (
                    <input type={f.type === 'url' ? 'url' : f.type === 'email' ? 'email' : 'text'} value={(row[f.id] as string) ?? ''} disabled={readOnly} onChange={(e) => setRow(i, f.id, e.target.value)} />
                  )}
                </label>
              ))}
              {!readOnly && (
                <button type="button" className="btn sm ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  この行を削除
                </button>
              )}
            </div>
          ))}
          {!readOnly && (q.maxRows === undefined || rows.length < q.maxRows) && (
            <button type="button" className="btn sm" onClick={() => onChange([...rows, {}])}>
              ＋ {q.label}を追加
            </button>
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

/**
 * セクションごとに表示中の質問を描画する。ファイル・画像の質問と、質問に紐づかないファイル項目は fileSlot で描画する。
 */
export function IntakeQuestions({
  def,
  answers,
  onChange,
  readOnly,
  fileSlot,
  serverErrors,
}: {
  def: Pick<TemplateDefinition, 'sections' | 'questions' | 'rules' | 'requiredItems'> & Partial<TemplateDefinition>;
  answers: Answers;
  onChange: (qid: string, v: unknown) => void;
  readOnly?: boolean;
  fileSlot?: (item: RequiredItem) => ReactNode;
  serverErrors?: Record<string, string>;
}) {
  const logic = evaluateLogic(def as TemplateDefinition, answers);
  const linkedItems = new Set(def.questions.filter((q) => q.fileItemId).map((q) => q.fileItemId));
  const looseFileItems = def.requiredItems.filter((i) => i.type === 'file' && !linkedItems.has(i.id) && logic.visible[i.id] !== false);
  return (
    <div className="stack">
      {def.sections.map((sec) => {
        const qs = def.questions.filter((q) => q.sectionId === sec.id && logic.visible[q.id] !== false);
        if (!qs.length) return null;
        return (
          <section key={sec.id} className="card intake-section">
            <h3 style={{ marginTop: 0 }}>{sec.title}</h3>
            {sec.description && <p className="small muted">{sec.description}</p>}
            <div className="stack">
              {qs.map((q) => {
                const item = q.fileItemId ? def.requiredItems.find((i) => i.id === q.fileItemId) : undefined;
                if (q.type === 'file' || q.type === 'image') {
                  if (!item || logic.visible[item.id] === false) return null;
                  return (
                    <div key={q.id} className="field" data-testid={`intake-q-${q.id}`}>
                      <span className="label">
                        {q.label} {logic.required[item.id] && <span className="badge red">必須</span>}
                      </span>
                      {q.help && <span className="hint">{q.help}</span>}
                      {fileSlot?.(item)}
                    </div>
                  );
                }
                const v = answers[q.id];
                const err = serverErrors?.[q.id] ?? (isAnswered(v) ? validateAnswer(q, v) : null);
                const isGroup = ['single_choice', 'multiple_choice', 'yes_no', 'acknowledgement', 'repeating_group'].includes(q.type);
                const Wrapper = isGroup ? 'div' : 'label';
                return (
                  <Wrapper key={q.id} className="field" data-testid={`intake-q-${q.id}`} {...(isGroup ? {} : { htmlFor: `q-${q.id}` })}>
                    <span className="label">
                      {q.label} {logic.required[q.id] && <span className="badge red">必須</span>}
                    </span>
                    <QuestionInput q={q} value={v} onChange={(nv) => onChange(q.id, nv)} readOnly={readOnly} />
                    {q.help && <span className="hint">{q.help}</span>}
                    {err && <span className="err">{err}</span>}
                  </Wrapper>
                );
              })}
            </div>
          </section>
        );
      })}
      {looseFileItems.length > 0 && fileSlot && (
        <section className="card intake-section">
          <h3 style={{ marginTop: 0 }}>提出ファイル</h3>
          <div className="stack">
            {looseFileItems.map((item) => (
              <div key={item.id} className="field" data-testid={`intake-item-${item.id}`}>
                <span className="label">
                  {item.label} {logic.required[item.id] && <span className="badge red">必須</span>}
                </span>
                {fileSlot(item)}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** 回答の表示用テキスト */
export function answerText(q: Question, v: unknown): string {
  if (!isAnswered(v)) return '—';
  if (Array.isArray(v)) {
    if (q.type === 'repeating_group') return v.map((row) => (q.fields ?? []).map((f) => `${f.label}: ${(row as any)[f.id] ?? ''}`).join(' / ')).join('\n');
    return v.map((x) => q.options?.find((o) => o.value === x)?.label ?? String(x)).join('、');
  }
  if (q.type === 'single_choice') return q.options?.find((o) => o.value === v)?.label ?? String(v);
  if (q.type === 'yes_no') return v === 'yes' ? 'はい' : 'いいえ';
  if (q.type === 'acknowledgement') return v === true ? '確認済み' : '未確認';
  return String(v);
}

/** 変更された回答だけを取り出す（空にした回答は null で送る） */
export function changedAnswers(base: Answers, cur: Answers): Answers {
  const out: Answers = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(cur)]);
  for (const k of keys) {
    const a = JSON.stringify(isAnswered(base[k]) ? base[k] : null);
    const b = JSON.stringify(isAnswered(cur[k]) ? cur[k] : null);
    if (a !== b) out[k] = isAnswered(cur[k]) ? cur[k] : null;
  }
  return out;
}

export function formatsText(item: RequiredItem): string {
  const parts: string[] = [];
  if (item.acceptedFormats?.length) parts.push(`形式：${item.acceptedFormats.join(' / ')}`);
  parts.push(`${item.minCount ?? 1}件以上${item.maxCount ? `・最大${item.maxCount}件` : ''}`);
  parts.push(`1ファイル ${Math.min(item.maxSizeMB ?? 10, 10)}MB まで`);
  return parts.join('　');
}
