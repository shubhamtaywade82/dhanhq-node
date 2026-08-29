import { eventBus, type Channel } from '../services/eventBus';
import { logger } from './logger';

/**
 * EventBus → Pino bridge.
 *
 * The backend already has a typed EventBus that fans telemetry out to
 * the WebSocket control plane. This bridge mirrors the same events into
 * the structured stdout log, so ONE searchable stream covers both:
 *   - what the frontend sees (logs, alerts, order fills, lifecycle)
 *   - what the platform collects (JSON on stdout → Docker/collector)
 *
 * Channel policy:
 *   log       → mapped level (INFO/WARN/ERROR/SYSTEM/TRADE)
 *   alert     → level from payload (risk engine / autonomy alerts)
 *   order     → info — business events (fills, rejections)
 *   system    → info — lifecycle (boot, kill switch, mode changes)
 *   risk      → debug — breaker snapshots (periodic)
 *   telemetry → debug — agent ReAct steps
 *   tick      → skipped — 100s/min would drown everything else
 *   portfolio → skipped — snapshots are periodic and large
 *
 * Flood guard: if the bridge writes more than BUDGET lines in a rolling
 * minute, info/debug writes are dropped (warn/error always pass) and a
 * single notice per window explains the gap. A runaway service loop
 * can never saturate stdout.
 */

const log = logger.child({ module: 'bus' });

const SKIPPED: ReadonlySet<Channel> = new Set(['tick', 'portfolio']);
const DEBUG_CHANNELS: ReadonlySet<Channel> = new Set(['risk', 'telemetry']);

const BUDGET = Number(process.env.BUS_BRIDGE_BUDGET ?? 300); // lines/min
let windowStart = Date.now();
let written = 0;
let noticed = false;

function budgetStatus(): { allow: boolean; over: boolean } {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    written = 0;
    noticed = false;
  }
  const over = written >= BUDGET;
  return { allow: !over, over };
}

function busLevelToPino(level?: string): 'info' | 'warn' | 'error' {
  switch (level) {
    case 'ERROR': return 'error';
    case 'WARN': return 'warn';
    default: return 'info'; // INFO | SYSTEM | TRADE | undefined
  }
}

function write(level: 'trace' | 'debug' | 'info' | 'warn' | 'error', obj: Record<string, unknown>, msg: string): void {
  const critical = level === 'warn' || level === 'error';
  const { allow, over } = budgetStatus();
  if (!critical) {
    if (over) {
      if (!noticed) {
        noticed = true;
        log.warn({ budget: BUDGET }, 'Bus→stdout bridge over budget — info/debug events dropped for the rest of this minute');
      }
      return;
    }
    if (!allow) return;
  }
  written++;
  log[level](obj, msg);
}

function handleEvent(channel: Channel, payload: any, ts: number): void {
  if (SKIPPED.has(channel)) return;
  const base = { channel, busTs: ts };
  const level = DEBUG_CHANNELS.has(channel) ? 'debug' : 'info';

  switch (channel) {
    case 'log': {
      write(busLevelToPino(payload?.level), { ...base, source: payload?.source, reqId: payload?.reqId }, String(payload?.message ?? ''));
      return;
    }
    case 'alert': {
      const pinoLevel = payload?.level === 'ERROR' ? 'error' : payload?.level === 'WARN' ? 'warn' : 'info';
      write(pinoLevel, { ...base, source: payload?.source, severity: payload?.level }, String(payload?.msg ?? ''));
      return;
    }
    case 'order': {
      const kind = payload?.kind ?? 'event';
      write(kind === 'rejection' ? 'warn' : 'info',
        { ...base, kind, correlationId: payload?.correlationId, symbol: payload?.symbol, qty: payload?.quantity, fillPrice: payload?.fillPrice, reason: payload?.reason, isPaper: payload?.is_paper },
        kind === 'rejection' ? 'Order rejected' : 'Order filled');
      return;
    }
    case 'system': {
      write('info', { ...base, eventType: payload?.type, state: payload?.state, reason: payload?.reason }, `System: ${payload?.type ?? 'event'}`);
      return;
    }
    default: {
      // risk | telemetry
      write(level, { ...base }, `${channel} event`);
      return;
    }
  }
}

let detach: (() => void) | null = null;

/** Idempotent — safe to call from both entry points (server.ts, index.ts). */
export function attachBusLoggerBridge(): void {
  if (detach) return;
  const off = eventBus.on('*', (env) => handleEvent(env.channel, env.payload, env.ts));
  detach = off;
  log.info({ skipped: [...SKIPPED], debugChannels: [...DEBUG_CHANNELS], budgetPerMin: BUDGET }, 'Bus→stdout bridge attached — WS telemetry now mirrored to structured logs');
}

export function detachBusLoggerBridge(): void {
  if (detach) { detach(); detach = null; }
}
