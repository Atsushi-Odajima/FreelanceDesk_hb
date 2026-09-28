// 設定はすべて環境変数から読む（秘密情報をコードに書かない）
export interface AppConfig {
  databaseUrl: string;
  port: number;
  appOrigin: string | null; // 例 https://desk.example.com （CSRFのOrigin検証に使用）
  secureCookies: boolean;
  tz: string;
  uploadMaxBytes: number;
  accountStorageQuotaBytes: number;
  signupCodeRequired: boolean;
  demoEnabled: boolean;
  demoTtlHours: number;
  sessionDays: number;
  trustProxy: boolean;
  staticDir: string | null;
  isTest: boolean;
  /** 自動テスト専用。本番では絶対に true にしない */
  relaxRateLimits: boolean;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function int(v: string | undefined, def: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProd = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL が設定されていません');
  return {
    databaseUrl,
    port: int(env.PORT, 3000),
    appOrigin: env.APP_ORIGIN ? env.APP_ORIGIN.replace(/\/$/, '') : null,
    secureCookies: bool(env.SECURE_COOKIES, isProd),
    tz: env.APP_TZ || 'Asia/Tokyo',
    uploadMaxBytes: int(env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
    accountStorageQuotaBytes: int(env.ACCOUNT_STORAGE_QUOTA_BYTES, 500 * 1024 * 1024),
    signupCodeRequired: bool(env.SIGNUP_CODE_REQUIRED, false),
    demoEnabled: bool(env.DEMO_ENABLED, true),
    demoTtlHours: int(env.DEMO_ACCOUNT_TTL_HOURS, 24),
    sessionDays: int(env.SESSION_DAYS, 30),
    trustProxy: bool(env.TRUST_PROXY, isProd),
    staticDir: env.STATIC_DIR ?? null,
    isTest: env.NODE_ENV === 'test',
    relaxRateLimits: env.NODE_ENV === 'test' || bool(env.RATE_LIMIT_RELAXED_FOR_TESTS, false),
  };
}
