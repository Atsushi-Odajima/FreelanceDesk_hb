// FreelanceDesk ヒアリング — 共有型（IntakeMint src/shared/types.ts から無改変で移植。画面・サーバー共通）

export const QUESTION_TYPES = [
  'short_text', 'long_text', 'email', 'phone', 'url', 'number', 'date',
  'single_choice', 'multiple_choice', 'yes_no', 'file', 'image', 'repeating_group', 'acknowledgement',
] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export interface ChoiceOption { value: string; label: string }

export interface Question {
  id: string
  sectionId: string
  type: QuestionType
  label: string
  help?: string
  placeholder?: string
  required?: boolean
  /** Visible unless a rule hides it. false => hidden until a rule shows it. */
  visibleByDefault?: boolean
  options?: ChoiceOption[]
  min?: number
  max?: number
  maxLength?: number
  /** repeating_group: sub-fields */
  fields?: { id: string; label: string; type: 'short_text' | 'long_text' | 'url' | 'number' | 'email' }[]
  minRows?: number
  maxRows?: number
  /** file / image question: linked file request item id */
  fileItemId?: string
  tags?: string[]
}

export interface Section { id: string; title: string; description?: string }

export type ConditionOp = 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'answered' | 'not_answered'
export interface LeafCondition { questionId: string; op: ConditionOp; value?: unknown }
export type Condition = LeafCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition }

export type RuleAction =
  | { type: 'show'; target: string }
  | { type: 'hide'; target: string }
  | { type: 'require'; target: string }
  | { type: 'unrequire'; target: string }

export interface Rule {
  id: string
  description?: string
  when: Condition
  then: RuleAction[]
  /** Rules proposed by AI are created as draft and are ignored until a human activates them. */
  status?: 'active' | 'draft'
  origin?: 'human' | 'ai'
}

export const ITEM_STATUSES = ['missing', 'partial', 'submitted', 'needs_review', 'accepted', 'rejected', 'not_applicable'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export interface RequiredItem {
  id: string
  label: string
  type: 'question' | 'file'
  required: boolean
  /** question items: questions that must all be validly answered */
  questionIds?: string[]
  /** file items */
  minCount?: number
  maxCount?: number
  acceptedFormats?: string[] // extensions without dot, e.g. ["ai","svg","pdf"]
  maxSizeMB?: number
  /** If true, a submitted file/answer is not accepted until a human reviews it. */
  requireReview?: boolean
  /** Visible unless a rule hides it (rules can target item ids). */
  visibleByDefault?: boolean
  dueOffsetDays?: number
  notes?: string
  category?: FileCategory
}

export const FILE_CATEGORIES = ['brand', 'company', 'product', 'reference', 'legal', 'finance', 'other'] as const
export type FileCategory = (typeof FILE_CATEGORIES)[number]

export interface CompletionRules {
  /** Unresolved AI candidates: block Ready, only warn, or ignore. Default: block */
  aiUnresolvedPolicy: 'block' | 'warn' | 'ignore'
  /** Require an internal sign-off review before Ready. Default true */
  requireInternalSignoff: boolean
  /** Question items accepted automatically when validly answered. Default true */
  autoAcceptAnswers: boolean
  /** File items require review before accepted (Upload != Accepted). Default true */
  requireFileReview: boolean
}

export interface ReminderPolicy {
  enabled: boolean
  /** draft => human approves each reminder; auto => sent by the job worker */
  mode: 'draft' | 'auto'
  daysBefore: number[]
  onDueDate: boolean
  overdueEveryDays: number
  maxOverdue: number
  quietHours: { start: string; end: string } // "21:00" - "08:00" in org/case timezone
}

export type HandoffProfile =
  | 'web_development' | 'design' | 'video' | 'sns_management' | 'consulting' | 'recruiting' | 'accounting_prep' | 'generic'

export interface PackageTemplate {
  profile: HandoffProfile
  /** Map package section -> question ids that feed it */
  mapping: Partial<Record<PackageSectionKey, string[]>>
}

export const PACKAGE_SECTIONS = [
  'client', 'project', 'objective', 'audience', 'requirements', 'preferences', 'assets', 'references',
  'constraints', 'openQuestions', 'files', 'decisions', 'notes',
] as const
export type PackageSectionKey = (typeof PACKAGE_SECTIONS)[number]

export interface TemplateDefinition {
  sections: Section[]
  questions: Question[]
  rules: Rule[]
  requiredItems: RequiredItem[]
  completionRules: CompletionRules
  reminderPolicy: ReminderPolicy
  packageTemplate: PackageTemplate
  /** behaviour for answers of hidden questions: retained but excluded (documented in CONDITIONAL_LOGIC.md) */
  hiddenAnswerPolicy?: 'retain_excluded'
  intro?: string
  completionMessage?: string
}

export const CASE_STATUSES = [
  'draft', 'sent', 'in_progress', 'needs_client', 'needs_internal_review', 'ready', 'started', 'archived', 'cancelled',
] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

export const ROLES = ['owner', 'admin', 'manager', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export type Answers = Record<string, unknown>

export interface FileInfo {
  id: string
  itemId: string | null
  status: 'pending_review' | 'accepted' | 'rejected'
  originalName: string
  mime: string
  size: number
}

export interface ItemReviewState {
  itemId: string
  reviewStatus: 'none' | 'accepted' | 'rejected' | 'needs_review' | 'not_applicable'
  note?: string | null
}

export interface ItemEvaluation {
  itemId: string
  label: string
  type: 'question' | 'file'
  required: boolean
  applicable: boolean
  status: ItemStatus
  /** file items: current non-rejected count / min count */
  count?: number
  minCount?: number
  acceptedCount?: number
  /** question items: answered / total visible questions */
  answered?: number
  total?: number
  missingQuestionIds?: string[]
  invalidQuestionIds?: string[]
  note?: string | null
}

export interface ProgressSummary {
  /** applicable required items */
  denominator: number
  /** items whose client side is complete (submitted / needs_review / accepted) */
  submitted: number
  accepted: number
  percent: number
  acceptedPercent: number
  notApplicable: number
}

export interface ReadyCheck {
  ready: boolean
  reasons: { code: string; message: string; itemId?: string }[]
  warnings: { code: string; message: string }[]
}

export const DEFAULT_COMPLETION_RULES: CompletionRules = {
  aiUnresolvedPolicy: 'block', requireInternalSignoff: true, autoAcceptAnswers: true, requireFileReview: true,
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  enabled: true, mode: 'draft', daysBefore: [3], onDueDate: true, overdueEveryDays: 3, maxOverdue: 3,
  quietHours: { start: '21:00', end: '08:00' },
}
