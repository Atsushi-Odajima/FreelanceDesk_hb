// FreelanceDesk 案件開始パック — 生成（決定的・出典付き）。
// IntakeMint src/server/services/packages.ts の buildPackage / buildHandoff / toMarkdown / toText を移植。
// 各エントリは出典（質問ID・ファイルID・項目ID・追加質問ID）を持ち、未回答は Unknown、未確定は Open Questions に入れる。
// テンプレートにない要件は作らず、回答を確定した技術仕様として扱わない。
// 変更点：Case → FreelanceDesk の案件（projects）＋ヒアリング（intakes）。レビュー履歴の代わりにサインオフ・上書きの記録を Decisions に入れる。
import { STATUS_LABEL, CASE_STATUS_LABEL, type CompletenessResult } from './completeness'
import { PACKAGE_SECTIONS, type HandoffProfile, type ItemReviewState, type PackageSectionKey, type Question, type TemplateDefinition } from './types'
import { isAnswered } from './logic'

export interface PackageSourceRef { questionId?: string; fileId?: string; itemId?: string; followupId?: string }
export interface Entry { label: string; value: string; source: PackageSourceRef; status?: 'unknown' }
export interface IntakePackage {
  schema: 'freelancedesk.intake-package/v1'
  meta: {
    intakeId: string; projectNumber: string; client: string; project: string; intakeTitle: string; profile: HandoffProfile
    intakeStatus: string; readyAt: string | null; readyOverride: unknown; generatedAt: string; progress: unknown
  }
  sections: Record<PackageSectionKey, Entry[]>
  handoff: { profile: HandoffProfile; title: string; blocks: { title: string; entries: Entry[]; note?: string }[] }
}

export interface PackageFile { id: string; itemId: string | null; originalName: string; status: string; size: number }
export interface PackageFollowup { id: string; question_id: string | null; text: string; status: string; answer: unknown }
export interface PackageState {
  intake: {
    id: string; title: string; status: string; ready_at: string | Date | null; ready_override: any; due_date: string | null
    internal_signoff_at: string | Date | null; signoff_note: string | null
  }
  project: { number: string; title: string }
  clientName: string
  def: TemplateDefinition
  result: CompletenessResult
  files: PackageFile[]
  itemStates: ItemReviewState[]
}

export const PROFILE_LABEL: Record<HandoffProfile, string> = {
  web_development: 'Web Development', design: 'Design', video: 'Video', sns_management: 'SNS Management',
  consulting: 'Consulting', recruiting: 'Recruiting', accounting_prep: 'Accounting Prep', generic: 'Generic',
}

const SECTION_LABEL: Record<PackageSectionKey, string> = {
  client: 'Client（クライアント）', project: 'Project（案件）', objective: 'Objective（目的）', audience: 'Audience（対象）',
  requirements: 'Requirements（要件・回答）', preferences: 'Preferences（要望）', assets: 'Assets（素材）', references: 'References（参考）',
  constraints: 'Constraints（制約）', openQuestions: 'Open Questions（未解決事項）', files: 'Files（提出ファイル）',
  decisions: 'Decisions（確認・決定事項）', notes: 'Notes（メモ）',
}

export function formatAnswer(q: Question, v: unknown): string {
  if (Array.isArray(v)) {
    if (q.type === 'repeating_group') return v.map((row) => (q.fields ?? []).map((f) => `${f.label}: ${(row as any)[f.id] ?? ''}`).join(' / ')).join('\n')
    return v.map((x) => q.options?.find((o) => o.value === x)?.label ?? String(x)).join('、')
  }
  if (q.type === 'single_choice') return q.options?.find((o) => o.value === v)?.label ?? String(v)
  if (q.type === 'yes_no') return v === 'yes' ? 'はい' : 'いいえ'
  if (q.type === 'acknowledgement') return v === true ? '確認済み' : '未確認'
  return String(v)
}

/** ZIP 内・Handoff 内のファイルパス（IntakeMint と同じ形式） */
export function filePath(itemId: string | null, name: string, id: string): string {
  return `files/${itemId ?? 'other'}/${id.slice(0, 8)}_${name}`
}

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null)

