import { Router } from 'express';
import { pool, dbMode } from '../db';
import { redisPublisher, redisAvailable } from '../auth';
import type { MarketStreamManager } from '../ws/marketStream';
import type { MarketDataService } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import type { AutonomyEngine } from '../services/autonomy';
import type { AgentOrchestrator } from '../services/agent';
import { marketClock } from '../services/marketHours';

/**
 * Infrastructure stats — REAL runtime state only.
 *
 * The previous version fabricated "Sidekiq worker" rows (a Rails relic).
 * This version reports the actual Node services that make the system
 * autonomous: market data feed, risk engine, autonomy loop, agent
 * orchestrator, plus honest PostgreSQL/Redis connection state.
 */
export function infraRoutes(
  _streamManager: MarketStreamManager,
  deps: { market: MarketDataService; risk: RiskEngine; autonomy: AutonomyEngine; agent: AgentOrchestrator; stream: MarketStreamManager },
): Router {
  const router = Router();

  router.get('/stats', async (_req, res) => {
    try {
      const [nodeStats, redisStats, pgStats, servicesStats] = await Promise.all([
        getNodeStats(),
        getRedisStats(),
        getPgStats(),
        getServicesStats(deps),
      ]);

      res.json({
        timestamp: new Date().toISOString(),
        clock: marketClock(),
        node: nodeStats,
        redis: redisStats,
        postgres: pgStats,
        services: servicesStats,
        // Back-compat aliases for older UI builds:
        workers: servicesStats,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

function getNodeStats() {
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor(process.uptime());
  return {
    uptimeSec,
    uptimeFormatted: formatUptime(uptimeSec),
    nodeVersion: process.version,
    pid: process.pid,
    platform: process.platform,
    heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
    heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
    rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
    externalMb: Number((mem.external / 1024 / 1024).toFixed(2)),
  };
}

async function getRedisStats() {
  if (!redisAvailable()) {
    return { status: 'DISCONNECTED', error: 'Redis unreachable (optional component)', latencyMs: -1 };
  }
  const t0 = Date.now();
  try {
    await redisPublisher.ping();
    const latencyMs = Date.now() - t0;
    const rawInfo = await redisPublisher.info();
    const parsed = parseRedisInfo(String(rawInfo));
    const tokenTtl = await redisPublisher.ttl('dhan:auth:access_token').catch(() => -2);
    const keys = await redisPublisher.keys('dhan:*').catch(() => []);

    return {
      status: 'CONNECTED',
      latencyMs,
      usedMemory: parsed['used_memory_human'] || '0B',
      connectedClients: Number(parsed['connected_clients'] || 1),
      totalCommands: Number(parsed['total_commands_processed'] || 0),
      uptimeDays: Number(parsed['uptime_in_days'] || 0),
      role: parsed['role'] || 'standalone',
      cachedKeys: keys,
      tokenTtlSec: Math.max(0, tokenTtl),
      tokenExpiryFormatted: tokenTtl > 0 ? formatUptime(tokenTtl) : 'Expired / Not Set',
    };
  } catch (e: any) {
    return { status: 'DISCONNECTED', error: e.message, latencyMs: -1 };
  }
}

async function getPgStats() {
  if (dbMode() === 'memory') {
    return {
      status: 'DISCONNECTED',
      error: 'PostgreSQL unreachable — running on in-memory paper state',
      latencyMs: -1,
      mode: 'memory',
    };
  }
  const t0 = Date.now();
  try {
    const [verRes, tablesRes] = await Promise.all([
      pool.query('SELECT version();'),
      pool.query(`
        SELECT relname as name, n_live_tup as count, pg_size_pretty(pg_total_relation_size(relid)) as size
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC;
      `),
    ]);
    const latencyMs = Date.now() - t0;

    return {
      status: 'CONNECTED',
      latencyMs,
      mode: 'postgres',
      version: verRes.rows[0]?.version?.split(' ')?.[1] || '16.x',
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: 10,
      },
      tables: tablesRes.rows.map((r: any) => ({
        name: r.name,
        rows: Number(r.count || 0),
        size: r.size || '0 kB',
      })),
    };
  } catch (e: any) {
    return { status: 'DISCONNECTED', error: e.message, latencyMs: -1, mode: 'memory' };
  }
}

/**
 * Real service telemetry. Each "worker" row is a live Node service with
 * its actual state — no fabricated job counts.
 */
async function getServicesStats(deps: { market: MarketDataService; risk: RiskEngine; autonomy: AutonomyEngine; agent: AgentOrchestrator; stream: MarketStreamManager }) {
  const market = deps.market.stats();
  const risk = deps.risk.snapshot();
  const autonomy = deps.autonomy.stats();
  const agent = deps.agent.status();
  const stream = deps.stream.stats();
  const uptime = Math.floor(process.uptime());

  const services = [
    {
      jid: 'svc_market_data', name: 'MarketDataService', queue: market.wsConnected ? 'ws' : 'rest',
      started: 'boot', args: `source=${market.source} instruments=${market.trackedInstruments} tickAge=${market.tickAgeSec ?? '∞'}s`,
      elapsed: formatUptime(uptime),
      detail: market,
    },
    {
      jid: 'svc_risk_engine', name: 'RiskEngine', queue: risk.killed ? 'KILLED' : 'armed',
      started: 'boot', args: `breakers=${risk.breakers?.filter((b) => b.state !== 'OK').length || 0} tripped`,
      elapsed: formatUptime(uptime),
      detail: { killed: risk.killed, killedReason: risk.killedReason },
    },
    {
      jid: 'svc_autonomy', name: 'AutonomyEngine', queue: autonomy.enabled ? 'running' : 'paused',
      started: 'boot', args: `cycles=${autonomy.cycles} last=${autonomy.lastCycleAgoSec ?? '∞'}s ago eod=${autonomy.eodDone}`,
      elapsed: formatUptime(uptime),
      detail: { clock: autonomy.clock },
    },
    {
      jid: 'svc_agent', name: 'AgentOrchestrator', queue: agent.llm,
      started: 'boot', args: `running=${agent.running} steps=${agent.steps} tools=${agent.toolCalls}`,
      elapsed: formatUptime(uptime),
      detail: agent,
    },
    {
      jid: 'svc_ws_hub', name: 'WebSocketHub', queue: `${stream.clients} client(s)`,
      started: 'boot', args: `channels=${stream.channels.join(',')}`,
      elapsed: formatUptime(uptime),
      detail: stream,
    },
  ];

  return {
    processedJobs: autonomy.cycles + agent.steps,
    failedJobs: risk.killed ? 1 : 0,
    activeWorkersCount: services.length,
    concurrencyLimit: 10,
    activeWorkers: services,
    retrySet: [],
  };
}

function parseRedisInfo(info: string): Record<string, string> {
  const res: Record<string, string> = {};
  for (const line of info.split('\r\n')) {
    if (!line || line.startsWith('#')) continue;
    const [k, v] = line.split(':');
    if (k && v) res[k.trim()] = v.trim();
  }
  return res;
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
