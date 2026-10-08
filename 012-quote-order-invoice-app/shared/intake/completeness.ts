// FreelanceDesk ヒアリング — 充足判定（決定的）。IntakeMint src/shared/completeness.ts から無改変で移植（仕様：IntakeMint COMPLETENESS_ENGINE.md）。
// ルール判定（旧AI候補）の結果だけで Ready にはならない：未解決の候補はブロック（または警告）として加わるだけ。
import {
  DEFAULT_COMPLETION_RULES, type Answers, type FileInfo, type ItemEvaluation, type ItemReviewState,
  type ProgressSummary, type ReadyCheck, type RequiredItem, type TemplateDefinition,
} from './types'
import { evaluateLogic, type LogicState } from './logic'
import { isCompleteAnswer, validateAnswer } from './validate'

export interface CompletenessInput {
  def: TemplateDefinition
  answers: Answers
  files: FileInfo[]
  itemStates: ItemReviewState[]
  /** open AI candidates (ambiguity / missing / contradiction) + unanswered follow-up questions */
  unresolvedAiCount?: number
  internalSignoff?: boolean
}

export interface CompletenessResult {
  logic: LogicState
  items: ItemEvaluation[]
  progress: ProgressSummary
  ready: ReadyCheck
  invalid: { questionId: string; message: string }[]
}

/** Required questions that are not covered by any explicit question item become implicit items "q:<id>". */
export function effectiveItems(def: TemplateDefinition): RequiredItem[] {
  const covered = new Set<string>()
  for (const it of def.requiredItems) for (const q of it.questionIds ?? []) covered.add(q)
  const fileQuestionItems = new Set(def.questions.filter((q) => q.fileItemId).map((q) => q.id))
  // questions that can become required through a rule are also tracked (applicable only while visible+required)
  const ruleRequired = new Set<string>()
  for (const r of def.rules ?? []) for (const a of r.then) if (a.type === 'require') ruleRequired.add(a.target)
  const implicit: RequiredItem[] = def.questions
    .filter((q) => (q.required || ruleRequired.has(q.id)) && !covered.has(q.id) && !fileQuestionItems.has(q.id) && q.type !== 'file' && q.type !== 'image')
    .map((q) => ({ id: `q:${q.id}`, label: q.label, type: 'question' as const, required: true, questionIds: [q.id] }))
  return [...def.requiredItems, ...implicit]
}