export function buildPackage(st: PackageState, now: Date, extra: { followups: PackageFollowup[]; profile?: HandoffProfile }): IntakePackage {
  const def = st.def
  const profile = extra.profile ?? def.packageTemplate.profile
  const vis = st.result.logic.visible
  const ans = st.result.logic.effectiveAnswers // 非表示の回答は含めない
  const qById = new Map(def.questions.map((q) => [q.id, q]))
  const sections = Object.fromEntries(PACKAGE_SECTIONS.map((k) => [k, [] as Entry[]])) as Record<PackageSectionKey, Entry[]>
  const used = new Set<string>()
  const add = (k: PackageSectionKey, qid: string) => {
    const q = qById.get(qid)
    if (!q || vis[qid] === false || q.type === 'file' || q.type === 'image') return
    used.add(qid)
    if (isAnswered(ans[qid])) sections[k].push({ label: q.label, value: formatAnswer(q, ans[qid]), source: { questionId: qid } })
    else sections[k].push({ label: q.label, value: 'Unknown（未回答）', source: { questionId: qid }, status: 'unknown' })
  }
  for (const k of PACKAGE_SECTIONS) for (const qid of def.packageTemplate.mapping[k] ?? []) add(k, qid)
  for (const q of def.questions) {
    if (used.has(q.id)) continue
    const tag = (q.tags ?? []).find((t) => (PACKAGE_SECTIONS as readonly string[]).includes(t)) as PackageSectionKey | undefined
    if (tag) add(tag, q.id)
  }
  // マッピング外の回答は Notes へ（落とさない・足さない）
  for (const q of def.questions) if (!used.has(q.id) && vis[q.id] !== false && isAnswered(ans[q.id]) && q.type !== 'file' && q.type !== 'image') {
    sections.notes.push({ label: q.label, value: formatAnswer(q, ans[q.id]), source: { questionId: q.id } })
  }
  sections.client.unshift({ label: 'クライアント名', value: st.clientName, source: { itemId: 'project.customer' } })
  sections.project.unshift({ label: '案件名', value: `${st.project.title}（${st.project.number}）`, source: { itemId: 'project.title' } })
  if (st.intake.due_date) sections.constraints.push({ label: 'ヒアリング回答期限', value: String(st.intake.due_date).slice(0, 10), source: { itemId: 'intake.due_date' } })

  for (const f of st.files.filter((x) => x.status !== 'rejected')) {
    const item = def.requiredItems.find((i) => i.id === f.itemId)
    const e: Entry = { label: `${item?.label ?? 'その他'}：${f.originalName}`, value: `${filePath(f.itemId, f.originalName, f.id)}（${f.status === 'accepted' ? '承認済み' : '確認待ち'}・${Math.ceil(f.size / 1024)}KB）`, source: { fileId: f.id, itemId: f.itemId ?? undefined } }
    sections.files.push(e)
    if (item?.category === 'reference') sections.references.push(e)
    else sections.assets.push(e)
  }
  for (const i of st.result.items) {
    if (!i.applicable || !i.required || i.status === 'accepted') continue
    sections.openQuestions.push({ label: i.label, value: `${STATUS_LABEL[i.status]}${i.type === 'file' ? `（${i.count}/${i.minCount}）` : ''}`, source: { itemId: i.itemId }, status: 'unknown' })
  }
  const ansText = (a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))
  for (const f of extra.followups.filter((x) => x.status === 'open' || x.status === 'answered')) {
    sections.openQuestions.push({ label: '追加確認', value: `${f.text}${isAnswered(f.answer) ? ` → 回答: ${ansText(f.answer)}（未確定）` : '（回答待ち）'}`, source: { followupId: f.id, questionId: f.question_id ?? undefined }, status: 'unknown' })
  }
  for (const f of extra.followups.filter((x) => x.status === 'resolved' && isAnswered(x.answer))) {
    sections.decisions.push({ label: `追加確認：${String(f.text).slice(0, 60)}`, value: ansText(f.answer), source: { followupId: f.id, questionId: f.question_id ?? undefined } })
  }
  if (st.intake.internal_signoff_at) {
    sections.decisions.push({ label: '内部サインオフ', value: `${iso(st.intake.internal_signoff_at)!.slice(0, 16)} ${st.intake.signoff_note ?? ''}`.trim(), source: { itemId: 'intake.signoff' } })
  }
  if (st.intake.ready_override) {
    const o = st.intake.ready_override
    sections.decisions.push({ label: 'Ready上書き', value: `${String(o.at ?? '').slice(0, 16)} 理由: ${o.reason ?? ''}`, source: { itemId: 'intake.ready_override' } })
  }
  for (const s of st.itemStates) if (s.note) sections.notes.push({ label: `レビューメモ（${def.requiredItems.find((i) => i.id === s.itemId)?.label ?? s.itemId}）`, value: s.note, source: { itemId: s.itemId } })

  return {
    schema: 'freelancedesk.intake-package/v1',
    meta: {
      intakeId: st.intake.id, projectNumber: st.project.number, client: st.clientName, project: st.project.title, intakeTitle: st.intake.title, profile,
      intakeStatus: st.intake.status, readyAt: iso(st.intake.ready_at), readyOverride: st.intake.ready_override ?? null,
      generatedAt: now.toISOString(), progress: st.result.progress,
    },
    sections,
    handoff: buildHandoff(profile, sections, st),
  }
}

