// FreelanceDesk ヒアリング — 回答チェック（ルール判定）。
// IntakeMint src/server/ai/providers.ts の LocalHeuristicProvider.analyzeCase を移植（外部送信なし・決定的）。
// 出力はすべて「確認候補」。回答の自動修正・要件の自動確定・お客様への自動送信はしない（人間が判断する）。
// 外部AI（有料API）プロバイダは統合していない（FreelanceDesk DECISIONS「FreelanceDesk ヒアリングの統合」I6）。
import type { Answers, Question, TemplateDefinition } from './types'
import { isAnswered } from './logic'

export interface SourceRef { questionId?: string; fileId?: string }
export interface FollowUpCandidate { questionId: string; text: string; options?: string[]; reason: string; sourceRefs: SourceRef[] }
export interface ContradictionCandidate { text: string; sourceRefs: SourceRef[]; fingerprint: string }
export interface AmbiguityCandidate { questionId: string; text: string; reason: string; sourceRefs: SourceRef[] }

export interface CheckInput {
  def: TemplateDefinition
  /** 表示中の質問の回答のみ（非表示の回答は除外して渡す） */
  answers: Answers
  /** テキスト形式の提出ファイルの本文（任意） */
  fileTexts: { fileId: string; name: string; text: string }[]
  today: string
}
export interface CheckOutput { followUps: FollowUpCandidate[]; contradictions: ContradictionCandidate[]; ambiguities: AmbiguityCandidate[] }

const VAGUE = [/^会社のサイト(です)?。?$/, /いい感じ/, /おまかせ|お任せ/, /^特に(なし|ない)/, /^未定/, /わから(ない|ん)/, /^普通/, /^適当/, /^なんでも/, /^ホームページ(です)?。?$/, /^サイト(です)?。?$/]

function questionText(q: Question): string { return `${q.label} ${(q.tags ?? []).join(' ')} ${q.id}` }

export const CHECK_PROVIDER = 'freelancedesk-rules'

export function runAnswerChecks(input: CheckInput): CheckOutput {
  const { def, answers } = input
  const followUps: FollowUpCandidate[] = []
  const ambiguities: AmbiguityCandidate[] = []
  const contradictions: ContradictionCandidate[] = []

  for (const q of def.questions) {
    const v = answers[q.id]
    if (!isAnswered(v)) continue
    if ((q.type === 'long_text' || q.type === 'short_text') && typeof v === 'string') {
      const s = v.trim()
      const isGoal = /goal|purpose|objective|目的|達成/.test(questionText(q))
      const vague = VAGUE.some((re) => re.test(s)) || (q.type === 'long_text' && s.length < 12)
      if (!vague) continue
      if (isGoal) {
        followUps.push({
          questionId: q.id,
          text: 'サイトの一番の目的を教えてください。（例：問い合わせを増やしたい／採用応募を集めたい／会社案内として信頼感を出したい／商品を販売したい）',
          options: ['問い合わせ獲得', '採用', '会社案内', '販売'],
          reason: `回答「${s.slice(0, 40)}」だけでは主目的が判断できません`,
          sourceRefs: [{ questionId: q.id }],
        })
      } else {
        ambiguities.push({ questionId: q.id, text: `「${q.label}」をもう少し具体的に教えてください。`, reason: `回答が短く/曖昧です（「${s.slice(0, 40)}」）`, sourceRefs: [{ questionId: q.id }] })
      }
    }
    if (q.type === 'repeating_group' && Array.isArray(v) && q.fields?.some((f) => f.id === 'reason')) {
      const noReason = (v as Record<string, unknown>[]).filter((r) => isAnswered(r.url) && !isAnswered(r.reason))
      if (noReason.length) ambiguities.push({ questionId: q.id, text: '参考サイトのどこを参考にしたいか（デザイン・構成・機能など）を教えてください。', reason: `${noReason.length}件の参考サイトに「参考にしたい点」がありません`, sourceRefs: [{ questionId: q.id }] })
    }
  }

  // 数量の矛盾：件数の質問 vs 自由記述・テキストファイル内の同じ単位の数値
  const countQs = def.questions.filter((q) => q.type === 'number' && /数|count/.test(q.label + q.id) && isAnswered(answers[q.id]))
  for (const cq of countQs) {
    const n = Number(answers[cq.id])
    const unit = /商品/.test(cq.label) ? '(?:商品|品目|アイテム|点)' : /人/.test(cq.label) ? '(?:人|名)' : '(?:件|個|点)'
    const re = new RegExp(`(?:全|計|合計|約)?\\s*([0-9０-９]{1,6})\\s*${unit}`, 'g')
    const texts: { qid?: string; fileId?: string; text: string }[] = [
      ...def.questions.filter((q) => q.id !== cq.id && typeof answers[q.id] === 'string').map((q) => ({ qid: q.id, text: answers[q.id] as string })),
      ...input.fileTexts.map((f) => ({ fileId: f.fileId, text: f.text })),
    ]
    for (const t of texts) {
      for (const m of t.text.matchAll(re)) {
        const k = Number(m[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)))
        if (Number.isFinite(k) && k !== n && k > 0) {
          contradictions.push({
            text: `「${cq.label}」は${n}ですが、別の回答に「${m[0].trim()}」とあります。どちらが正しいか確認してください。`,
            sourceRefs: [{ questionId: cq.id }, t.qid ? { questionId: t.qid } : { fileId: t.fileId }],
            fingerprint: `num:${cq.id}:${t.qid ?? t.fileId}:${n}:${k}`,
          })
          break
        }
      }
    }
  }
  // はい/いいえ と自由記述の矛盾
  for (const q of def.questions.filter((x) => x.type === 'yes_no' && answers[x.id] === 'no')) {
    const kw = /会員/.test(q.label) ? '会員' : null
    if (!kw) continue
    for (const t of def.questions.filter((x) => typeof answers[x.id] === 'string')) {
      const s = answers[t.id] as string
      if (s.includes(kw) && !/不要|なし|いらない/.test(s)) {
        contradictions.push({ text: `「${q.label}」は「いいえ」ですが、「${t.label}」に「${kw}」に関する記述があります。`, sourceRefs: [{ questionId: q.id }, { questionId: t.id }], fingerprint: `yn:${q.id}:${t.id}` })
        break
      }
    }
  }
  // 過去の日付
  for (const q of def.questions.filter((x) => x.type === 'date' && typeof answers[x.id] === 'string')) {
    if ((answers[q.id] as string) < input.today && /公開|納品|開始|希望/.test(q.label)) {
      contradictions.push({ text: `「${q.label}」(${answers[q.id]})が過去の日付です。`, sourceRefs: [{ questionId: q.id }], fingerprint: `date:${q.id}:${answers[q.id]}` })
    }
  }
  return { followUps, contradictions, ambiguities }
}