export function evaluateCompleteness(input: CompletenessInput): CompletenessResult {
  const def = input.def
  const rules = { ...DEFAULT_COMPLETION_RULES, ...(def.completionRules ?? {}) }
  const logic = evaluateLogic(def, input.answers)
  const qById = new Map(def.questions.map((q) => [q.id, q]))
  const states = new Map(input.itemStates.map((s) => [s.itemId, s]))

  const invalid: { questionId: string; message: string }[] = []
  for (const q of def.questions) {
    if (logic.visible[q.id] === false) continue
    const msg = validateAnswer(q, input.answers[q.id])
    if (msg) invalid.push({ questionId: q.id, message: msg })
  }

  const items: ItemEvaluation[] = effectiveItems(def).map((it) => {
    const st = states.get(it.id)
    const implicitQ = it.id.startsWith('q:') ? it.id.slice(2) : null
    const visible = implicitQ ? logic.visible[implicitQ] !== false : logic.visible[it.id] !== false
    const required = implicitQ ? logic.required[implicitQ] === true : logic.required[it.id] === true
    const base = { itemId: it.id, label: it.label, type: it.type, required: !!required, note: st?.note ?? null }

    if (it.type === 'question') {
      const qids = (it.questionIds ?? []).filter((id) => qById.has(id) && logic.visible[id] !== false)
      if (!visible || qids.length === 0 || st?.reviewStatus === 'not_applicable') {
        return { ...base, applicable: false, status: 'not_applicable' as const, answered: 0, total: 0 }
      }
      const missing = qids.filter((id) => !isCompleteAnswer(qById.get(id)!, input.answers[id]))
      const inv = qids.filter((id) => invalid.some((x) => x.questionId === id))
      const answered = qids.length - missing.length
      let status: ItemEvaluation['status']
      if (st?.reviewStatus === 'rejected') status = 'rejected'
      else if (answered === 0) status = 'missing'
      else if (answered < qids.length) status = 'partial'
      else if (st?.reviewStatus === 'accepted' || (rules.autoAcceptAnswers && !it.requireReview)) status = 'accepted'
      else if (st?.reviewStatus === 'needs_review') status = 'needs_review'
      else status = 'submitted'
      return { ...base, applicable: true, status, answered, total: qids.length, missingQuestionIds: missing, invalidQuestionIds: inv }
    }

    // file item
    if (!visible || st?.reviewStatus === 'not_applicable') {
      return { ...base, applicable: false, status: 'not_applicable' as const, count: 0, minCount: it.minCount ?? 1, acceptedCount: 0 }
    }
    const mine = input.files.filter((f) => f.itemId === it.id)
    const active = mine.filter((f) => f.status !== 'rejected')
    const accepted = mine.filter((f) => f.status === 'accepted').length
    const rejected = mine.length - active.length
    const min = Math.max(1, it.minCount ?? 1)
    const needReview = it.requireReview ?? rules.requireFileReview
    let status: ItemEvaluation['status']
    if (st?.reviewStatus === 'rejected') status = 'rejected'
    else if (active.length === 0) status = rejected > 0 ? 'rejected' : 'missing'
    else if (active.length < min) status = 'partial'
    else if (!needReview || accepted >= min) status = 'accepted'
    else if (st?.reviewStatus === 'needs_review') status = 'needs_review'
    else status = 'submitted'
    return { ...base, applicable: true, status, count: active.length, minCount: min, acceptedCount: accepted }
  })

  const counted = items.filter((i) => i.applicable && i.required)
  const submitted = counted.filter((i) => i.status === 'submitted' || i.status === 'needs_review' || i.status === 'accepted').length
  const accepted = counted.filter((i) => i.status === 'accepted').length
  const den = counted.length
  const progress: ProgressSummary = {
    denominator: den,
    submitted,
    accepted,
    percent: den === 0 ? 100 : Math.floor((submitted / den) * 100),
    acceptedPercent: den === 0 ? 100 : Math.floor((accepted / den) * 100),
    notApplicable: items.filter((i) => !i.applicable && i.required !== false).length,
  }

  const reasons: ReadyCheck['reasons'] = []
  const warnings: ReadyCheck['warnings'] = []
  for (const i of counted) {
    if (i.status !== 'accepted') {
      const detail = i.type === 'file' ? `（${i.count ?? 0}/${i.minCount}）` : ''
      reasons.push({ code: 'ITEM_NOT_ACCEPTED', itemId: i.itemId, message: `${i.label}: ${STATUS_LABEL[i.status]}${detail}` })
    }
  }
  for (const x of invalid) {
    reasons.push({ code: 'INVALID_ANSWER', message: `${qById.get(x.questionId)?.label ?? x.questionId}: ${x.message}` })
  }
  const unresolved = input.unresolvedAiCount ?? 0
  if (unresolved > 0) {
    if (rules.aiUnresolvedPolicy === 'block') reasons.push({ code: 'AI_UNRESOLVED', message: `未解決の確認事項（回答チェック・追加質問）が${unresolved}件あります` })
    else if (rules.aiUnresolvedPolicy === 'warn') warnings.push({ code: 'AI_UNRESOLVED', message: `未解決の確認事項（回答チェック・追加質問）が${unresolved}件あります（警告のみ）` })
  }
  if (rules.requireInternalSignoff && !input.internalSignoff) {
    reasons.push({ code: 'SIGNOFF_REQUIRED', message: '内部レビューの最終確認（サインオフ）が未完了です' })
  }
  return { logic, items, progress, ready: { ready: reasons.length === 0, reasons, warnings }, invalid }
}

/** Ready gate excluding the sign-off itself — used to decide whether sign-off is allowed. */
export function readyExceptSignoff(r: CompletenessResult): boolean {
  return r.ready.reasons.every((x) => x.code === 'SIGNOFF_REQUIRED')
}

export const STATUS_LABEL: Record<ItemEvaluation['status'], string> = {
  missing: '未提出', partial: '一部提出', submitted: '提出済み（確認待ち）', needs_review: '要確認',
  accepted: '承認済み', rejected: '差し戻し', not_applicable: '対象外',
}

export const CASE_STATUS_LABEL: Record<string, string> = {
  draft: '下書き', sent: '送信済み', in_progress: '回答中', needs_client: 'クライアント対応待ち',
  needs_internal_review: '内部確認待ち', ready: 'Ready（開始可能）', started: '開始済み', archived: 'アーカイブ', cancelled: 'キャンセル',
}

/** Short "what is missing" text for dashboards, e.g. "ロゴデータ未提出・商品画像 3/5" */
export function missingSummary(items: ItemEvaluation[], max = 3): string {
  const open = items.filter((i) => i.applicable && i.required && i.status !== 'accepted')
  const parts = open.slice(0, max).map((i) => {
    if (i.type === 'file' && i.status === 'partial') return `${i.label} ${i.count}/${i.minCount}`
    return `${i.label}${STATUS_LABEL[i.status]}`
  })
  if (open.length > max) parts.push(`他${open.length - max}件`)
  return parts.join('・')
}
