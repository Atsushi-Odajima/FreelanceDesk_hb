import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { CalcError } from '../../shared/calc';
import { type AppEnv, type Deps, makeServices, type Services } from './context';
import { readSession } from './auth/session';
import { HttpError } from './services/errors';
import { RateLimiter } from './services/ratelimit';
import { authRoutes } from './routes/auth';
import { businessRoutes } from './routes/business';
import { customerRoutes } from './routes/customers';
import { itemRoutes } from './routes/items';
import { projectRoutes } from './routes/projects';
import { attachmentRoutes } from './routes/attachments';
import { quoteRoutes } from './routes/quotes';
import { orderRoutes } from './routes/orders';
import { invoiceRoutes } from './routes/invoices';
import { paymentRoutes } from './routes/payments';
import { dashboardRoutes } from './routes/dashboard';
import { dataRoutes } from './routes/data';
import { pdfRoutes } from './routes/pdf';
import { portalAdminRoutes } from './routes/portalAdmin';
import { portalRoutes } from './routes/portal';
import { isUniqueViolation } from './db';
import { clientIp } from './services/ip';

export function createApp(deps: Deps) {
  const s = makeServices(deps);
  const app = new Hono<AppEnv>();
  const apiLimiter = new RateLimiter(600, 60_000); // 1IPあたり600リクエスト/分

  // --- 共通：リクエストログ（本文・Cookie・クエリ文字列は記録しない） ---
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    if (!s.config.isTest && c.req.path.startsWith('/api/')) {
      console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
    }
  });

  // --- セキュリティヘッダ ---
  app.use('*', async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'same-origin');
    h.set('X-Frame-Options', 'SAMEORIGIN');
    h.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
    if (!h.has('Content-Security-Policy')) {
      h.set(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; manifest-src 'self'; worker-src 'self'",
      );
    }
    if (s.config.secureCookies) h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (c.req.path.startsWith('/api/') && !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  });

  // --- API：レート制限・CSRF対策 ---
  app.use('/api/*', async (c, next) => {
    if (!apiLimiter.hit(clientIp(c, s))) throw new HttpError(429, 'アクセスが多すぎます。しばらく待ってから再度お試しください', 'rate_limited');
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
      // 独自ヘッダ必須（クロスサイトのフォーム送信や単純リクエストを拒否）
      if (c.req.header('x-requested-with') !== 'FreelanceDesk') throw new HttpError(403, '不正なリクエストです', 'csrf');
      const origin = c.req.header('origin');
      if (origin) {
        const expected = s.config.appOrigin ?? new URL(c.req.url).origin;
        const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
        const okByHost = host ? origin === `https://${host}` || origin === `http://${host}` : false;
        if (origin !== expected && !(s.config.appOrigin === null && okByHost)) throw new HttpError(403, '不正なリクエスト元です', 'csrf');
      }
    }
    await next();
  });

  // --- 本文サイズ上限（添付・復元・CSV取込は各ルートで個別に制限） ---
  const jsonLimit = bodyLimit({ maxSize: 3 * 1024 * 1024, onError: () => { throw new HttpError(413, 'データが大きすぎます', 'too_large'); } });
  const uploadLimit = bodyLimit({ maxSize: s.config.uploadMaxBytes + 256 * 1024, onError: () => { throw new HttpError(413, `ファイルが大きすぎます（上限 ${Math.floor(s.config.uploadMaxBytes / 1024 / 1024)}MB）`, 'too_large'); } });
  const PORTAL_UPLOAD = /^\/api\/projects\/[^/]+\/portal\/(deliverables\/[^/]+\/versions|selections\/[^/]+\/photos)$/;
  app.use('/api/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/data/restore' || p.startsWith('/api/data/import/')) return next();
    if (p === '/api/attachments' || PORTAL_UPLOAD.test(p)) return uploadLimit(c, next);
    return jsonLimit(c, next);
  });

  // --- 認証（/api/auth の一部以外は必須） ---
  const PUBLIC_API = new Set(['/api/auth/signup', '/api/auth/login', '/api/auth/recover', '/api/auth/reset', '/api/auth/demo', '/api/auth/config', '/api/health']);
  app.use('/api/*', async (c, next) => {
    if (PUBLIC_API.has(c.req.path)) return next();
    // クライアントポータル（顧客）は別の認証（fd_portal Cookie）。運営者セッションは参照しない
    if (c.req.path === '/api/portal' || c.req.path.startsWith('/api/portal/')) return next();
    const sess = await readSession(s.pool, s, c);
    if (!sess) throw new HttpError(401, 'ログインしてください', 'unauthenticated');
    c.set('accountId', sess.accountId);
    c.set('sessionHash', sess.tokenHash);
    c.set('isDemo', sess.isDemo);
    await next();
  });

  app.get('/api/health', async (c) => {
    await s.pool.query('SELECT 1');
    return c.json({ ok: true });
  });

  app.route('/api/auth', authRoutes(s));
  app.route('/api/business', businessRoutes(s));
  app.route('/api/customers', customerRoutes(s));
  app.route('/api/items', itemRoutes(s));
  app.route('/api/projects', portalAdminRoutes(s));
  app.route('/api/projects', projectRoutes(s));
  app.route('/api/portal', portalRoutes(s));
  app.route('/api/attachments', attachmentRoutes(s));
  app.route('/api', quoteRoutes(s));
  app.route('/api', orderRoutes(s));
  app.route('/api', invoiceRoutes(s));
  app.route('/api', paymentRoutes(s));
  app.route('/api', dashboardRoutes(s));
  app.route('/api/data', dataRoutes(s));
  app.route('/api/pdf', pdfRoutes(s));

  app.all('/api/*', (c) => c.json({ error: { message: 'APIが見つかりません', code: 'not_found' } }, 404));

  // --- 静的ファイル（本番ビルド）とSPAフォールバック ---
  const staticDir = s.config.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    const root = path.resolve(staticDir);
    const indexHtml = fs.readFileSync(path.join(root, 'index.html'));
    app.get('*', (c) => {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (rel && file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const data = fs.readFileSync(file);
        const headers: Record<string, string> = { 'Content-Type': contentType(file) };
        if (rel.startsWith('assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        else headers['Cache-Control'] = 'no-cache';
        if (rel === 'sw.js') headers['Service-Worker-Allowed'] = '/';
        return c.body(data, 200, headers);
      }
      if (path.extname(rel)) return c.text('Not Found', 404);
      return c.body(indexHtml, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    });
  }

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { message: err.message, code: err.code, details: err.details } }, err.status as 400);
    }
    if (err instanceof CalcError) return c.json({ error: { message: err.message, code: 'calc' } }, 422);
    if (err instanceof ZodError) return c.json({ error: { message: '入力内容を確認してください', code: 'validation' } }, 400);
    if (isUniqueViolation(err)) return c.json({ error: { message: '同じ内容がすでに登録されています', code: 'duplicate' } }, 409);
    // 詳細は本文や個人情報を含み得るため、ログにはエラー名とメッセージの先頭のみ
    console.error(`[error] ${c.req.method} ${c.req.path}: ${(err as Error).name}: ${String((err as Error).message).slice(0, 200)}`);
    return c.json({ error: { message: 'サーバーでエラーが発生しました', code: 'internal' } }, 500);
  });

  return app;
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.woff2': 'font/woff2',
  };
  return map[ext] ?? 'application/octet-stream';
}
