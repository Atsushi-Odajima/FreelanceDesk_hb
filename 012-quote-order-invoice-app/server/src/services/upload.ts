// 添付ファイル検証：拡張子の許可リスト＋ファイル先頭バイト（実体）の検査。
// ブラウザが申告するMIMEは信用せず、実体から判定したMIMEで保存・配信する。

export interface DetectedFile {
  mime: string;
  kind: 'image' | 'pdf' | 'text' | 'office' | 'video';
}

export class UploadRejected extends Error {}

const DANGEROUS_EXT = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'pif', 'cpl', 'js', 'mjs', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'sh', 'bash', 'zsh', 'command', 'app', 'dmg', 'pkg', 'apk', 'ipa', 'jar', 'py', 'rb', 'pl', 'php', 'asp', 'aspx', 'jsp', 'cgi',
  'html', 'htm', 'xhtml', 'svg', 'svgz', 'xml', 'hta', 'lnk', 'url', 'reg', 'iso', 'img', 'vhd', 'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'swf',
]);

const OOXML: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const ALLOWED_DESCRIPTION = '画像（JPEG/PNG/GIF/WebP/HEIC）、PDF、テキスト/CSV、Word/Excel/PowerPoint（docx/xlsx/pptx）、動画（MP4/MOV）';

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, Math.min(end, buf.length)));
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return m ? m[1].toLowerCase() : '';
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // 制御文字・パス区切り・引用符を除去
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim();
  const limited = cleaned.length > 150 ? cleaned.slice(0, 120) + cleaned.slice(-30) : cleaned;
  return limited || 'file';
}

function isValidUtf8Text(buf: Uint8Array): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    // Shift_JIS 等のテキストも許容（NULなし・制御文字が少ない）
    let ctrl = 0;
    for (const b of buf.subarray(0, 4096)) if (b < 0x09 || (b > 0x0d && b < 0x20)) ctrl++;
    return ctrl === 0;
  }
}

export function detectFile(filename: string, buf: Uint8Array): DetectedFile {
  const ext = extensionOf(filename);
  if (DANGEROUS_EXT.has(ext)) throw new UploadRejected(`この種類のファイル（.${ext}）は安全のため添付できません`);
  // 実行ファイル・スクリプトの実体を拒否（拡張子偽装対策）
  if (startsWith(buf, [0x4d, 0x5a]) || startsWith(buf, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(buf, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(buf, [0xca, 0xfe, 0xba, 0xbe]) || startsWith(buf, [0x23, 0x21])) {
    throw new UploadRejected('実行ファイルは添付できません');
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', kind: 'image' };
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return { mime: 'image/gif', kind: 'image' };
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (ascii(buf, 0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'pdf' };
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { mime: brand === 'mif1' || brand === 'msf1' ? 'image/heif' : 'image/heic', kind: 'image' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video' };
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(brand)) return { mime: 'video/mp4', kind: 'video' };
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    if (!OOXML[ext]) throw new UploadRejected('ZIP形式のファイルは docx/xlsx/pptx のみ添付できます');
    const head = Buffer.from(buf).toString('latin1');
    if (!head.includes('[Content_Types].xml')) throw new UploadRejected('Officeファイルとして認識できません');
    if (head.includes('vbaProject')) throw new UploadRejected('マクロを含むOfficeファイルは添付できません');
    return { mime: OOXML[ext], kind: 'office' };
  }
  if (['txt', 'csv', 'md', 'tsv'].includes(ext) && isValidUtf8Text(buf)) {
    return { mime: ext === 'csv' ? 'text/csv' : 'text/plain', kind: 'text' };
  }
  throw new UploadRejected(`添付できないファイル形式です。対応形式：${ALLOWED_DESCRIPTION}`);
}

/** Content-Disposition（日本語ファイル名は RFC 5987 形式） */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
