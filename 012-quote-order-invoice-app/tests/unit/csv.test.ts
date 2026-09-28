import { describe, expect, it } from 'vitest';
import { neutralizeFormula, parseCsv, parseDateLoose, parseYenAmount, toCsv } from '../../shared/csv';

describe('CSVパーサ（split禁止・RFC4180）', () => {
  it('引用符内のカンマ・改行・二重引用符', () => {
    const csv = '日付,名義,金額\r\n2026/09/01,"サンプル, デザイン","1,000"\r\n2026/09/02,"改行\nあり","""引用"""\r\n';
    const r = parseCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      ['日付', '名義', '金額'],
      ['2026/09/01', 'サンプル, デザイン', '1,000'],
      ['2026/09/02', '改行\nあり', '"引用"'],
    ]);
  });
  it('BOM付きUTF-8の先頭BOMを除去', () => {
    const r = parseCsv('﻿a,b\n1,2');
    expect(r.rows[0]).toEqual(['a', 'b']);
  });
  it('LF / CR / CRLF 混在・空フィールド・末尾改行なし', () => {
    const r = parseCsv('a,,c\rd,e,\nf,g,h');
    expect(r.rows).toEqual([
      ['a', '', 'c'],
      ['d', 'e', ''],
      ['f', 'g', 'h'],
    ]);
  });
  it('空行は無視', () => {
    expect(parseCsv('a\n\n\nb\n').rows).toEqual([['a'], ['b']]);
  });
  it('閉じられていない引用符はエラーとして報告', () => {
    expect(parseCsv('a,"b\nc').errors.length).toBe(1);
  });
});

describe('CSV出力', () => {
  it('BOM・CRLF・全テキスト引用・数式インジェクション対策', () => {
    const out = toCsv(['名前', '金額'], [['=SUM(A1)', 100], ['a"b', -5], ['+81', null], ['@x', 0], ['-1+1', 1]]);
    expect(out.startsWith('﻿')).toBe(true);
    const lines = out.slice(1).split('\r\n');
    expect(lines[0]).toBe('"名前","金額"');
    expect(lines[1]).toBe(`"'=SUM(A1)",100`);
    expect(lines[2]).toBe('"a""b",-5'); // 数値列の負数はそのまま
    expect(lines[3]).toBe(`"'+81",""`);
    expect(lines[4]).toBe(`"'@x",0`);
    expect(lines[5]).toBe(`"'-1+1",1`);
  });
  it('出力→解析の往復で値が一致（改行・カンマ含む）', () => {
    const rows = [['住所\n2行目', 'a,b', '"q"']];
    const back = parseCsv(toCsv(['x', 'y', 'z'], rows)).rows;
    expect(back[1]).toEqual(rows[0]);
  });
  it('neutralizeFormula', () => {
    expect(neutralizeFormula('\tcmd')).toBe("'\tcmd");
    expect(neutralizeFormula('普通')).toBe('普通');
  });
});

describe('銀行明細の金額・日付表記', () => {
  it('金額', () => {
    expect(parseYenAmount('1,234')).toBe(1234);
    expect(parseYenAmount('¥30,000')).toBe(30000);
    expect(parseYenAmount('７０，０００円')).toBe(70000);
    expect(parseYenAmount('')).toBeNull();
    expect(parseYenAmount('-500')).toBe(-500);
    expect(parseYenAmount('(500)')).toBe(-500);
    expect(parseYenAmount('12.50')).toBeNull();
    expect(parseYenAmount('100.00')).toBe(100);
    expect(parseYenAmount('abc')).toBeNull();
  });
  it('日付', () => {
    expect(parseDateLoose('2026/9/1')).toBe('2026-09-01');
    expect(parseDateLoose('2026-09-01')).toBe('2026-09-01');
    expect(parseDateLoose('20260901')).toBe('2026-09-01');
    expect(parseDateLoose('2026年9月1日')).toBe('2026-09-01');
    expect(parseDateLoose('2026/02/30')).toBeNull();
    expect(parseDateLoose('R8.9.1')).toBeNull();
  });
});
