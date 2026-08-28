import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { createDhanClient } from './auth';
import { initDatabase } from './db';
import { marketRoutes } from './routes/market';
import { portfolioRoutes } from './routes/portfolio';
import { ollamaRoutes } from './routes/ollama';
import { MarketStreamManager } from './ws/marketStream';

dotenv.config();

const PORT = Number(process.env.PORT) || 3003;

async function main() {
  console.log('=================================================');
  console.log('Starting Axis Nexus API Server');
  console.log(`Mode: ${process.env.TRADING_MODE || 'paper'}`);
  console.log(`Port: ${PORT}`);
  console.log('=================================================');

  await initDatabase();
  const client = await createDhanClient();
  const app = express();

  app.use(cors());
  app.use(express.json());

  const streamManager = new MarketStreamManager(client);

  app.use('/api/market', marketRoutes(client, streamManager));
  app.use('/api/portfolio', portfolioRoutes(client));
  app.use('/api/ollama', ollamaRoutes());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', mode: process.env.TRADING_MODE || 'paper', uptime: process.uptime() });
  });

  const server = createServer(app);

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    streamManager.subscribe(ws);

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      streamManager.unsubscribe(ws);
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
      streamManager.unsubscribe(ws);
    });
  });

  server.listen(PORT, () => {
    console.log(`[Server] HTTP + WebSocket listening on http://localhost:${PORT}`);
    console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received, shutting down...');
    wss.close();
    server.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[Server] Fatal error:', e);
  process.exit(1);
});
