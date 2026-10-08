// FreelanceDesk ヒアリング — テンプレート定義の入力検証（IntakeMint src/server/services/templates.ts の definitionSchema を移植）
import { z } from 'zod';
import { QUESTION_TYPES, FILE_CATEGORIES, DEFAULT_COMPLETION_RULES, DEFAULT_REMINDER_POLICY, type TemplateDefinition } from '../../../shared/intake/types';
import { lintDefinition } from '../../../shared/intake/lint';
import { HttpError } from './errors';

const id = z.string().regex(/^[A-Za-z0-9_\-:]{1,64}$/);
const cond: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({ questionId: id, op: z.enum(['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'answered', 'not_answered']), value: z.unknown().optional() }),
    z.object({ all: z.array(cond).max(50) }),
    z.object({ any: z.array(cond).max(50) }),
    z.object({ not: cond }),
  ]),
);

export const definitionSchema = z.object({
  sections: z.array(z.object({ id, title: z.string().min(1).max(200), description: z.string().max(2000).optional() })).max(50),
  questions: z
    .array(
      z.object({
        id,
        sectionId: id,
        type: z.enum(QUESTION_TYPES),
        label: z.string().min(1).max(500),
        help: z.string().max(2000).optional(),
        placeholder: z.string().max(200).optional(),
        required: z.boolean().optional(),
        visibleByDefault: z.boolean().optional(),
        options: z.array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(200) })).max(100).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        maxLength: z.number().int().positive().max(20000).optional(),
        fields: z.array(z.object({ id, label: z.string().max(200), type: z.enum(['short_text', 'long_text', 'url', 'number', 'email']) })).max(20).optional(),
        minRows: z.number().int().min(0).optional(),
        maxRows: z.number().int().positive().max(100).optional(),
        fileItemId: id.optional(),
        tags: z.array(z.string().max(50)).max(20).optional(),
      }),
    )
    .max(500),
  rules: z
    .array(
      z.object({
        id,
        description: z.string().max(500).optional(),
        when: cond,
        then: z.array(z.object({ type: z.enum(['show', 'hide', 'require', 'unrequire']), target: id })).min(1).max(50),
        status: z.enum(['active', 'draft']).optional(),
        origin: z.enum(['human', 'ai']).optional(),
      }),
    )
    .max(300),
  requiredItems: z
    .array(
      z.object({
        id,
        label: z.string().min(1).max(200),
        type: z.enum(['question', 'file']),
        required: z.boolean(),
        questionIds: z.array(id).max(50).optional(),
        minCount: z.number().int().min(1).max(500).optional(),
        maxCount: z.number().int().min(1).max(1000).optional(),
        acceptedFormats: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(30).optional(),
        maxSizeMB: z.number().positive().max(2048).optional(),
        requireReview: z.boolean().optional(),
        visibleByDefault: z.boolean().optional(),
        dueOffsetDays: z.number().int().optional(),
        notes: z.string().max(2000).optional(),
        category: z.enum(FILE_CATEGORIES).optional(),
      }),
    )
    .max(200),
  completionRules: z
    .object({
      aiUnresolvedPolicy: z.enum(['block', 'warn', 'ignore']),
      requireInternalSignoff: z.boolean(),
      autoAcceptAnswers: z.boolean(),
      requireFileReview: z.boolean(),
    })
    .default(DEFAULT_COMPLETION_RULES),
  // リマインド設定は互換のため受け付けて保存するが、FreelanceDesk では使わない（メール送信基盤がないため）
  reminderPolicy: z
    .object({
      enabled: z.boolean(),
      mode: z.enum(['draft', 'auto']),
      daysBefore: z.array(z.number().int().min(1).max(60)).max(5),
      onDueDate: z.boolean(),
      overdueEveryDays: z.number().int().min(1).max(30),
      maxOverdue: z.number().int().min(0).max(20),
      quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }),
    })
    .default(DEFAULT_REMINDER_POLICY),
  packageTemplate: z.object({
    profile: z.enum(['web_development', 'design', 'video', 'sns_management', 'consulting', 'recruiting', 'accounting_prep', 'generic']),
    mapping: z.record(z.string(), z.array(id)).default({}),
  }),
  hiddenAnswerPolicy: z.literal('retain_excluded').optional(),
  intro: z.string().max(4000).optional(),
  completionMessage: z.string().max(4000).optional(),
});

/** 形式（zod）と構造（ID重複・参照切れ・循環）を検証。エラーは 400（details にエラー一覧） */
export function parseDefinition(raw: unknown): TemplateDefinition {
  const r = definitionSchema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, 'テンプレート定義の形式が正しくありません', 'invalid_definition', r.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const def = r.data as TemplateDefinition;
  const lint = lintDefinition(def);
  if (lint.errors.length) throw new HttpError(400, `テンプレートにエラーがあります：${lint.errors[0]}`, 'invalid_definition', lint.errors);
  return def;
}
