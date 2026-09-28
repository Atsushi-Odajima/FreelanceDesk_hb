// 案件状態・書類状態の定義（クライアント/サーバー共通）
export const PROJECT_STATUSES = [
  'inquiry',
  'quoting',
  'quote_submitted',
  'considering',
  'ordered',
  'in_progress',
  'awaiting_delivery',
  'delivered',
  'invoiced',
  'completed',
  'lost',
  'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  inquiry: '問い合わせ',
  quoting: '見積作成中',
  quote_submitted: '見積提出',
  considering: '検討中',
  ordered: '受注',
  in_progress: '作業中',
  awaiting_delivery: '納品待ち',
  delivered: '納品済み',
  invoiced: '請求済み',
  completed: '完了',
  lost: '失注',
  cancelled: 'キャンセル',
};

// 自動で進める場合の順序（戻す自動遷移はしない）
export const PROJECT_STATUS_RANK: Record<ProjectStatus, number> = {
  inquiry: 0,
  quoting: 1,
  quote_submitted: 2,
  considering: 3,
  ordered: 4,
  in_progress: 5,
  awaiting_delivery: 6,
  delivered: 7,
  invoiced: 8,
  completed: 9,
  lost: 100,
  cancelled: 100,
};

export const CLOSED_STATUSES: ProjectStatus[] = ['completed', 'lost', 'cancelled'];

/** 操作に伴う自動前進。終了状態や、すでに先の状態なら変えない */
export function advanceStatus(current: ProjectStatus, target: ProjectStatus): ProjectStatus {
  if (CLOSED_STATUSES.includes(current)) return current;
  return PROJECT_STATUS_RANK[target] > PROJECT_STATUS_RANK[current] ? target : current;
}

export const TIMELINE_STEPS = ['inquiry', 'quote', 'order', 'work', 'delivery', 'invoice', 'payment'] as const;
export type TimelineStep = (typeof TIMELINE_STEPS)[number];
export const TIMELINE_LABELS: Record<TimelineStep, string> = {
  inquiry: '問い合わせ',
  quote: '見積',
  order: '受注',
  work: '作業',
  delivery: '納品',
  invoice: '請求',
  payment: '入金',
};

export const HONORIFICS = ['御中', '様', '殿', ''] as const;

export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: '銀行振込',
  cash: '現金',
  card: 'カード等',
  other: 'その他',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: '下書き',
  issued: '発行済み',
  cancelled: '取消',
};
