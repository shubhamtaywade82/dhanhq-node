/**
 * Frontend structured logger.
 *
 * Mirrors the backend's Pino philosophy on the client:
 *   - structured events (level, message, extra) — same vocabulary as
 *     backend logs, so ONE query ("requestId=…", "sessionId=…") spans
 *     both sides of the stack via POST /api/client-logs
 *   - errors ALWAYS ship; debug/info/warn are sampled
 *     (VITE_LOG_SAMPLE_RATE, default 0.2) so a chatty render loop can
 *     never flood the ingest
 *   - batched: flushed every 5s, at 10 queued events, and via
 *     `navigator.sendBeacon` on pagehide (survives tab close)
 *   - privacy: never log tokens, credentials or form values — the
 *     backend redacts as the second line of defense
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3003';
const LOG_ENDPOINT = `${API_BASE}/api/client-logs`;
const SAMPLE_RATE = Number(import.meta.env.VITE_LOG_SAMPLE_RATE ?? 0.2);
const RELEASE = import.meta.env.VITE_APP_VERSION ?? 'dev';
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 10;
const MAX_QUEUE = 50;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ClientEvent {
  level: LogLevel;
  message: string;
  requestId?: string;
  url?: string;
  extra?: Record<string, unknown>;
}

// ── session identity (stable across reloads within the tab) ──────────
function getSessionId(): string {
  try {
    const KEY = 'axis-nexus-session-id';
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return 'anonymous-session';
  }
}

export const sessionId = getSessionId();

// ── queue + flushing ─────────────────────────────────────────────────
const queue: ClientEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

function shouldSample(level: LogLevel): boolean {
  if (level === 'error') return false; // errors always ship
  return Math.random() >= SAMPLE_RATE;
}

function enqueue(ev: ClientEvent): void {
  if (queue.length >= MAX_QUEUE) queue.shift(); // bound memory
  queue.push(ev);
  if (queue.length >= FLUSH_THRESHOLD) void flush('threshold');
}

async function flush(_reason: string): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const events = queue.splice(0, queue.length);
  const body = JSON.stringify({
    sessionId,
    release: RELEASE,
    userAgent: navigator.userAgent,
    events,
  });
  try {
    const res = await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    if (!res.ok && res.status !== 204) {
      // Ingest rejected — never retry-loop, just drop silently to console.
      console.warn(`[logger] ingest responded ${res.status}; ${events.length} events dropped`);
    }
  } catch {
    // Backend unreachable — same policy: drop, don't spiral.
  } finally {
    flushing = false;
  }
}

function beaconFlush(): void {
  if (queue.length === 0) return;
  const body = JSON.stringify({
    sessionId,
    release: RELEASE,
    userAgent: navigator.userAgent,
    events: queue.splice(0, queue.length),
  });
  try {
    navigator.sendBeacon?.(LOG_ENDPOINT, new Blob([body], { type: 'application/json' }));
  } catch {
    /* best effort — page is going away */
  }
}

export function startLogger(): void {
  if (timer) return;
  timer = setInterval(() => void flush('interval'), FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', beaconFlush);
  log.info('Client session started', { page: location.pathname, release: RELEASE });
}

// ── public API ───────────────────────────────────────────────────────
function clientLog(level: LogLevel, message: string, extra: Record<string, unknown> = {}, requestId?: string): void {
  if (shouldSample(level)) return;
  enqueue({ level, message, extra, requestId, url: location.pathname });
}

/** Serializes any thrown value the same way the backend does. */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

/** Report an exception with full context — the Sentry-equivalent hook. */
export function captureException(error: unknown, context: Record<string, unknown> = {}, requestId?: string): void {
  enqueue({
    level: 'error',
    message: `Exception: ${error instanceof Error ? error.message : String(error)}`,
    requestId,
    url: location.pathname,
    extra: { err: serializeError(error), ...context },
  });
  void flush('error');
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => clientLog('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => clientLog('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => clientLog('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>, requestId?: string) => clientLog('error', msg, extra, requestId),
};
