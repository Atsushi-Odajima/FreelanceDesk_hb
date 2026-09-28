// PDFに埋め込まれたフォント（サブセット）のグリフに輪郭があるかを調べる（文字化け・欠落の検出用）
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export async function embeddedGlyphStats(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  const results: Array<{ glyphs: number; empty: number }> = [];
  const fontFiles: PDFRawStream[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d: any = (obj as any).dict ?? obj;
    if (d?.get?.(PDFName.of('Type'))?.toString() !== '/FontDescriptor') continue;
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      const ref = d.get(PDFName.of(key));
      if (ref) fontFiles.push(doc.context.lookup(ref) as PDFRawStream);
    }
  }
  for (const obj of fontFiles) {
    const bytes = decodePDFRawStream(obj).decode();
    const font: any = fontkit.create(Buffer.from(bytes));
    let empty = 0;
    for (let i = 1; i < font.numGlyphs; i++) {
      try {
        const g = font.getGlyph(i);
        if (!g.path.commands.length && g.advanceWidth > 0) empty++;
      } catch {
        empty++; // 読み取れないグリフ＝壊れたサブセット
      }
    }
    results.push({ glyphs: font.numGlyphs - 1, empty });
  }
  return results;
}
