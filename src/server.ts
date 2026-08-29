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
import { moduleLogger, logError } from './lib/logger';
import { requestLogger, errorHandler, notFoundHandler } from './lib/requestLogger';
import { attachBusLoggerBridge } from './lib/busLoggerBridge';
import { clientLogsRoutes } from './routes/clientLogs';

dotenv.config();

const PORT = Number(process.env.PORT) || 3003;
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
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(requestLogger); // access logs + req.log child (requestId/traceId)

  const streamManager = new MarketStreamManager();
  streamManager.attach(); // bind hub to the central event bus

  app.use('/api/market', marketRoutes(core.client, core.market));
  app.use('/api/portfolio', portfolioRoutes(core.client, core.market, core.risk));
  app.use('/api/ollama', ollamaRoutes());
  app.use('/api/infra', infraRoutes(streamManager, { market: core.market, risk: core.risk, autonomy: core.autonomy, agent: core.agent, stream: streamManager }));
  app.use('/api/control', controlRoutes(core.client, core.risk, core.autonomy, core.agent, core.market));
  app.use('/api/client-logs', clientLogsRoutes());

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
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    streamManager.subscribe(ws);
    ws.on('close', () => streamManager.unsubscribe(ws));
    ws.on('error', () => streamManager.unsubscribe(ws));
  });

  server.listen(PORT, () => {
    log.info(
      { port: PORT, http: `http://localhost:${PORT}`, ws: `ws://localhost:${PORT}/ws`, persistence: dbMode() },
      'Control plane listening (HTTP + WebSocket)',
    );
  });

  // Graceful shutdown — stop services cleanly, keep positions consistent.
  const shutdown = (signal: string) => {
    log.info({ signal }, 'Shutdown initiated — stopping services cleanly');
    eventBus.log('SYSTEM', `Shutdown initiated (${signal})`, 'server');
    core.autonomy.stop();
    core.risk.stop();
    core.market.stop();
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
