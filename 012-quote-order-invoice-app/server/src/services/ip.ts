import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Services } from '../context';

export function clientIp(c: Context, s: Services): string {
  if (s.config.trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
