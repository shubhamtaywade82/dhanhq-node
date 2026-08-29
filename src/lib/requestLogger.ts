import pinoHttp, { stdSerializers, type ReqId } from 'pino-http';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { parseTraceparent } from './logger';

/**
 * HTTP request logging middleware (pino-http).
 *
 * Behavior:
 *   - Correlation: honors an inbound `x-request-id` / `x-correlation-id`
 *     header (the frontend sends one on every API call) or generates a
 *     UUID. The id is echoed back as `x-request-id` on the response so
 *     the client can attach it to follow-up reports.
 *   - OpenTelemetry: if the caller sends a W3C `traceparent` header,
 *     its traceId/spanId are bound onto the request logger — logs and
 *     traces stay correlatable without a full OTel SDK on our side.
 *   - Noise control: `/api/health` (polled every few seconds by the
 *     control plane) is excluded from access logging.
 *   - `req.log` is a child logger carrying requestId (+traceId) — use it
 *     inside any route: `req.log.info({ symbol }, 'order placed')`.
 */

// NOTE: pino-http already augments http.IncomingMessage with
// `id: ReqId` and `log: pino.Logger`, and Express's Request extends
// IncomingMessage — so `req.log` / `req.id` are fully typed everywhere
// without any local module augmentation (re-declaring them here would
// conflict with pino-http's types).

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestLogger: import('express').RequestHandler = pinoHttp({
  logger,
  genReqId: (req: Request, res: Response) => {
    const incoming =
      (req.headers['x-request-id'] as string | undefined) ||
      (req.headers['x-correlation-id'] as string | undefined);
    const id = incoming && /^[\w.-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, String(id));
    return id as ReqId;
  },
  customProps: (req: Request) => {
    const trace = parseTraceparent(req.headers.traceparent);
    return trace ? { traceId: trace.traceId, spanId: trace.spanId } : {};
  },
  customSuccessMessage: (req: Request, res: Response) =>
    `${req.method} ${req.originalUrl ?? req.url} → ${res.statusCode}`,
  customErrorMessage: (req: Request, res: Response, err: Error) =>
    `${req.method} ${req.originalUrl ?? req.url} → ${res.statusCode} (${err.message})`,
  customLogLevel: (_req: Request, res: Response, err?: unknown) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: {
    ignore: (req: Request) => {
      const url = req.url ?? '';
      // Health/readiness probes are polled continuously — keep them out
      // of the access log so real traffic stays readable.
      return url === '/api/health' || url.startsWith('/api/health?');
    },
  },
  // Quiet serializers: no request bodies in logs (they can carry order
  // params and tokens) — method/url/status/duration are enough.
  serializers: {
    req: stdSerializers.req,
    res: stdSerializers.res,
  },
});


/**
 * Central error handler — MUST be registered LAST (after all routes).
 * Express 5 async route rejections land here. Logs the error with the
 * request's correlation id and stack, and answers with the JSON error
 * shape the frontend already expects: { error: string }.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const status = typeof (err as any).status === 'number' ? (err as any).status : 500;
  const log = (req.log ?? logger).child({ requestId: req.id });
  log.error(
    {
      err: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
      method: req.method,
      url: req.url,
      status,
    },
    status >= 500 ? 'Unhandled route error' : 'Request failed',
  );
  if (res.headersSent) return;
  res.status(status).json({ error: err.message || 'Internal server error' });
}

/** JSON 404 for unknown /api paths (default Express HTML is useless to the SPA). */
export function notFoundHandler(req: Request, res: Response): void {
  if (req.url.startsWith('/api')) {
    (req.log ?? logger).warn({ url: req.url }, 'Unknown API route');
    res.status(404).json({ error: `Not found: ${req.method} ${req.url}` });
    return;
  }
  res.status(404).json({ error: 'Not found' });
}
