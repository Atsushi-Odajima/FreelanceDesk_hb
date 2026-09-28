// 見積書・請求書・納品書PDF（A4縦）。DocSnapshot のホワイトリスト項目のみ描画する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, type PDFFont, type PDFPage, type PDFImage, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { DocSnapshot } from '../services/snapshot';
import { formatQuantity } from '../../../shared/calc';
import { formatDateJa } from '../../../shared/dates';

const A4: [number, number] = [595.28, 841.89];
const M = 40; // 余白
const CONTENT_W = A4[0] - M * 2;
const FOOTER_H = 30;

let fontCache: { regular: Buffer; bold: Buffer } | null = null;
function fontBytes() {
  if (fontCache) return fontCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'assets/fonts'), path.join(here, '../../assets/fonts'), path.resolve('server/assets/fonts')];
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'NotoSansJP_400Regular.ttf')));
  if (!dir) throw new Error('日本語フォントが見つかりません');
  fontCache = {
    regular: fs.readFileSync(path.join(dir, 'NotoSansJP_400Regular.ttf')),
    bold: fs.readFileSync(path.join(dir, 'NotoSansJP_700Bold.ttf')),
  };
  return fontCache;
}

function hexToRgb(hex: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? ['', '1f', '5f', 'bf'];
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

const yen = (n: number) => `${n < 0 ? '-' : ''}¥${Math.abs(n).toLocaleString('ja-JP')}`;

const TITLES: Record<DocSnapshot['docType'], string> = { quote: '御見積書', invoice: '請求書', delivery: '納品書' };

export interface RenderOptions {
  draft: boolean;
  logo?: { data: Uint8Array; mime: string } | null;
}

class Writer {
  doc: PDFDocument;
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  widthCache = new Map<string, number>();
  constructor(
    doc: PDFDocument,
    public font: PDFFont,
    public bold: PDFFont,
    public accent: ReturnType<typeof rgb>,
    public draft: boolean,
    public onNewPage: (w: Writer) => void,
  ) {
    this.doc = doc;
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - M;
    if (this.draft) {
      this.page.drawText('下書き（未確定）', { x: 130, y: 330, size: 60, font: this.bold, color: rgb(0.85, 0.85, 0.85), rotate: degrees(35), opacity: 0.5 });
    }
    this.onNewPage(this);
  }

  ensure(h: number) {
    if (this.y - h < M + FOOTER_H) this.newPage();
  }

  cw(ch: string, font: PDFFont, size: number): number {
    const key = `${font === this.bold ? 'b' : 'r'}${size}${ch}`;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      try {
        w = font.widthOfTextAtSize(ch, size);
      } catch {
        w = size;
      }
      this.widthCache.set(key, w);
    }
    return w;
  }

  width(text: string, font: PDFFont, size: number) {
    let w = 0;
    for (const ch of text) w += this.cw(ch, font, size);
    return w;
  }

  /** 日本語対応の折り返し（文字単位。英単語はなるべく途中で切らない） */
  wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
    const out: string[] = [];
    for (const para of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      let w = 0;
      const tokens = para.match(/[A-Za-z0-9@._\-/:]+|./gsu) ?? [''];
      for (const tok of tokens) {
        const tw = this.width(tok, font, size);
        if (w + tw <= maxW) {
          line += tok;
          w += tw;
          continue;
        }
        if (tw > maxW) {
          for (const ch of tok) {
            const c = this.cw(ch, font, size);
            if (w + c > maxW && line) {
              out.push(line);
              line = '';
              w = 0;
            }
            line += ch;
            w += c;
          }
          continue;
        }
        if (line) out.push(line);
        line = tok.trimStart();
        w = this.width(line, font, size);
      }
      out.push(line);
    }
    return out;
  }

  text(t: string, x: number, y: number, size: number, opts: { font?: PDFFont; color?: ReturnType<typeof rgb>; align?: 'left' | 'right' | 'center'; w?: number } = {}) {
    const font = opts.font ?? this.font;
    let dx = x;
    if (opts.align && opts.w !== undefined) {
      const tw = this.width(t, font, size);
      if (opts.align === 'right') dx = x + opts.w - tw;
      if (opts.align === 'center') dx = x + (opts.w - tw) / 2;
    }
    this.page.drawText(safeText(t), { x: dx, y, size, font, color: opts.color ?? rgb(0.1, 0.1, 0.1) });
  }

  /** 折り返し段落を描画し、高さを返す（ページ送りあり） */
  paragraph(label: string, body: string, size = 9) {
    if (!body?.trim()) return;
    const lines = this.wrap(body, this.font, size, CONTENT_W - 12);
    this.ensure(18 + Math.min(lines.length, 3) * (size + 4));
    this.text(label, M, this.y - 11, 10, { font: this.bold, color: this.accent });
    this.y -= 17;
    for (const l of lines) {
      this.ensure(size + 4);
      this.text(l, M + 6, this.y - size, size);
      this.y -= size + 4;
    }
    this.y -= 8;
  }
}

