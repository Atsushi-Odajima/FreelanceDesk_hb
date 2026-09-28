// 日付は 'YYYY-MM-DD' 文字列で扱う。基準タイムゾーンは Asia/Tokyo（APP_TZ で変更可）
export function todayIn(tz = 'Asia/Tokyo', now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function startOfMonth(date: string): string {
  return date.slice(0, 8) + '01';
}

export function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 0));
  return dt.toISOString().slice(0, 10);
}

/** 週（月曜始まり）の開始日と終了日 */
export function weekRange(date: string): { from: string; to: string } {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日
  const offset = dow === 0 ? -6 : 1 - dow;
  const from = addDays(date, offset);
  return { from, to: addDays(from, 6) };
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function formatDateJa(s: string | null | undefined): string {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

export function formatDateTimeJa(iso: string | null | undefined, tz = 'Asia/Tokyo'): string {
  if (!iso) return '';
  const dt = new Date(iso);
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(dt);
}
