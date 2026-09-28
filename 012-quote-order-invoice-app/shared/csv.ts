// RFC 4180 準拠の CSV パーサ/ライタ（split(',') は使わない）
// - 引用符内のカンマ・改行・二重引用符("")に対応
// - CRLF / LF / CR の行末に対応
// - 先頭の BOM を除去

export interface ParseResult {
  rows: string[][];
  errors: string[];
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(input: string, delimiter = ','): ParseResult {
  const text = stripBom(input);
  const rows: string[][] = [];
  const errors: string[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false; // 引用符で始まったフィールドか
  let line = 1;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // 完全な空行は無視
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        // 閉じ引用符の後は区切り/改行/終端のみ許容。それ以外は寛容に連結
        const next = text[i];
        if (next !== undefined && next !== delimiter && next !== '\n' && next !== '\r') {
          errors.push(`${line}行目: 引用符の後に不正な文字があります`);
        }
        continue;
      }
      if (c === '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === '\r') {
      endRow();
      line++;
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      line++;
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (inQuotes) errors.push(`${line}行目: 引用符が閉じられていません`);
  if (field !== '' || row.length > 0) endRow();
  return { rows, errors };
}

/** CSV数式インジェクション対策：先頭が = + - @ TAB CR の文字列はシングルクォートを前置 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export type CsvCell = string | number | null | undefined;

function escapeCell(v: CsvCell): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number') return String(v); // 数値列は数式扱いされないのでそのまま
  const s = neutralizeFormula(String(v));
  return `"${s.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM付き・CRLF・全テキスト引用のCSV文字列を作る */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header.map((h) => escapeCell(h)), ...rows.map((r) => r.map(escapeCell))].map((cells) => cells.join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** 銀行明細などの金額表記を整数円へ。"1,234" "¥1,234" "1234円" "(1,234)" に対応。解釈不能は null */
export function parseYenAmount(raw: string): number | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  s = s.replace(/[¥￥,，円\s]/g, '');
  if (s === '' || s === '-') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-') || s.startsWith('△') || s.startsWith('▲')) {
    neg = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.0+)?$/.test(s)) return null;
  const n = Number(s.split('.')[0]);
  if (!Number.isSafeInteger(n)) return null;
  return neg ? -n : n;
}

/** 日付表記を YYYY-MM-DD へ。"2026/9/1" "2026-09-01" "20260901" "2026年9月1日" "R8.9.1"(非対応→null) */
export function parseDateLoose(raw: string): string | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  let m = s.match(/^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?(?:\s.*)?$/);
  if (!m) {
    const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m2) m = m2;
  }
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
