/** Controls what reaches the EventBus log channel (UI + stdout bridge).
 *  Repetitive operational chatter is deduped; errors and trades always pass. */

export type BusLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SYSTEM' | 'TRADE';

const DEDUPE_MS = Number(process.env.LOG_DEDUPE_MS ?? 60_000);
const INFO_DEDUPE_MS = Number(process.env.LOG_INFO_DEDUPE_MS ?? 300_000);
const TRADE_DEDUPE_MS = 3_000;

const recent = new Map<string, number>();

function windowFor(level: BusLogLevel): number {
  if (level === 'TRADE') return TRADE_DEDUPE_MS;
  if (level === 'ERROR') return 5_000;
  if (level === 'WARN') return DEDUPE_MS;
  return INFO_DEDUPE_MS;
}

function prune(now: number): void {
  if (recent.size <= 400) return;
  for (const [key, ts] of recent) {
    if (now - ts > INFO_DEDUPE_MS) recent.delete(key);
  }
}

/** Returns false when the same source/level/message was emitted inside the
 * dedupe window — stops 2s autonomy loops from flooding the log view. */
export function shouldEmitBusLog(level: BusLogLevel, source: string, message: string): boolean {
  if (process.env.LOG_VERBOSE === 'true') return true;
  const now = Date.now();
  const key = `${source}|${level}|${message}`;
  const last = recent.get(key);
  const window = windowFor(level);
  if (last !== undefined && now - last < window) return false;
  recent.set(key, now);
  prune(now);
  return true;
}

/** Per-key dedupe for stateful warnings (e.g. reconciler drift per instrument). */
export function shouldEmitKeyedLog(key: string, windowMs = DEDUPE_MS): boolean {
  if (process.env.LOG_VERBOSE === 'true') return true;
  const now = Date.now();
  const last = recent.get(`key:${key}`);
  if (last !== undefined && now - last < windowMs) return false;
  recent.set(`key:${key}`, now);
  prune(now);
  return true;
}

const ALERT_DEDUPE_MS = Number(process.env.ALERT_DEDUPE_MS ?? 300_000);

/** Dedupes persisted/UI alerts — strips volatile "current …" values so the
 * same breaker transition does not re-fire when only the reading changes. */
export function shouldEmitAlert(level: string, source: string, message: string): boolean {
  if (process.env.LOG_VERBOSE === 'true') return true;
  const normalized = message.replace(/\(current [^)]+\)/g, '(current *)');
  return shouldEmitKeyedLog(`alert:${source}|${level}|${normalized}`, ALERT_DEDUPE_MS);
}