// フォントにない文字（絵文字等）で描画が失敗しないよう置換
function safeText(t: string): string {
  return String(t ?? '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '□');
}

export async function renderDocPdf(snap: DocSnapshot, opts: RenderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fb = fontBytes();
  const font = await doc.embedFont(fb.regular, { subset: true });
  const bold = await doc.embedFont(fb.bold, { subset: true });
  const accent = hexToRgb(snap.issuer.brandColor || '#1f5fbf');
  const title = TITLES[snap.docType];

  doc.setTitle(`${title} ${snap.number}`);
  doc.setAuthor(snap.issuer.name || '');
  doc.setCreator('Freelance Desk');
  doc.setProducer('Freelance Desk');
  doc.setSubject(snap.subject || '');
  doc.setKeywords([]);

  let logo: PDFImage | null = null;
  if (opts.logo) {
    try {
      logo = opts.logo.mime === 'image/png' ? await doc.embedPng(opts.logo.data) : await doc.embedJpg(opts.logo.data);
    } catch {
      logo = null;
    }
  }

  const cols = [
    { key: 'name', label: '品目・内容', w: 235, align: 'left' as const },
    { key: 'qty', label: '数量', w: 55, align: 'right' as const },
    { key: 'unit', label: '単位', w: 35, align: 'center' as const },
    { key: 'price', label: '単価', w: 72, align: 'right' as const },
    { key: 'rate', label: '税率', w: 38, align: 'right' as const },
    { key: 'amount', label: '金額', w: CONTENT_W - 235 - 55 - 35 - 72 - 38, align: 'right' as const },
  ];

  const drawTableHeader = (w: Writer) => {
    const h = 20;
    w.page.drawRectangle({ x: M, y: w.y - h, width: CONTENT_W, height: h, color: accent });
    let x = M;
    for (const c of cols) {
      w.text(c.label, x + 4, w.y - 14, 9, { font: w.bold, color: rgb(1, 1, 1), align: c.align === 'left' ? undefined : c.align, w: c.w - 8 });
      x += c.w;
    }
    w.y -= h;
  };

  let inTable = false;
  const w = new Writer(doc, font, bold, accent, opts.draft, (wr) => {
    if (wr.pages.length > 1) {
      wr.text(`${title} ${snap.number}（続き）`, M, wr.y - 12, 10, { font: wr.bold, color: accent });
      wr.y -= 24;
      if (inTable) drawTableHeader(wr);
    }
  });
  w.newPage();

  // ---- ヘッダ ----
  w.text(title, M, w.y - 24, 22, { font: bold, color: accent });
  const metaX = M + CONTENT_W - 200;
  const meta: Array<[string, string]> = [];
  meta.push([snap.docType === 'quote' ? '見積番号' : snap.docType === 'invoice' ? '請求番号' : '納品番号', snap.number]);
  if (snap.docType === 'quote') meta.push(['版', `第${snap.version}版`]);
  if (snap.docType === 'invoice' && snap.version > 1) meta.push(['訂正', `第${snap.version}版（訂正版）`]);
  meta.push([snap.docType === 'delivery' ? '納品日' : '発行日', formatDateJa(snap.docType === 'delivery' ? snap.deliveredOn : snap.issueDate)]);
  if (snap.docType === 'quote' && snap.validUntil) meta.push(['有効期限', formatDateJa(snap.validUntil)]);
  if (snap.docType === 'invoice' && snap.dueDate) meta.push(['お支払期限', formatDateJa(snap.dueDate)]);
  let my = w.y - 12;
  for (const [k, v] of meta) {
    w.text(k, metaX, my, 9, { color: rgb(0.35, 0.35, 0.35) });
    w.text(v, metaX + 60, my, 9, { align: 'right', w: 140 });
    my -= 14;
  }
  w.y = Math.min(w.y - 44, my - 6);

  // ---- 宛先（左）・発行者（右） ----
  const topY = w.y;
  const leftW = 270;
  let ly = topY;
  const rc = snap.recipient;
  if (rc.postalCode) {
    w.text(`〒${rc.postalCode}`, M, ly - 10, 9);
    ly -= 13;
  }
  for (const l of w.wrap(rc.address, font, 9, leftW)) {
    if (!l) continue;
    w.text(l, M, ly - 10, 9);
    ly -= 13;
  }
  ly -= 4;
  const nameLines = w.wrap(`${rc.name}${rc.honorific && !rc.contactName ? ` ${rc.honorific}` : ''}`, bold, 14, leftW);
  for (const l of nameLines) {
    w.text(l, M, ly - 15, 14, { font: bold });
    ly -= 20;
  }
  if (rc.contactName) {
    w.text(`${rc.contactName} ${rc.honorific === '御中' || !rc.honorific ? '様' : rc.honorific}`, M, ly - 11, 11);
    ly -= 16;
  }
  w.page.drawLine({ start: { x: M, y: ly - 3 }, end: { x: M + leftW, y: ly - 3 }, thickness: 0.8, color: accent });
  ly -= 12;

  const rx = M + CONTENT_W - 210;
  let ry = topY;
  if (logo) {
    const scale = Math.min(140 / logo.width, 44 / logo.height, 1);
    const lw = logo.width * scale;
    const lh = logo.height * scale;
    w.page.drawImage(logo, { x: rx, y: ry - lh, width: lw, height: lh });
    ry -= lh + 6;
  }
  const is = snap.issuer;
  for (const l of w.wrap(is.name, bold, 11, 210)) {
    w.text(l, rx, ry - 12, 11, { font: bold });
    ry -= 15;
  }
  const issuerLines = [
    is.contactName ? `担当：${is.contactName}` : '',
    is.postalCode ? `〒${is.postalCode}` : '',
    is.address,
    is.phone ? `TEL：${is.phone}` : '',
    is.email ? `Email：${is.email}` : '',
    is.registrationNo ? `登録番号：${is.registrationNo}` : '',
  ].filter(Boolean);
  for (const src of issuerLines) {
    for (const l of w.wrap(src, font, 8.5, 210)) {
      w.text(l, rx, ry - 10, 8.5);
      ry -= 12;
    }
  }
  w.y = Math.min(ly, ry) - 10;

  // ---- 挨拶・件名・金額 ----
  const greeting =
    snap.docType === 'quote' ? '下記のとおりお見積り申し上げます。' : snap.docType === 'invoice' ? '下記のとおりご請求申し上げます。' : '下記のとおり納品いたします。';
  w.text(greeting, M, w.y - 10, 9.5);
  w.y -= 20;
  if (snap.subject) {
    const sl = w.wrap(`件名：${snap.subject}`, bold, 11, CONTENT_W);
    for (const l of sl) {
      w.text(l, M, w.y - 12, 11, { font: bold });
      w.y -= 16;
    }
  }
  if (snap.totals) {
    const label = snap.docType === 'quote' ? 'お見積金額' : snap.docType === 'invoice' ? 'ご請求金額' : '納品金額';
    const boxH = 34;
    w.ensure(boxH + 10);
    w.page.drawRectangle({ x: M, y: w.y - boxH, width: 300, height: boxH, borderColor: accent, borderWidth: 1.2, color: rgb(0.97, 0.98, 1) });
    w.text(label, M + 10, w.y - 22, 11, { font: bold });
    w.text(`${yen(snap.totals.total)} ${snap.taxMode === 'exclusive' ? '（税込）' : '（税込）'}`, M + 90, w.y - 23, 16, { font: bold, align: 'right', w: 200 });
    w.y -= boxH + 8;
  }
  const cond: Array<[string, string]> = [];
  if (snap.docType === 'quote' && snap.deliveryNote) cond.push(['納期', snap.deliveryNote]);
  if (snap.docType === 'invoice' && snap.dueDate) cond.push(['お支払期限', formatDateJa(snap.dueDate)]);
  if (snap.paymentTerms) cond.push(['お支払条件', snap.paymentTerms]);
  for (const [k, v] of cond) {
    const lines = w.wrap(v, font, 9, CONTENT_W - 80);
    w.ensure(lines.length * 13 + 2);
    w.text(k, M, w.y - 10, 9, { font: bold });
    for (const l of lines) {
      w.text(l, M + 80, w.y - 10, 9);
      w.y -= 13;
    }
  }
  if (snap.docType === 'invoice' && snap.correction) {
    w.y -= 4;
    const t = `この請求書は訂正版（第${snap.version}版）です。訂正前金額：${yen(snap.correction.previousTotal ?? 0)}　訂正理由：${snap.correction.reason}`;
    for (const l of w.wrap(t, font, 9, CONTENT_W)) {
      w.ensure(13);
      w.text(l, M, w.y - 10, 9, { color: rgb(0.7, 0.1, 0.1) });
      w.y -= 13;
    }
  }
  w.y -= 8;

  // ---- 明細 ----
  if (snap.lines.length) {
    w.ensure(60);
    inTable = true;
    drawTableHeader(w);
    let zebra = false;
    for (const line of snap.lines) {
      const nameLines = w.wrap(line.name, font, 9, cols[0].w - 8);
      const descLines = line.description ? w.wrap(line.description, font, 7.5, cols[0].w - 8) : [];
      const h = Math.max(20, 6 + nameLines.length * 12 + descLines.length * 10 + 4);
      w.ensure(h);
      if (zebra) w.page.drawRectangle({ x: M, y: w.y - h, width: CONTENT_W, height: h, color: rgb(0.965, 0.97, 0.98) });
      zebra = !zebra;
      let ty = w.y - 14;
      for (const l of nameLines) {
        w.text(l, M + 4, ty, 9);
        ty -= 12;
      }
      for (const l of descLines) {
        w.text(l, M + 4, ty + 1, 7.5, { color: rgb(0.4, 0.4, 0.4) });
        ty -= 10;
      }
      let x = M + cols[0].w;
      const vals = [formatQuantity(line.quantity), line.unit, yen(line.unitPrice), `${line.taxRate}%`, yen(line.amount)];
      vals.forEach((v, i) => {
        const c = cols[i + 1];
        w.text(v, x + 4, w.y - 14, 9, { align: c.align, w: c.w - 8 });
        x += c.w;
      });
      w.page.drawLine({ start: { x: M, y: w.y - h }, end: { x: M + CONTENT_W, y: w.y - h }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
      w.y -= h;
    }
    inTable = false;
  }

  // ---- 合計 ----
  if (snap.totals) {
    const t = snap.totals;
    const rows: Array<[string, string, boolean?]> = [[snap.taxMode === 'inclusive' ? '小計（税込）' : '小計（税抜）', yen(t.subtotal)]];
    for (const a of snap.adjustments) rows.push([`${a.kind === 'discount' ? '値引き' : '追加費用'}：${a.label}（${a.taxRate}%）`, a.kind === 'discount' ? `-${yen(a.amount)}` : yen(a.amount)]);
    for (const b of t.taxBreakdown) {
      rows.push([
        `${b.rate}%対象 ${yen(b.base)}　${snap.taxMode === 'inclusive' ? 'うち消費税' : '消費税'}`,
        yen(b.tax),
      ]);
    }
    rows.push(['合計', yen(t.total), true]);
    const bw = 300;
    const bx = M + CONTENT_W - bw;
    w.y -= 6;
    for (const [k, v, strong] of rows) {
      const kl = w.wrap(k, font, 9, bw - 110);
      const h = strong ? 24 : Math.max(16, kl.length * 12 + 4);
      w.ensure(h);
      if (strong) w.page.drawRectangle({ x: bx, y: w.y - h, width: bw, height: h, color: rgb(0.93, 0.95, 0.99) });
      let yy = w.y - (strong ? 16 : 12);
      kl.forEach((l, i) => w.text(l, bx + 6, yy - i * 12, strong ? 11 : 9, { font: strong ? bold : font }));
      w.text(v, bx + bw - 106, yy, strong ? 12 : 9, { font: strong ? bold : font, align: 'right', w: 100 });
      w.page.drawLine({ start: { x: bx, y: w.y - h }, end: { x: bx + bw, y: w.y - h }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
      w.y -= h;
      yy = 0;
    }
    const note = `端数処理：明細金額 ${roundLabel(snap.lineRounding)}／消費税 ${roundLabel(snap.taxRounding)}（税率ごとに計算）`;
    w.ensure(14);
    w.text(note, bx, w.y - 11, 7, { color: rgb(0.45, 0.45, 0.45) });
    w.y -= 22;
  }

  // ---- 付記 ----
  if (snap.docType === 'delivery') {
    w.paragraph('納品内容', snap.content ?? '');
    w.paragraph('コメント', snap.customerComment ?? '');
  }
  if (snap.docType === 'invoice') w.paragraph('お振込先', snap.bankInfo ?? '');
  w.paragraph('備考', snap.notes);

  // ---- ページ番号 ----
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    const label = `${i + 1} / ${total}`;
    p.drawText(label, { x: A4[0] / 2 - w.width(label, font, 8) / 2, y: M - 20, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
  });

  return doc.save({ useObjectStreams: true });
}

function roundLabel(m: string) {
  return m === 'floor' ? '切り捨て' : m === 'ceil' ? '切り上げ' : '四捨五入';
}
