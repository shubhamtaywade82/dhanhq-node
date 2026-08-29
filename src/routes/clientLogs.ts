import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { moduleLogger } from '../lib/logger';

/**
 * POST /api/client-logs — frontend log ingest.
 *
 * The SPA ships a tiny structured logger (frontend/src/services/logger.ts)
 * that batches events and posts them here (sendBeacon on unload). This
 * endpoint:
 *   - validates + bounds the payload (never trust the client),
 *   - rate-limits per IP so a broken render loop cannot flood stdout,
 *   - writes each event as a structured Pino line tagged
 *     source=frontend — the SAME stream as backend logs, so one query
 *     ("requestId=..." / "sessionId=...") spans both sides of the stack.
 *
 * Privacy: the client logger never sends tokens, form values or PII;
 * server-side redaction (lib/logger.ts) is the second line of defense.
 */

const log = moduleLogger('client-logs');

const EventSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().min(1).max(2000),
  requestId: z.string().max(128).optional(),
  url: z.string().max(500).optional(),
  extra: z.record(z.string(), z.any()).optional(),
});

const BodySchema = z.object({
  sessionId: z.string().min(4).max(64),
  release: z.string().max(64).optional(),
  page: z.string().max(200).optional(),
  userAgent: z.string().max(300).optional(),
  events: z.array(EventSchema).min(1).max(50),
});

const MAX_EXTRA_BYTES = 2048; // per-event extra payload cap

function extraSize(extra: unknown): number {
  if (extra == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(extra ?? {})); } catch { return MAX_EXTRA_BYTES + 1; }
}

// ── naive per-IP token bucket: 120 batches/min, burst 30 ────────────
const RATE_LIMIT = Number(process.env.CLIENT_LOG_RATE_LIMIT ?? 120);
const buckets = new Map<string, { tokens: number; last: number }>();

function allow(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: 30, last: now };
  b.tokens = Math.min(30, b.tokens + ((now - b.last) / 60_000) * RATE_LIMIT);
  b.last = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1;
  buckets.set(ip, b);
  if (buckets.size > 10_000) buckets.clear(); // bound memory
  return true;
}

export function clientLogsRoutes(): Router {
  const router = Router();

  router.post('/', (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    if (!allow(ip)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      log.warn({ ip, issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')) }, 'Rejected malformed client log batch');
      res.status(400).json({ error: 'Invalid log payload' });
      return;
    }

    const { sessionId, release, page, userAgent, events } = parsed.data;
    for (const ev of events) {
      const extra = extraSize(ev.extra) <= MAX_EXTRA_BYTES ? ev.extra : { note: 'extra dropped — too large' };
      log[ev.level](
        {
          source: 'frontend',
          sessionId,
          release: release ?? 'unknown',
          page: ev.url ?? page,
          userAgent,
          requestId: ev.requestId,
          ...extra,
        },
        ev.message,
      );
    }

    // Fast + cheap — the client never needs a body back.
    res.status(204).end();
  });

  return router;
}