function buildHandoff(profile: HandoffProfile, s: Record<PackageSectionKey, Entry[]>, st: PackageState): IntakePackage['handoff'] {
  const blocks: IntakePackage['handoff']['blocks'] = [{ title: 'Overview', entries: [...s.project, ...s.objective, ...s.audience] }]
  if (profile === 'web_development') {
    const purposeQ = st.def.questions.find((q) => q.id === 'site_purpose')
    const raw = st.result.logic.effectiveAnswers.site_purpose
    const sel = Array.isArray(raw) ? (raw as string[]) : []
    const PAGES: Record<string, string> = { company: '会社概要ページ', inquiry: 'お問い合わせフォーム', ec: '商品一覧・商品詳細・カート/決済', recruit: '採用情報ページ・応募導線', blog: 'お知らせ/ブログ一覧・詳細' }
    blocks.push({
      title: 'Pages / Features（候補）', note: 'クライアント回答から導いた候補です。技術仕様・ページ構成は確定していません。',
      entries: sel.map((v) => ({ label: purposeQ?.options?.find((o) => o.value === v)?.label ?? v, value: `${PAGES[v] ?? v}（候補）`, source: { questionId: 'site_purpose' } })),
    })
  }
  blocks.push({ title: profile === 'web_development' || profile === 'design' ? 'Brand Assets' : 'Assets', entries: s.assets })
  blocks.push({ title: 'Content', entries: [...s.requirements, ...s.preferences] })
  blocks.push({ title: 'References', entries: s.references })
  blocks.push({ title: 'Constraints', entries: s.constraints })
  blocks.push({ title: 'Open Questions', entries: s.openQuestions })
  blocks.push({ title: 'File Paths', entries: s.files })
  blocks.push({
    title: 'Acceptance Criteria（候補）', note: '必要項目から機械的に作成した確認観点の候補です。正式な受入基準は担当者が決めてください。',
    entries: st.result.items.filter((i) => i.applicable && i.required).map((i) => ({
      label: i.label, value: i.type === 'file' ? `承認済みファイル${i.minCount}件以上が成果物に反映されている` : `提出された「${i.label}」の内容が反映されている`, source: { itemId: i.itemId },
    })),
  })
  return { profile, title: `${PROFILE_LABEL[profile]} Handoff`, blocks }
}

export const INTAKE_STATUS_LABEL: Record<string, string> = { ...CASE_STATUS_LABEL, sent: '回答受付中（公開済み）', cancelled: '中止' }

export function toMarkdown(p: IntakePackage): string {
  const ref = (e: Entry) => {
    const r = e.source
    return r.questionId ? `q:${r.questionId}` : r.fileId ? `file:${r.fileId.slice(0, 8)}` : r.followupId ? `followup:${r.followupId.slice(0, 8)}` : r.itemId ? `item:${r.itemId}` : ''
  }
  const line = (e: Entry) => `- **${e.label}**: ${e.value.replace(/\n/g, '\n  ')} \`[${ref(e)}]\``
  const out: string[] = []
  out.push(`# FreelanceDesk 案件開始パック：${p.meta.project}`)
  out.push('')
  out.push(`- 案件番号: ${p.meta.projectNumber}`)
  out.push(`- クライアント: ${p.meta.client}`)
  out.push(`- ヒアリング: ${p.meta.intakeTitle}`)
  out.push(`- ステータス: ${INTAKE_STATUS_LABEL[p.meta.intakeStatus] ?? p.meta.intakeStatus}${p.meta.readyOverride ? '（Ready上書きあり）' : ''}`)
  out.push(`- 生成日時: ${p.meta.generatedAt}`)
  out.push(`- 出典表記: \`[q:質問ID]\` \`[file:ファイルID]\` — Unknown は未回答/未確定です。`)
  out.push('')
  for (const k of PACKAGE_SECTIONS) {
    const es = p.sections[k]
    if (!es.length) continue
    out.push(`## ${SECTION_LABEL[k]}`, '', ...es.map(line), '')
  }
  out.push('---', '', `# ${p.handoff.title}`, '')
  for (const b of p.handoff.blocks) {
    out.push(`## ${b.title}`, '')
    if (b.note) out.push(`> ${b.note}`, '')
    out.push(...(b.entries.length ? b.entries.map(line) : ['- （なし）']), '')
  }
  return out.join('\n')
}

export function toText(md: string): string {
  return md.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/^>\s?/gm, '')
}
