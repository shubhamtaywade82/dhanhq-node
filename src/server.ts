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

dotenv.config();

const PORT = Number(process.env.PORT) || 3003;

// The autonomous trading server must NEVER crash on an async surprise —
// a crashed backend leaves live positions unmonitored.
process.on('uncaughtException', (e) => {
  console.error('[Server] Uncaught exception:', e);
  eventBus.log('ERROR', `Uncaught exception: ${e.message}`, 'server');
});
process.on('unhandledRejection', (e: any) => {
  console.error('[Server] Unhandled rejection:', e);
  eventBus.log('ERROR', `Unhandled rejection: ${e?.message || e}`, 'server');
});

async function main() {
  console.log('=================================================');
  console.log('Starting Axis Nexus Autonomous Trading Server');
  console.log(`Mode: ${process.env.TRADING_MODE || 'paper'}`);
  console.log(`Port: ${PORT}`);
  console.log('=================================================');

  // 1. Boot the autonomous core FIRST — it must survive even if the
  //    HTTP layer fails, and it must never depend on a frontend.
  const core = await startCore();

  // 2. HTTP + WS control plane (frontend is an observer/controller only).
  const app = express();
  app.use(cors());
  app.use(express.json());

  const streamManager = new MarketStreamManager();
  streamManager.attach(); // bind hub to the central event bus

  app.use('/api/market', marketRoutes(core.client, core.market));
  app.use('/api/portfolio', portfolioRoutes(core.client, core.market, core.risk));
  app.use('/api/ollama', ollamaRoutes());
  app.use('/api/infra', infraRoutes(streamManager, { market: core.market, risk: core.risk, autonomy: core.autonomy, agent: core.agent, stream: streamManager }));
  app.use('/api/control', controlRoutes(core.client, core.risk, core.autonomy, core.agent, core.market));

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

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    streamManager.subscribe(ws);
    ws.on('close', () => streamManager.unsubscribe(ws));
    ws.on('error', () => streamManager.unsubscribe(ws));
  });

  server.listen(PORT, () => {
    console.log(`[Server] HTTP + WebSocket listening on http://localhost:${PORT}`);
    console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
    console.log(`[Server] Control plane: /api/control/* | Telemetry stream: /ws`);
  });

  // Graceful shutdown — stop services cleanly, keep positions consistent.
  const shutdown = (signal: string) => {
    console.log(`[Server] ${signal} received, shutting down...`);
    eventBus.log('SYSTEM', `Shutdown initiated (${signal})`, 'server');
    core.autonomy.stop();
    core.risk.stop();
    core.market.stop();
    wss.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[Server] Fatal error:', e);
  process.exit(1);
});
