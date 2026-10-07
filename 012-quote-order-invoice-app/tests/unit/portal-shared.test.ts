/**
 * FreelanceDesk 写真セレクト / FreelanceDesk 修正指示 の共有ロジック（Client Portal から移植した単体テスト）
 */
import { describe, expect, it } from 'vitest';
import { buildCsv, buildSelectionText, checkSelection, csvField, formatNumber, naturalCompare } from '../../shared/photoSelect';
import { applyPreset, buildInstructionText, circled, normalizePinType } from '../../shared/correctionSheet';

describe('写真セレクト: 番号・読み取り・CSV（元ツールの規則）', () => {
  it('formatNumber: 3桁ゼロ埋め、100枚超・1000以上も正常', () => {
    expect([1, 12, 100, 250, 1000].map(formatNumber)).toEqual(['001', '012', '100', '250', '1000']);
  });

  it('naturalCompare: IMG_2 → IMG_10 の数字順', () => {
    expect(['IMG_10.jpg', 'IMG_2.jpg', 'img_1.jpg', 'IMG_100.jpg'].sort(naturalCompare)).toEqual(['img_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'IMG_100.jpg']);
  });

  it('buildCsv: BOM・ヘッダ・番号・CRLF・引用・数式対策', () => {
    const csv = buildCsv(['IMG_5832.jpg', 'IMG_5835.jpg', 'a,b.jpg', 'say "hi".png', '=cmd.jpg']);
    expect(csv.startsWith('﻿番号,元ファイル名\r\n')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines.slice(1)).toEqual(['001,IMG_5832.jpg', '002,IMG_5835.jpg', '003,"a,b.jpg"', '004,"say ""hi"".png"', "005,'=cmd.jpg", '']);
    // 番号を指定した場合（選択結果の書き出し）
    expect(buildCsv(['x.jpg', 'y.jpg'], [7, 12]).slice(1).split('\r\n').slice(1, 3)).toEqual(['007,x.jpg', '012,y.jpg']);
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('@a')).toBe("'@a");
  });

  it('buildCsv: 120件でも番号が連番', () => {
    const names = Array.from({ length: 120 }, (_, i) => `P${i}.jpg`);
    const lines = buildCsv(names).slice(1).trim().split('\r\n').slice(1);
    expect(lines.length).toBe(120);
    lines.forEach((l, i) => expect(l).toBe(`${formatNumber(i + 1)},P${i}.jpg`));
  });

  it('checkSelection: 001,007,012 から正しい元名', () => {
    const names = Array.from({ length: 15 }, (_, i) => `IMG_${i + 1}.jpg`);
    const r = checkSelection('001, 007、012', names);
    expect(r.results.map((x) => [x.label, x.name])).toEqual([
      ['001', 'IMG_1.jpg'],
      ['007', 'IMG_7.jpg'],
      ['012', 'IMG_12.jpg'],
    ]);
    expect(r.invalid).toEqual([]);
  });

  it('checkSelection: 区切り（カンマ・全角カンマ・読点・空白・全角空白・改行・タブ）', () => {
    const names = Array.from({ length: 20 }, (_, i) => `n${i + 1}`);
    const r = checkSelection('001，002､003\n004\t005　006  007\r\n008', names);
    expect(r.results.map((x) => x.label)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008']);
  });

  it('checkSelection: 存在しない番号は補正せず該当なし／0省略は 007 として照合', () => {
    const r = checkSelection('000 003 004 999', ['a.jpg', 'b.jpg', 'c.jpg']);
    expect(r.results.map((x) => [x.label, x.found, x.name])).toEqual([
      ['000', false, null],
      ['003', true, 'c.jpg'],
      ['004', false, null],
      ['999', false, null],
    ]);
    const r2 = checkSelection('7', Array.from({ length: 10 }, (_, i) => `x${i + 1}`));
    expect(r2.results[0]).toMatchObject({ input: '7', label: '007', name: 'x7', found: true });
  });

  it('checkSelection: 数字以外は読めない扱い・重複を知らせる・全角数字・空入力', () => {
    const r = checkSelection('00l, 7番, abc, 002', ['a', 'b', 'c']);
    expect(r.invalid).toEqual(['00l', '7番', 'abc']);
    expect(r.results.map((x) => x.label)).toEqual(['002']);
    const d = checkSelection('001 001 7 007 007', Array.from({ length: 10 }, (_, i) => 'x' + i));
    expect(d.results.map((x) => x.label)).toEqual(['001', '007']);
    expect(d.duplicates).toEqual([
      { label: '001', count: 2 },
      { label: '007', count: 3 },
    ]);
    expect(checkSelection('００３', ['a', 'b', 'c']).results[0].name).toBe('c');
    expect(checkSelection('  、, ', ['a']).empty).toBe(true);
  });

  it('buildSelectionText: 「001 → 元ファイル名」形式', () => {
    const t = buildSelectionText({ title: 'T', clientName: '山田', note: 'よろしく' }, [{ number: 7, name: 'IMG_7.jpg' }]);
    expect(t).toContain('007 → IMG_7.jpg');
    expect(t).toContain('選択枚数：1枚');
    expect(t).toContain('【コメント】\nよろしく');
    expect(buildSelectionText({}, [], '\r\n')).toContain('（選択なし）');
  });
});

describe('修正指示: 指示タイプ・修正指示テキスト（元ツールの規則）', () => {
  it('circled: ①〜⑳、21以降は (21)', () => {
    expect([1, 2, 20, 21, 100].map(circled)).toEqual(['①', '②', '⑳', '(21)', '(100)']);
  });

  it('applyPreset: 「〇〇を」+定型文、「ください」で終わる文には句点を補う', () => {
    expect(applyPreset('右下のロゴを', '削除してください')).toBe('右下のロゴを削除してください。');
    expect(applyPreset('', '色を変更してください')).toBe('色を変更してください。');
    expect(applyPreset('大きくしてください', '右へ移動してください')).toBe('大きくしてください。右へ移動してください。');
  });

  it('normalizePinType: 不明・未設定は「変更」', () => {
    expect([null, undefined, 'x', 'keep', 'delete'].map((t) => normalizePinType(t as string))).toEqual(['change', 'change', 'change', 'keep', 'delete']);
  });

  it('buildInstructionText: 【修正指示】と【変更しない箇所】を分け、番号順・備考・CRLF', () => {
    const t = buildInstructionText({ projectName: '春の新作', imageName: 'バナー v1', date: '2026-10-07', note: '全体的に明るく' }, [
      { number: 3, type: 'keep', text: 'ロゴはそのまま' },
      { number: 1, type: 'delete', text: '右下の文字を削除してください' },
      { number: 2, type: 'change', text: '' },
      { number: 4, type: 'keep', text: '' },
    ]);
    const lines = t.split('\n');
    expect(lines.slice(0, 3)).toEqual(['案件名：春の新作', '画像名：バナー v1', '作成日：2026/10/07']);
    expect(t).toContain('※ 青い四角の番号は「変更しない箇所」です。');
    const fix = t.indexOf('【修正指示】');
    const keep = t.indexOf('【変更しない箇所】');
    const note = t.indexOf('【備考】');
    expect(fix).toBeGreaterThan(0);
    expect(keep).toBeGreaterThan(fix);
    expect(note).toBeGreaterThan(keep);
    expect(t.indexOf('① [削除]')).toBeLessThan(t.indexOf('② [変更]'));
    expect(t).toContain('② [変更]\n（内容未入力）');
    expect(t).toContain('③\nロゴはそのまま');
    expect(t).toContain('④\n（内容未入力：この箇所は変更しないでください）');
    expect(t.endsWith('全体的に明るく')).toBe(true);
    const crlf = buildInstructionText({}, [{ number: 1, type: 'change', text: 'a\nb' }], '\r\n');
    expect(crlf).toContain('a\r\nb');
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n');
    expect(buildInstructionText({}, [])).toContain('【修正指示】\n\n（なし）');
    expect(buildInstructionText({}, [])).not.toContain('【変更しない箇所】');
  });
});
