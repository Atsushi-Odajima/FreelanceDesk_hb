import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Services } from '../context';

export function clientIp(c: Context, s: Services): string {
  if (s.config.trustProxy) {
    // 先頭は利用者が自由に偽装できるため、信頼するプロキシが追加した右端側を使う（TRUST_PROXY_HOPS 段）
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      const hops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS ?? 1) || 1);
      const ip = parts[Math.max(0, parts.length - hops)];
      if (ip) return ip;
    }
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
