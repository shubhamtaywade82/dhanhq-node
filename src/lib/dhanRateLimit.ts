import { shouldEmitKeyedLog } from './logPolicy';

let limitedUntil = 0;
let consecutiveLimits = 0;

export function isRateLimitError(msg: string): boolean {
  const m = String(msg || '').toLowerCase();
  return m.includes('429') || m.includes('rate limit') || m.includes('dh-904');
}

export function isDhanRateLimited(): boolean {
  return Date.now() < limitedUntil;
}

export function dhanRateLimitRemainingSec(): number {
  return Math.max(0, Math.ceil((limitedUntil - Date.now()) / 1000));
}

export function dhanRateLimitRemainingMs(): number {
  return Math.max(0, limitedUntil - Date.now());
}

export function noteDhanRateLimit(
  err?: { message?: string; retryAfterMs?: number },
  log?: (message: string) => void,
): void {
  consecutiveLimits++;
  const retryAfter = Number(err?.retryAfterMs ?? 0);
  const backoffMs = retryAfter > 0
    ? retryAfter
    : Math.min(10_000 * 2 ** (consecutiveLimits - 1), 120_000);
  limitedUntil = Date.now() + backoffMs;
  if (log && shouldEmitKeyedLog('dhan_api:rate_limit', 30_000)) {
    log(`Dhan API rate-limited — pausing broker calls for ${Math.round(backoffMs / 1000)}s`);
  }
}

export function clearDhanRateLimit(): void {
  consecutiveLimits = 0;
  limitedUntil = 0;
}

/** Test isolation — not for production use. */
export function resetDhanRateLimitForTests(): void {
  clearDhanRateLimit();
}
