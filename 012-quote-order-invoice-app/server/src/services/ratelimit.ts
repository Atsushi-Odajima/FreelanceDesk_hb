// シンプルな固定ウィンドウ型レート制限（単一インスタンス前提。複数台構成時は共有ストアへ置換）
interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** 許可なら true。超過なら false */
  hit(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.buckets.size > 50_000) this.sweep(now);
      return true;
    }
    b.count++;
    return b.count <= this.limit;
  }

  reset(key: string) {
    this.buckets.delete(key);
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}
