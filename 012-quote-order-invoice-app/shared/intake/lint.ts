// FreelanceDesk ヒアリング — テンプレート定義の構造チェック（ID重複・参照切れ・循環）と空のテンプレート。
// IntakeMint src/server/services/templates.ts の lintDefinition / blankDefinition を移植（画面でも即時表示するため共有に置く）。
import { DEFAULT_COMPLETION_RULES, DEFAULT_REMINDER_POLICY, type TemplateDefinition } from './types'
import { detectCycles } from './logic'

export function lintDefinition(def: TemplateDefinition): { errors: string[]; warnings: string[] } {
  const errors: string[] = []; const warnings: string[] = []
  const qids = new Set<string>(); const sids = new Set(def.sections.map((s) => s.id)); const iids = new Set<string>()
  for (const q of def.questions) {
    if (qids.has(q.id)) errors.push(`質問IDが重複しています: ${q.id}`)
    qids.add(q.id)
    if (!sids.has(q.sectionId)) errors.push(`質問 ${q.id} のセクション ${q.sectionId} が存在しません`)
    if ((q.type === 'single_choice' || q.type === 'multiple_choice') && !(q.options?.length)) errors.push(`選択式の質問 ${q.id} に選択肢がありません`)
  }
  for (const it of def.requiredItems) {
    if (iids.has(it.id) || qids.has(it.id)) errors.push(`必要項目IDが重複しています: ${it.id}`)
    iids.add(it.id)
    for (const q of it.questionIds ?? []) if (!qids.has(q)) errors.push(`必要項目 ${it.id} が存在しない質問 ${q} を参照しています`)
    if (it.type === 'question' && !(it.questionIds?.length)) errors.push(`必要項目 ${it.id} に質問が設定されていません`)
  }
  for (const q of def.questions) if (q.fileItemId && !iids.has(q.fileItemId)) errors.push(`質問 ${q.id} のファイル項目 ${q.fileItemId} が存在しません`)
  for (const r of def.rules) {
    for (const a of r.then) if (!qids.has(a.target) && !iids.has(a.target)) errors.push(`ルール ${r.id} の対象 ${a.target} が存在しません`)
    if ((r.status ?? 'active') === 'draft') warnings.push(`ルール ${r.id} は下書きのため無効です。確認して有効化してください`)
  }
  const cycles = detectCycles(def)
  for (const c of cycles) errors.push(`条件分岐が循環しています: ${c.join(' → ')}`)
  return { errors, warnings }
}

export function blankDefinition(): TemplateDefinition {
  return {
    sections: [{ id: 's1', title: '基本情報' }],
    questions: [{ id: 'client_name', sectionId: 's1', type: 'short_text', label: 'お名前・会社名', required: true }],
    rules: [], requiredItems: [], completionRules: { ...DEFAULT_COMPLETION_RULES }, reminderPolicy: structuredClone(DEFAULT_REMINDER_POLICY),
    packageTemplate: { profile: 'generic', mapping: {} }, hiddenAnswerPolicy: 'retain_excluded',
  }
}

export const QUESTION_TYPE_LABEL: Record<string, string> = {
  short_text: '短文', long_text: '長文', email: 'メール', phone: '電話番号', url: 'URL', number: '数値', date: '日付',
  single_choice: '単一選択', multiple_choice: '複数選択', yes_no: 'はい/いいえ', file: 'ファイル', image: '画像', repeating_group: '繰り返し（表）', acknowledgement: '同意チェック',
}
