export interface LimitOptions {
  perKeyMax: number; perKeyWindowMs: number; globalMax: number; globalWindowMs: number; lockMs: number;
}

const MIN = 60_000;
export const codeLimiterOptions: LimitOptions = { perKeyMax: 5, perKeyWindowMs: 15 * MIN, globalMax: 20, globalWindowMs: 60 * MIN, lockMs: 15 * MIN };
export const loginLimiterOptions: LimitOptions = { perKeyMax: 5, perKeyWindowMs: 15 * MIN, globalMax: 20, globalWindowMs: 15 * MIN, lockMs: 15 * MIN };

// In memory: reset on restart, accepted by design.
export class RateLimiter {
  private perKey = new Map<string, number[]>();
  private global = new Map<string, number[]>();
  private locks = new Map<string, number>();
  private opts: LimitOptions;
  private now: () => number;

  constructor(opts: LimitOptions, now: () => number = Date.now) {
    this.opts = opts;
    this.now = now;
  }

  private recent(map: Map<string, number[]>, key: string, windowMs: number): number[] {
    const t = this.now();
    const list = (map.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length) map.set(key, list);
    else map.delete(key);
    return list;
  }

  isBlocked(scope: string, client: string): boolean {
    const lock = this.locks.get(scope);
    if (lock !== undefined) {
      if (lock > this.now()) return true;
      this.locks.delete(scope);
    }
    // The global window still applies after the 15-minute lock ends.
    if (this.recent(this.global, scope, this.opts.globalWindowMs).length >= this.opts.globalMax) return true;
    return this.recent(this.perKey, `${scope}|${client}`, this.opts.perKeyWindowMs).length >= this.opts.perKeyMax;
  }

  recordFailure(scope: string, client: string): void {
    const t = this.now();
    const key = `${scope}|${client}`;
    this.perKey.set(key, [...this.recent(this.perKey, key, this.opts.perKeyWindowMs), t]);
    const g = [...this.recent(this.global, scope, this.opts.globalWindowMs), t];
    if (g.length >= this.opts.globalMax) {
      this.locks.set(scope, t + this.opts.lockMs);
    }
    this.global.set(scope, g);
  }

  forgive(scope: string, client: string): void {
    const key = `${scope}|${client}`;
    this.perKey.get(key)?.pop();
    this.global.get(scope)?.pop();
  }

  sweep(): void {
    for (const key of [...this.perKey.keys()]) this.recent(this.perKey, key, this.opts.perKeyWindowMs);
    for (const key of [...this.global.keys()]) this.recent(this.global, key, this.opts.globalWindowMs);
    const t = this.now();
    for (const [key, until] of this.locks) if (until <= t) this.locks.delete(key);
  }
}
