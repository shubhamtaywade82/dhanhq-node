import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { startCore } from './core';
import { marketRoutes } from './routes/market';
import { portfolioRoutes } from './routes/portfolio';
import { ollamaRoutes } from './routes/ollama';
import { infraRoutes } from './routes/infra';
import { controlRoutes } from './routes/control';
import { MarketStreamManager } from './ws/marketStream';
import { dbMode } from './db';
import { eventBus } from './services/eventBus';
import { journal } from './services/journal';
import { moduleLogger, logError } from './lib/logger';
import { requestLogger, errorHandler, notFoundHandler } from './lib/requestLogger';
import { attachBusLoggerBridge } from './lib/busLoggerBridge';
import { clientLogsRoutes } from './routes/clientLogs';
import { researchRoutes } from './routes/research';

dotenv.config();

const PORT = Number(process.env.PORT) || 3003;
const HOST = process.env.CONTROL_PLANE_HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.CONTROL_PLANE_ORIGIN || 'http://localhost:5175';
const CONTROL_PLANE_TOKEN = process.env.CONTROL_PLANE_TOKEN || '';
const log = moduleLogger('server');

// The autonomous trading server must NEVER crash on an async surprise —
// a crashed backend leaves live positions unmonitored.
process.on('uncaughtException', (e) => {
  log.fatal({ err: { name: e.name, message: e.message, stack: e.stack } }, 'Uncaught exception');
  eventBus.log('ERROR', `Uncaught exception: ${e.message}`, 'server');
});
process.on('unhandledRejection', (e: any) => {
  log.fatal({ err: { name: e?.name, message: e?.message || String(e), stack: e?.stack } }, 'Unhandled rejection');
  eventBus.log('ERROR', `Unhandled rejection: ${e?.message || e}`, 'server');
});

async function main() {
  log.info({ port: PORT }, 'Starting Axis Nexus Autonomous Trading Server');

  // 1. Boot the autonomous core FIRST — it must survive even if the
  //    HTTP layer fails, and it must never depend on a frontend.
  const core = await startCore();

  // 2. Mirror all EventBus telemetry (logs/alerts/orders/lifecycle) into
  //    the structured stdout log — one stream for backend + WS events.
  attachBusLoggerBridge();

  // 3. HTTP + WS control plane (frontend is an observer/controller only).
  //
  // Security posture: this is a single-operator localhost control plane, but
  // "only listens on the laptop" is not a boundary by itself — any webpage
  // open in the same browser can still have JS issue requests to it. Locking
  // CORS to the exact known origin blocks that: for JSON POSTs (order
  // placement, kill switch) the browser preflights and refuses to send the
  // real request to an origin the server didn't explicitly allow.
  //
  // A CONTROL_PLANE_TOKEN bearer check is available but NOT enforced unless
  // set — the current frontend sends no auth header, so making it mandatory
  // here would lock the operator out of their own running system. Set it and
  // wire the frontend to send it when ready to close this residual gap.
  if (!CONTROL_PLANE_TOKEN) {
    log.warn('CONTROL_PLANE_TOKEN not set — order/kill-switch endpoints are unauthenticated (CORS-origin-restricted only). Set it to require a bearer token.');
  }
  const app = express();
  const allowedOrigins = [ALLOWED_ORIGIN, 'http://localhost:5175', 'http://127.0.0.1:5175', 'http://localhost:5173', 'http://127.0.0.1:5173'];
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  }));
  app.use(express.json());
  app.use(requestLogger); // access logs + req.log child (requestId/traceId)
  app.use((req, res, next) => {
    if (!CONTROL_PLANE_TOKEN || req.path === '/api/health') return next();
    const presented = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (presented !== CONTROL_PLANE_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  const streamManager = new MarketStreamManager();
  streamManager.attach(); // bind hub to the central event bus

  app.use('/api/market', marketRoutes(core.client, core.market));
  app.use('/api/portfolio', portfolioRoutes(core.client, core.market, core.risk, core.paper, core.agent));
  app.use('/api/ollama', ollamaRoutes());
  app.use('/api/infra', infraRoutes(streamManager, { market: core.market, risk: core.risk, autonomy: core.autonomy, agent: core.agent, stream: streamManager }));
  app.use('/api/control', controlRoutes(core.client, core.risk, core.autonomy, core.agent, core.market));
  app.use('/api/client-logs', clientLogsRoutes());
  app.use('/api/research', researchRoutes(core.research));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: process.env.TRADING_MODE || 'paper',
      persistence: dbMode(),
      killed: core.risk.isKilled(),
      autonomy: core.autonomy.isEnabled(),
      marketSource: core.market.stats().source,
      uptime: process.uptime(),
    });
  });

  // Central 404 + error handling — MUST come after all routes.
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Same optional-token posture as the HTTP layer — only enforced if set.
    verifyClient: CONTROL_PLANE_TOKEN
      ? (info, cb) => {
          const url = new URL(info.req.url || '/ws', 'http://internal');
          cb(url.searchParams.get('token') === CONTROL_PLANE_TOKEN);
        }
      : undefined,
  });

  wss.on('connection', (ws) => {
    streamManager.subscribe(ws);
    ws.on('close', () => streamManager.unsubscribe(ws));
    ws.on('error', () => streamManager.unsubscribe(ws));
  });

  // Loopback-only by default — was previously bound to every interface,
  // reachable from anywhere on the local network.
  server.listen(PORT, HOST, () => {
    log.info(
      { host: HOST, port: PORT, http: `http://${HOST}:${PORT}`, ws: `ws://${HOST}:${PORT}/ws`, persistence: dbMode() },
      'Control plane listening (HTTP + WebSocket)',
    );
  });

  // Graceful shutdown — stop services cleanly, keep positions consistent.
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown initiated — stopping services cleanly');
    eventBus.log('SYSTEM', `Shutdown initiated (${signal})`, 'server');
    core.autonomy.stop();
    core.risk.stop();
    core.market.stop();
    core.selfHealing.stop();
    // Awaited: stream.end() only SCHEDULES the flush — exiting right after
    // calling it (as this function does next) can race the write and lose
    // the last entries from exactly the shutdown being journaled.
    await journal.close();
    wss.close();
    server.close();
    log.info({ signal }, 'Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  logError(log, 'Fatal error during startup', e);
  process.exit(1);
});
