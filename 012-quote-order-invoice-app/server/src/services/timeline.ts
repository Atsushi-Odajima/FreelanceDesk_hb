// 案件詳細のタイムライン：問い合わせ→見積→受注→作業→納品→請求→入金
import type { TimelineStep } from '../../../shared/status';
import { TIMELINE_LABELS } from '../../../shared/status';

export type StepState = 'done' | 'current' | 'pending' | 'skipped';

export interface TimelineEntry {
  step: TimelineStep;
  label: string;
  state: StepState;
  date: string | null;
  document: { type: string; id: string; label: string } | null;
  memo: string;
  nextAction: { key: string; label: string } | null;
}

export interface TimelineInput {
  project: { status: string; inquiry_date: string | null; created_at: string };
  quoteVersions: Array<{ id: string; number: string; version: number; status: string; submitted_on: string | null; finalized_at: string | null; total: number; created_at: string }>;
  order: { id: string; order_date: string; amount: number } | null;
  tasks: Array<{ done: boolean }>;
  deliveries: Array<{ id: string; number: string; delivered_on: string }>;
  invoices: Array<{ id: string; number: string | null; status: string; issueDate: string | null; total: number; paymentState: string | null; remaining: number; lastPaymentOn: string | null; overdue: boolean }>;
}

export function buildTimeline(d: TimelineInput): TimelineEntry[] {
  const closed = d.project.status === 'lost' || d.project.status === 'cancelled';
  const entries: TimelineEntry[] = [];
  const push = (step: TimelineStep, e: Omit<TimelineEntry, 'step' | 'label'>) => entries.push({ step, label: TIMELINE_LABELS[step], ...e });

  push('inquiry', { state: 'done', date: d.project.inquiry_date ?? d.project.created_at?.slice?.(0, 10) ?? null, document: null, memo: '', nextAction: null });

  const latest = [...d.quoteVersions].sort((a, b) => b.version - a.version)[0];
  const lastFinal = [...d.quoteVersions].filter((v) => v.status === 'final').sort((a, b) => b.version - a.version)[0];
  if (!latest) {
    push('quote', { state: closed ? 'skipped' : 'current', date: null, document: null, memo: '', nextAction: closed ? null : { key: 'create_quote', label: '見積を作成' } });
  } else if (latest.status === 'draft') {
    push('quote', {
      state: d.order ? 'done' : 'current',
      date: null,
      document: { type: 'quote_version', id: latest.id, label: `${latest.number} v${latest.version}（下書き）` },
      memo: lastFinal ? `確定済み: v${lastFinal.version}` : '',
      nextAction: d.order || closed ? null : { key: 'edit_quote', label: '見積を編集・確定' },
    });
  } else {
    const submitted = latest.submitted_on;
    push('quote', {
      state: submitted || d.order ? 'done' : 'current',
      date: submitted ?? latest.finalized_at?.slice?.(0, 10) ?? null,
      document: { type: 'quote_version', id: latest.id, label: `${latest.number} v${latest.version}` },
      memo: submitted ? `提出済み（${latest.total.toLocaleString('ja-JP')}円）` : '確定済み・未提出',
      nextAction: submitted || d.order || closed ? null : { key: 'submit_quote', label: '提出済みにする' },
    });
  }

  const quoteDone = entries[1].state === 'done';
  push('order', {
    state: d.order ? 'done' : closed ? 'skipped' : quoteDone ? 'current' : 'pending',
    date: d.order?.order_date ?? null,
    document: d.order ? { type: 'order', id: d.order.id, label: `受注 ${d.order.amount.toLocaleString('ja-JP')}円` } : null,
    memo: '',
    nextAction: !d.order && quoteDone && !closed ? { key: 'create_order', label: 'この見積で受注' } : null,
  });

  const doneTasks = d.tasks.filter((t) => t.done).length;
  const delivered = d.deliveries.length > 0;
  push('work', {
    state: delivered || (d.tasks.length > 0 && doneTasks === d.tasks.length) ? 'done' : closed ? 'skipped' : d.order ? 'current' : 'pending',
    date: null,
    document: null,
    memo: d.tasks.length ? `タスク ${doneTasks}/${d.tasks.length} 完了` : '',
    nextAction: d.order && !delivered && !closed ? { key: 'tasks', label: 'タスクを進める' } : null,
  });

  const lastDelivery = [...d.deliveries].sort((a, b) => b.delivered_on.localeCompare(a.delivered_on))[0];
  push('delivery', {
    state: delivered ? 'done' : closed ? 'skipped' : d.order ? 'current' : 'pending',
    date: lastDelivery?.delivered_on ?? null,
    document: lastDelivery ? { type: 'delivery', id: lastDelivery.id, label: lastDelivery.number } : null,
    memo: d.deliveries.length > 1 ? `納品 ${d.deliveries.length}件` : '',
    nextAction: d.order && !delivered && !closed ? { key: 'create_delivery', label: '納品を記録' } : null,
  });

  const issued = d.invoices.filter((i) => i.status === 'issued');
  const drafts = d.invoices.filter((i) => i.status === 'draft');
  const lastIssued = [...issued].sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? ''))[0];
  push('invoice', {
    state: issued.length ? 'done' : closed ? 'skipped' : d.order ? 'current' : 'pending',
    date: lastIssued?.issueDate ?? null,
    document: lastIssued
      ? { type: 'invoice', id: lastIssued.id, label: `${lastIssued.number}（${lastIssued.total.toLocaleString('ja-JP')}円）` }
      : drafts[0]
        ? { type: 'invoice', id: drafts[0].id, label: '請求書（下書き）' }
        : null,
    memo: issued.length > 1 ? `請求 ${issued.length}件` : '',
    nextAction: d.order && !issued.length && !closed ? { key: drafts.length ? 'edit_invoice' : 'create_invoice', label: drafts.length ? '請求書を確定' : '請求書を作る' } : null,
  });

  const allPaid = issued.length > 0 && issued.every((i) => i.paymentState === 'paid' || i.paymentState === 'overpaid');
  const anyPaid = issued.some((i) => i.paymentState === 'partial' || i.paymentState === 'paid' || i.paymentState === 'overpaid');
  const remaining = issued.reduce((s, i) => s + Math.max(0, i.remaining), 0);
  const lastPay = issued.map((i) => i.lastPaymentOn).filter(Boolean).sort().reverse()[0] ?? null;
  push('payment', {
    state: allPaid ? 'done' : closed ? 'skipped' : issued.length ? 'current' : 'pending',
    date: lastPay,
    document: null,
    memo: issued.length
      ? allPaid
        ? '入金済み'
        : `${anyPaid ? '一部入金' : '未入金'}・残額 ${remaining.toLocaleString('ja-JP')}円${issued.some((i) => i.overdue) ? '（期限超過）' : ''}`
      : '',
    nextAction:
      issued.length && !allPaid && !closed
        ? { key: 'record_payment', label: '入金を記録' }
        : allPaid && d.project.status !== 'completed'
          ? { key: 'complete', label: '案件を完了にする' }
          : null,
  });
  return entries;
}
