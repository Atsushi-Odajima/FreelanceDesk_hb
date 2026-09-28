// コードレビュー指摘の回帰テスト
import { describe, expect, it } from 'vitest';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Client, customerInput, pool, rid, setupInvoice, setupOrdered, signup } from '../helpers';
import { safeUnzip } from '../../server/src/services/backup';
import { clientIp } from '../../server/src/services/ip';

const restore = (c: Client, bytes: Uint8Array) => {
  const f = new FormData();
  f.append('file', new File([bytes as BlobPart], 'b.zip'));
  return c.json('POST', '/api/data/restore', f);
};

describe('バックアップ復元の防御', () => {
  it('zip爆弾：展開サイズ上限で中断する', () => {
    const bomb = zipSync({ 'data.json': new Uint8Array(50 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(() => safeUnzip(bomb, 10 * 1024 * 1024)).toThrow(/大きすぎ/);
    // 許可されていないファイル名は展開しない
    const other = safeUnzip(zipSync({ 'evil/../x.sh': strToU8('#!/bin/sh'), 'manifest.json': strToU8('{}') }), 1024);
    expect(Object.keys(other)).toEqual(['manifest.json']);
  });

  it('データのあるアカウントでは展開前に拒否', async () => {
    const A = await signup();
    await setupInvoice(A.client);
    const r = await restore(A.client, zipSync({ 'data.json': new Uint8Array(1000) }));
    expect(r._status).toBe(422);
    expect(r.error.message).toMatch(/空のアカウント/);
  });

  it('他アカウントのIDを指す行を持ち込めない', async () => {
    const victim = await signup();
    const v = await setupInvoice(victim.client);
    const A = await signup();
    await setupInvoice(A.client);
    const bytes = new Uint8Array(await (await A.client.req('GET', '/api/data/backup.zip')).arrayBuffer());
    const files = unzipSync(bytes);
    const data = JSON.parse(strFromU8(files['data.json']));
    data.tables.quote_versions[0].project_id = v.projectId; // 被害者の案件ID
    files['data.json'] = strToU8(JSON.stringify(data));
    const B = await signup();
    const r = await restore(B.client, zipSync(files));
    expect(r._status).toBe(422);
    expect(r.error.message).toMatch(/参照が不正/);
    expect((await B.client.get('/api/projects')).projects).toHaveLength(0);
  });

  it('添付の size_bytes 改ざんは実サイズに補正され、件数・金額照合で検出される', async () => {
    const A = await signup();
    const a = await setupInvoice(A.client);
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])], 'p.png'));
    fd.append('purpose', 'project');
    fd.append('projectId', a.projectId);
    await A.client.json('POST', '/api/attachments', fd);
    const bytes = new Uint8Array(await (await A.client.req('GET', '/api/data/backup.zip')).arrayBuffer());
    const files = unzipSync(bytes);
    const data = JSON.parse(strFromU8(files['data.json']));
    data.tables.attachments[0].size_bytes = 0;
    files['data.json'] = strToU8(JSON.stringify(data));
    const B = await signup();
    const r = await restore(B.client, zipSync(files));
    expect(r._status).toBe(200); // 実サイズで保存されるため manifest と一致
    const n = await pool.query('SELECT size_bytes FROM attachments WHERE account_id=$1', [B.account.id]);
    expect(Number(n.rows[0].size_bytes)).toBe(10);
  });
});

describe('同じ受注の二重請求', () => {
  it('発行済み請求がある受注は、明示指示なしでは請求書を作らない', async () => {
    const { client: c } = await signup();
    const a = await setupInvoice(c);
    const r = await c.post(`/api/projects/${a.projectId}/invoices`, { requestId: rid() });
    expect(r._status).toBe(409);
    expect(r.error.code).toBe('already_invoiced');
    const ok = await c.post(`/api/projects/${a.projectId}/invoices`, { requestId: rid(), allowAdditional: true });
    expect(ok._status).toBe(201);
  });
});

describe('レート制限のIP判定', () => {
  it('X-Forwarded-For は右端（信頼するプロキシが付けた値）を使う', () => {
    const ctx = (xff: string) => ({ req: { header: (n: string) => (n === 'x-forwarded-for' ? xff : undefined) } }) as any;
    const s = { config: { trustProxy: true } } as any;
    expect(clientIp(ctx('1.1.1.1, 9.9.9.9'), s)).toBe('9.9.9.9');
    expect(clientIp(ctx('偽装, 2.2.2.2, 9.9.9.9'), s)).toBe('9.9.9.9');
    expect(clientIp(ctx('9.9.9.9'), s)).toBe('9.9.9.9');
  });
});

describe('その他', () => {
  it('期限切れデモのセッションは即時無効', async () => {
    const demo = new Client();
    const r = await demo.post('/api/auth/demo', {}, 201);
    await pool.query("UPDATE accounts SET demo_expires_at = now() - interval '1 minute' WHERE id=$1", [r.account.id]);
    expect((await demo.get('/api/auth/me', 401))._status).toBe(401);
  });

  it('CSV取込の再送（同じrequestId）は1回分だけ取り込む', async () => {
    const { client: c } = await signup();
    const csv = '﻿顧客コード,会社名・屋号,担当者,敬称,郵便番号,住所,電話,メール,支払条件,振込名義,内部メモ\r\n,コードなし顧客,,,,,,,,,\r\n';
    const reqId = rid();
    const send = () => {
      const f = new FormData();
      f.append('file', new File([csv], 'c.csv'));
      f.append('encoding', 'utf-8');
      f.append('requestId', reqId);
      return c.json('POST', '/api/data/import/customers', f);
    };
    await Promise.all([send(), send(), send()]);
    expect((await c.get('/api/customers')).customers).toHaveLength(1);
  });

  it('期間が重なる別CSVの同時取込でも行が重複しない', async () => {
    const { client: c } = await signup();
    const row = { date: '2026-09-01', name: 'ｶﾌﾞｼｷ', amount: 1000 };
    const body = (extra: any) => ({ filename: 'x.csv', encoding: 'utf-8', mapping: { date: 0, name: 1, amount: 2, hasHeader: false }, rowCount: 2, rows: [row, extra] });
    const res = await Promise.all([
      c.post('/api/bank-imports', body({ date: '2026-09-02', name: 'A', amount: 1 })),
      c.post('/api/bank-imports', body({ date: '2026-09-03', name: 'B', amount: 2 })),
    ]);
    expect(res.every((r) => r._status === 201)).toBe(true);
    expect((await c.get('/api/payments')).payments).toHaveLength(3);
  });

  it('受注取消済みの見積からも受注状況が正しく出る（回帰）', async () => {
    const { client: c } = await signup();
    const o = await setupOrdered(c);
    await c.post(`/api/orders/${o.orderId}/cancel`, { reason: '' }, 200);
    const cu = await c.post('/api/customers', customerInput(), 201);
    expect(cu.customer.id).toBeTruthy();
  });
});
