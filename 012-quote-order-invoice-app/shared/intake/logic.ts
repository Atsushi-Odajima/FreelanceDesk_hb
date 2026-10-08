// FreelanceDesk ヒアリング — 条件分岐（表示/非表示/必須化/必須解除）と循環検知。
// IntakeMint src/shared/logic.ts から無改変で移植（仕様：IntakeMint CONDITIONAL_LOGIC.md）
import type { Answers, Condition, LeafCondition, Rule, TemplateDefinition } from './types'

export function isAnswered(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true // numbers, booleans
}

function isLeaf(c: Condition): c is LeafCondition {
  return (c as LeafCondition).questionId !== undefined
}

export function conditionQuestionIds(c: Condition, out: Set<string> = new Set()): Set<string> {
  if (isLeaf(c)) out.add(c.questionId)
  else if ('all' in c) c.all.forEach((x) => conditionQuestionIds(x, out))
  else if ('any' in c) c.any.forEach((x) => conditionQuestionIds(x, out))
  else if ('not' in c) conditionQuestionIds(c.not, out)
  return out
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return null
}

export function evalCondition(c: Condition, answers: Answers): boolean {
  if (!isLeaf(c)) {
    if ('all' in c) return c.all.every((x) => evalCondition(x, answers))
    if ('any' in c) return c.any.some((x) => evalCondition(x, answers))
    if ('not' in c) return !evalCondition(c.not, answers)
    return false
  }
  const v = answers[c.questionId]
  switch (c.op) {
    case 'answered': return isAnswered(v)
    case 'not_answered': return !isAnswered(v)
    // for multiple-choice answers "eq" means "the selection includes the value"
    case 'eq': return Array.isArray(v) ? v.includes(c.value) : v === c.value
    case 'neq': return Array.isArray(v) ? !v.includes(c.value) : v !== c.value
    case 'in': {
      const list = Array.isArray(c.value) ? c.value : typeof c.value === 'string' ? c.value.split(',').map((x) => x.trim()).filter(Boolean) : []
      return Array.isArray(v) ? v.some((x) => list.includes(x)) : list.includes(v)
    }
    case 'contains':
      if (Array.isArray(v)) return v.includes(c.value)
      return typeof v === 'string' && typeof c.value === 'string' && v.includes(c.value)
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = num(v), b = num(c.value)
      if (a === null || b === null) return false
      return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b
    }
  }
}

export function activeRules(def: Pick<TemplateDefinition, 'rules'>): Rule[] {
  return (def.rules ?? []).filter((r) => (r.status ?? 'active') === 'active')
}

/**
 * Dependency graph edges: source question -> target (question or item) for every active rule.
 * A cycle exists when a question's visibility/requirement depends (transitively) on itself.
 */
export function detectCycles(def: Pick<TemplateDefinition, 'rules' | 'questions' | 'requiredItems'>): string[][] {
  const edges = new Map<string, Set<string>>()
  const add = (a: string, b: string) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a)!.add(b) }
  for (const r of activeRules(def as TemplateDefinition)) {
    const sources = conditionQuestionIds(r.when)
    for (const a of r.then) for (const s of sources) add(s, a.target)
  }
  // An item target depends on its questions; questions inside items are not themselves sources of
  // visibility, so item nodes are leaf-like unless rules reference them (rules reference questions only).
  const cycles: string[][] = []
  const color = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (n: string) => {
    color.set(n, 1); stack.push(n)
    for (const m of edges.get(n) ?? []) {
      const c = color.get(m) ?? 0
      if (c === 1) {
        const i = stack.indexOf(m)
        cycles.push([...stack.slice(i), m])
      } else if (c === 0) visit(m)
    }
    stack.pop(); color.set(n, 2)
  }
  for (const n of edges.keys()) if ((color.get(n) ?? 0) === 0) visit(n)
  return cycles
}

export interface LogicState {
  visible: Record<string, boolean>
  required: Record<string, boolean>
  /** answers with hidden questions removed (hidden answers are retained in storage but excluded) */
  effectiveAnswers: Answers
}

/**
 * Evaluate visibility & requirement of every question and required item.
 * Hidden questions' answers are treated as unanswered for downstream conditions (cascade).
 * Iterates to a fixed point (bounded) — templates with cycles are rejected at publish time.
 */
export function evaluateLogic(def: TemplateDefinition, answers: Answers): LogicState {
  const rules = activeRules(def)
  const baseVisible: Record<string, boolean> = {}
  const baseRequired: Record<string, boolean> = {}
  for (const q of def.questions) { baseVisible[q.id] = q.visibleByDefault !== false; baseRequired[q.id] = !!q.required }
  for (const it of def.requiredItems) { baseVisible[it.id] = it.visibleByDefault !== false; baseRequired[it.id] = !!it.required }

  let visible = { ...baseVisible }
  let required = { ...baseRequired }
  let effective: Answers = {}
  const limit = def.questions.length + def.requiredItems.length + 2
  for (let iter = 0; iter < limit; iter++) {
    effective = {}
    for (const [k, v] of Object.entries(answers)) if (visible[k] !== false) effective[k] = v
    const nextVisible = { ...baseVisible }
    const nextRequired = { ...baseRequired }
    for (const r of rules) {
      if (!evalCondition(r.when, effective)) continue
      for (const a of r.then) {
        if (a.type === 'show') nextVisible[a.target] = true
        else if (a.type === 'hide') nextVisible[a.target] = false
        else if (a.type === 'require') nextRequired[a.target] = true
        else if (a.type === 'unrequire') nextRequired[a.target] = false
      }
    }
    const same = JSON.stringify(nextVisible) === JSON.stringify(visible) && JSON.stringify(nextRequired) === JSON.stringify(required)
    visible = nextVisible; required = nextRequired
    if (same) break
  }
  effective = {}
  for (const [k, v] of Object.entries(answers)) if (visible[k] !== false) effective[k] = v
  return { visible, required, effectiveAnswers: effective }
}
