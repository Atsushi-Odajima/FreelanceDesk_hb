// FreelanceDesk ヒアリング — 回答の形式チェック（IntakeMint src/shared/validate.ts から無改変で移植。サーバーが正）
import type { Question } from './types'
import { isAnswered } from './logic'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE = /^\+?[0-9()\-\s]{7,20}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidUrl(v: string): boolean {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}

/** Returns an error message (Japanese) or null when valid. Empty answers are valid here (required is checked separately). */
export function validateAnswer(q: Question, v: unknown): string | null {
  if (!isAnswered(v)) return null
  switch (q.type) {
    case 'short_text': case 'long_text': {
      if (typeof v !== 'string') return '文字列で入力してください'
      const max = q.maxLength ?? (q.type === 'short_text' ? 500 : 10000)
      if (v.length > max) return `${max}文字以内で入力してください`
      return null
    }
    case 'email': return typeof v === 'string' && EMAIL.test(v.trim()) ? null : 'メールアドレスの形式が正しくありません'
    case 'phone': return typeof v === 'string' && PHONE.test(v.trim()) ? null : '電話番号の形式が正しくありません'
    case 'url': return typeof v === 'string' && isValidUrl(v.trim()) ? null : 'http(s):// から始まるURLを入力してください'
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      if (!Number.isFinite(n)) return '数値を入力してください'
      if (q.min !== undefined && n < q.min) return `${q.min}以上を入力してください`
      if (q.max !== undefined && n > q.max) return `${q.max}以下を入力してください`
      return null
    }
    case 'date': {
      if (typeof v !== 'string' || !DATE.test(v)) return '日付の形式が正しくありません'
      const d = new Date(v + 'T00:00:00Z')
      return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? '存在しない日付です' : null
    }
    case 'single_choice': {
      const ok = (q.options ?? []).some((o) => o.value === v)
      return ok ? null : '選択肢から選んでください'
    }
    case 'multiple_choice': {
      if (!Array.isArray(v)) return '選択肢から選んでください'
      const vals = new Set((q.options ?? []).map((o) => o.value))
      if (!v.every((x) => vals.has(x as string))) return '選択肢から選んでください'
      if (q.min !== undefined && v.length < q.min) return `${q.min}個以上選んでください`
      if (q.max !== undefined && v.length > q.max) return `${q.max}個以内で選んでください`
      return null
    }
    case 'yes_no': return v === 'yes' || v === 'no' ? null : '「はい」か「いいえ」を選んでください'
    case 'acknowledgement': return v === true ? null : '確認にチェックしてください'
    case 'repeating_group': {
      if (!Array.isArray(v)) return '形式が正しくありません'
      if (q.maxRows !== undefined && v.length > q.maxRows) return `${q.maxRows}件以内で入力してください`
      if (q.minRows !== undefined && v.length < q.minRows) return `${q.minRows}件以上入力してください`
      for (const row of v) {
        if (typeof row !== 'object' || row === null) return '形式が正しくありません'
        for (const f of q.fields ?? []) {
          const fv = (row as Record<string, unknown>)[f.id]
          if (!isAnswered(fv)) continue
          if (f.type === 'url' && !(typeof fv === 'string' && isValidUrl(fv))) return `${f.label}: URLの形式が正しくありません`
          if (f.type === 'email' && !(typeof fv === 'string' && EMAIL.test(fv))) return `${f.label}: メールアドレスの形式が正しくありません`
          if (f.type === 'number' && !Number.isFinite(Number(fv))) return `${f.label}: 数値を入力してください`
          if (typeof fv === 'string' && fv.length > 5000) return `${f.label}: 長すぎます`
        }
      }
      return null
    }
    case 'file': case 'image':
      return null // file answers are tracked through the files table / required items
  }
}

/** Answer considered "complete" for required checks: answered and valid. */
export function isCompleteAnswer(q: Question, v: unknown): boolean {
  if (q.type === 'acknowledgement') return v === true
  if (q.type === 'repeating_group') {
    if (!Array.isArray(v) || v.length < Math.max(1, q.minRows ?? 1)) return false
    return validateAnswer(q, v) === null && v.some((row) => Object.values(row as object).some(isAnswered))
  }
  return isAnswered(v) && validateAnswer(q, v) === null
}
