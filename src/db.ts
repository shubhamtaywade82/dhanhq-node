import { Pool } from 'pg';
import { moduleLogger } from './lib/logger';

const log = moduleLogger('db');

/**
 * Paper-trading persistence layer.
 *
 * Primary mode: PostgreSQL (paper_wallet / paper_orders / paper_positions /
 * paper_strategies / options_behavior_analysis + new operational tables).
 *
 * Fallback mode: when PostgreSQL is unreachable the layer degrades to an
 * in-memory store with the identical function surface so the autonomous
 * backend still runs (state is simply not durable across restarts). The
 * active mode is exposed via `dbMode()` and reported by /api/health.
 */

const connectionString = process.env.DATABASE_URL || 'postgres://nemesis@localhost:5432/dhanhq_node_development';

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

let mode: 'postgres' | 'memory' = 'postgres';
export function dbMode(): 'postgres' | 'memory' {
  return mode;
}

// ── in-memory fallback store ────────────────────────────────────────────
const mem = {
  wallet: { id: 'default', initial_balance: 100000, available_margin: 100000, used_margin: 0, realized_pnl: 0, updated_at: new Date() },
  orders: [] as any[],
  positions: new Map<string, any>(),
  strategies: [] as any[],
  optionsCache: new Map<string, any>(),
  alerts: [] as any[],
  agentEvents: [] as any[],
  riskState: null as any,
  errorPatterns: new Map<string, any>(),
  systemRules: [] as any[],
  autoid: 0,
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS paper_wallet (
    id VARCHAR(32) PRIMARY KEY DEFAULT 'default', initial_balance NUMERIC(14, 2) NOT NULL DEFAULT 100000.00,
    available_margin NUMERIC(14, 2) NOT NULL DEFAULT 100000.00, used_margin NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS paper_orders (
    id VARCHAR(64) PRIMARY KEY, correlation_id VARCHAR(64), symbol VARCHAR(64) NOT NULL,
    security_id VARCHAR(32), exchange_segment VARCHAR(32) DEFAULT 'NSE_FNO', transaction_type VARCHAR(16) NOT NULL,
    order_type VARCHAR(16) NOT NULL DEFAULT 'MARKET', product_type VARCHAR(16) NOT NULL DEFAULT 'INTRADAY',
    quantity INTEGER NOT NULL, price NUMERIC(12, 2) NOT NULL DEFAULT 0.00, trigger_price NUMERIC(12, 2) DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', filled_qty INTEGER NOT NULL DEFAULT 0,
    avg_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00, latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS paper_positions (
    id VARCHAR(64) PRIMARY KEY, symbol VARCHAR(64) NOT NULL, security_id VARCHAR(32),
    exchange_segment VARCHAR(32) DEFAULT 'NSE_FNO', product_type VARCHAR(16) DEFAULT 'INTRADAY',
    buy_qty INTEGER NOT NULL DEFAULT 0, buy_avg NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    sell_qty INTEGER NOT NULL DEFAULT 0, sell_avg NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    net_qty INTEGER NOT NULL DEFAULT 0, realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    unrealized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00, ltp NUMERIC(12, 2) NOT NULL DEFAULT 0.00, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS paper_strategies (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(128) NOT NULL, symbol VARCHAR(32) NOT NULL,
    strategy_type VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
    lots INTEGER NOT NULL DEFAULT 1, entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    legs JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS options_behavior_analysis (
    id VARCHAR(64) PRIMARY KEY, symbol VARCHAR(32) NOT NULL, date VARCHAR(16) NOT NULL,
    interval VARCHAR(16) NOT NULL DEFAULT '1', data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY, level VARCHAR(16) NOT NULL DEFAULT 'INFO',
    source VARCHAR(64) NOT NULL DEFAULT 'system', message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS agent_events (
    id SERIAL PRIMARY KEY, run_id VARCHAR(64) NOT NULL, agent VARCHAR(32) NOT NULL,
    type VARCHAR(24) NOT NULL, summary TEXT, tool VARCHAR(64), response TEXT,
    duration_ms INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS risk_state (
    id VARCHAR(16) PRIMARY KEY DEFAULT 'default', killed BOOLEAN NOT NULL DEFAULT FALSE,
    killed_reason TEXT, limits JSONB NOT NULL DEFAULT '{}',
    consecutive_losses INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS error_patterns (
    pattern TEXT PRIMARY KEY, level VARCHAR(16) NOT NULL, source VARCHAR(64) NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 1, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS system_rules (
    id SERIAL PRIMARY KEY, rule TEXT NOT NULL, pattern TEXT NOT NULL UNIQUE,
    hit_count INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO paper_wallet (id, initial_balance, available_margin, used_margin, realized_pnl)
  VALUES ('default', 100000.00, 100000.00, 0.00, 0.00)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO risk_state (id, killed, limits) VALUES ('default', FALSE, '{}')
  ON CONFLICT (id) DO NOTHING;
  ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
  ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00;
`;

export async function initDatabase(): Promise<void> {
  const client = await pool.connect().catch(() => null);
  if (!client) {
    mode = 'memory';
    log.warn('PostgreSQL unreachable — running with in-memory paper trading state (not durable)');
    return;
  }
  try {
    await client.query(SCHEMA_SQL);
    mode = 'postgres';
    log.info('PostgreSQL paper trading tables initialized');
  } catch (e: any) {
    mode = 'memory';
    log.warn({ err: { message: e.message } }, 'Schema init failed — falling back to in-memory mode');
  } finally {
    client.release();
  }
}

// ── alerts ──────────────────────────────────────────────────────────────
export async function pushAlert(level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string) {
  if (mode === 'postgres') {
    try {
      await pool.query('INSERT INTO alerts (level, source, message) VALUES ($1, $2, $3)', [level, source, message]);
    } catch { /* non-fatal */ }
  } else {
    mem.alerts.unshift({ id: ++mem.autoid, level, source, message, created_at: new Date() });
    if (mem.alerts.length > 200) mem.alerts.pop();
  }
}

export async function listAlerts(limit = 100) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows.map(mapAlertRow);
    } catch { return []; }
  }
  return mem.alerts.slice(0, limit).map(mapAlertRow);
}

function mapAlertRow(r: any) {
  return {
    id: Number(r.id), time: new Date(r.created_at).toLocaleTimeString('en-GB', { hour12: false }),
    level: r.level, source: r.source, msg: r.message, read: false, createdAt: r.created_at,
  };
}

// ── self-healing: error patterns + promoted rules ─────────────────────────
export async function recordErrorPattern(level: 'WARN' | 'ERROR', source: string, pattern: string) {
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO error_patterns (pattern, level, source) VALUES ($1, $2, $3)
         ON CONFLICT (pattern) DO UPDATE SET hit_count = error_patterns.hit_count + 1, last_seen = NOW()`,
        [pattern, level, source],
      );
    } catch { /* non-fatal */ }
  } else {
    const existing = mem.errorPatterns.get(pattern);
    if (existing) { existing.hit_count++; existing.last_seen = new Date(); }
    else mem.errorPatterns.set(pattern, { pattern, level, source, hit_count: 1, first_seen: new Date(), last_seen: new Date() });
  }
}

export async function listErrorPatterns(minHits = 2) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM error_patterns WHERE hit_count >= $1 ORDER BY hit_count DESC', [minHits]);
      return res.rows;
    } catch { return []; }
  }
  return [...mem.errorPatterns.values()].filter((p) => p.hit_count >= minHits);
}

export async function ruleExistsForPattern(pattern: string): Promise<boolean> {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT 1 FROM system_rules WHERE pattern = $1 LIMIT 1', [pattern]);
      return (res.rowCount ?? 0) > 0;
    } catch { return false; }
  }
  return mem.systemRules.some((r) => r.pattern === pattern);
}

export async function promoteRule(rule: string, pattern: string, hitCount: number) {
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO system_rules (rule, pattern, hit_count) VALUES ($1, $2, $3)
         ON CONFLICT (pattern) DO UPDATE SET rule = $1, hit_count = $3`,
        [rule, pattern, hitCount],
      );
    } catch { /* non-fatal */ }
  } else {
    mem.systemRules.unshift({ id: ++mem.autoid, rule, pattern, hit_count: hitCount, active: true, created_at: new Date() });
  }
}

export async function getActiveRules(limit = 20) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT rule FROM system_rules WHERE active = TRUE ORDER BY hit_count DESC LIMIT $1', [limit]);
      return res.rows.map((r) => r.rule as string);
    } catch { return []; }
  }
  return mem.systemRules.filter((r) => r.active).slice(0, limit).map((r) => r.rule as string);
}

// ── agent events ────────────────────────────────────────────────────────
export async function pushAgentEvent(ev: { run_id: string; agent: string; type: string; summary?: string; tool?: string; response?: string; duration_ms?: number }) {
  if (mode === 'postgres') {
    try {
      await pool.query(
        'INSERT INTO agent_events (run_id, agent, type, summary, tool, response, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [ev.run_id, ev.agent, ev.type, ev.summary ?? null, ev.tool ?? null, ev.response ?? null, ev.duration_ms ?? null],
      );
    } catch { /* non-fatal */ }
  } else {
    mem.agentEvents.unshift({ id: ++mem.autoid, ...ev, created_at: new Date() });
    if (mem.agentEvents.length > 400) mem.agentEvents.pop();
  }
}

export async function listAgentEvents(limit = 100) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM agent_events ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows.map(mapAgentEventRow);
    } catch { return []; }
  }
  return mem.agentEvents.slice(0, limit).map(mapAgentEventRow);
}

function mapAgentEventRow(r: any) {
  return {
    id: `aev_${r.id}`, runId: r.run_id, agent: r.agent, type: r.type,
    summary: r.summary, tool: r.tool, response: r.response,
    duration: r.duration_ms ?? undefined,
    time: new Date(r.created_at).toLocaleTimeString('en-GB', { hour12: false }),
  };
}

// ── risk state ──────────────────────────────────────────────────────────
export async function getRiskState() {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT * FROM risk_state WHERE id = $1', ['default']);
      if (res.rows.length) return { killed: res.rows[0].killed, killedReason: res.rows[0].killed_reason, limits: res.rows[0].limits || {}, consecutiveLosses: Number(res.rows[0].consecutive_losses || 0) };
    } catch { /* fall through */ }
  }
  return mem.riskState || { killed: false, killedReason: null, limits: {}, consecutiveLosses: 0 };
}

export async function saveRiskState(state: { killed: boolean; killedReason?: string | null; limits?: any; consecutiveLosses?: number }) {
  const current = mem.riskState || { killed: false, killedReason: null, limits: {}, consecutiveLosses: 0 };
  const merged = {
    killed: state.killed,
    killedReason: state.killedReason ?? null,
    limits: state.limits ?? current.limits ?? {},
    consecutiveLosses: state.consecutiveLosses ?? current.consecutiveLosses ?? 0,
  };
  // Mirror synchronously FIRST — readers (incl. a RiskEngine booting in the
  // same tick) must never observe stale state while PG persistence runs.
  mem.riskState = merged;
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO risk_state (id, killed, killed_reason, limits, consecutive_losses)
         VALUES ('default', $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET killed = $1, killed_reason = $2, limits = $3, consecutive_losses = $4, updated_at = NOW()`,
        [merged.killed, merged.killedReason, JSON.stringify(merged.limits), merged.consecutiveLosses],
      );
    } catch { /* non-fatal */ }
  }
  return merged;
}

// ── options analysis cache ──────────────────────────────────────────────
export async function getOptionsAnalysisCache(symbol: string, date: string, interval: string) {
  if (mode === 'postgres') {
    try {
      const res = await pool.query('SELECT data FROM options_behavior_analysis WHERE id = $1', [`${symbol}_${date}_${interval}`]);
      return res.rows.length > 0 ? res.rows[0].data : null;
    } catch { return null; }
  }
  return mem.optionsCache.get(`${symbol}_${date}_${interval}`) || null;
}

export async function saveOptionsAnalysisCache(symbol: string, date: string, interval: string, data: any) {
  const id = `${symbol}_${date}_${interval}`;
  if (mode === 'postgres') {
    try {
      await pool.query(
        `INSERT INTO options_behavior_analysis (id, symbol, date, interval, data, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $5, created_at = NOW()`,
        [id, symbol, date, interval, JSON.stringify(data)],
      );
    } catch { /* non-fatal */ }
  } else {
    mem.optionsCache.set(id, data);
  }
}

// ── strategies ──────────────────────────────────────────────────────────
export async function listPaperStrategies() {
  const rows = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_strategies ORDER BY updated_at DESC').catch(() => ({ rows: [] }))).rows
    : [...mem.strategies].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return rows.map((r: any) => ({
    id: r.id, name: r.name, symbol: r.symbol, type: r.strategy_type, status: r.status,
    lots: Number(r.lots),
    entryTime: new Date(r.entry_time).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
    legs: r.legs || [], pnl: 0,
  }));
}

export async function createPaperStrategy(s: { id?: string; name: string; symbol: string; type: string; lots: number; legs: any[] }) {
  const id = s.id || `strat_${Date.now().toString(36)}`;
  if (mode === 'postgres') {
    await pool.query(
      `INSERT INTO paper_strategies (id, name, symbol, strategy_type, status, lots, legs, updated_at)
       VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, NOW())`,
      [id, s.name, s.symbol, s.type, s.lots, JSON.stringify(s.legs)],
    );
  } else {
    mem.strategies.unshift({ id, name: s.name, symbol: s.symbol, strategy_type: s.type, status: 'RUNNING', lots: s.lots, legs: s.legs, entry_time: new Date(), updated_at: new Date() });
  }
  return { id, status: 'RUNNING' };
}

export async function updatePaperStrategyStatus(id: string, status: string) {
  if (mode === 'postgres') {
    await pool.query('UPDATE paper_strategies SET status = $2, updated_at = NOW() WHERE id = $1', [id, status]);
  } else {
    const s = mem.strategies.find((x) => x.id === id);
    if (s) { s.status = status; s.updated_at = new Date(); }
  }
  return { id, status };
}

export async function deletePaperStrategy(id: string) {
  if (mode === 'postgres') {
    await pool.query('DELETE FROM paper_strategies WHERE id = $1', [id]);
  } else {
    mem.strategies = mem.strategies.filter((x) => x.id !== id);
  }
  return { id, status: 'deleted' };
}

// ── wallet ──────────────────────────────────────────────────────────────
export async function getPaperWallet() {
  const w = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_wallet WHERE id = $1', ['default']).catch(() => ({ rows: [] }))).rows[0]
    : (mem.wallet as any);
  if (!w) {
    return { availableMargin: 100000, usedMargin: 0, realizedPnl: 0, totalBalance: 100000, spanMargin: 0, exposureMargin: 0 };
  }
  const availableMargin = Number(w.available_margin);
  const usedMargin = Number(w.used_margin);
  const realizedPnl = Number(w.realized_pnl);
  return {
    availableMargin, usedMargin, realizedPnl,
    totalBalance: availableMargin + usedMargin,
    spanMargin: Number((usedMargin * 0.7).toFixed(2)),
    exposureMargin: Number((usedMargin * 0.3).toFixed(2)),
  };
}

export async function resetPaperWallet(initialBalance = 100000) {
  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE paper_wallet SET initial_balance = $1, available_margin = $1, used_margin = 0, realized_pnl = 0, updated_at = NOW() WHERE id = 'default'`,
        [initialBalance],
      );
      await client.query('DELETE FROM paper_positions');
      await client.query('DELETE FROM paper_orders');
      await client.query('DELETE FROM paper_strategies');
      await client.query('DELETE FROM alerts');
      await client.query('DELETE FROM agent_events');
      await client.query(`UPDATE risk_state SET killed = FALSE, killed_reason = NULL, limits = '{}', consecutive_losses = 0, updated_at = NOW() WHERE id = 'default'`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    mem.wallet = { ...mem.wallet, initial_balance: initialBalance, available_margin: initialBalance, used_margin: 0, realized_pnl: 0, updated_at: new Date() };
    mem.orders = [];
    mem.positions.clear();
    mem.strategies = [];
    mem.alerts = [];
    mem.agentEvents = [];
    mem.riskState = { killed: false, killedReason: null, limits: {}, consecutiveLosses: 0 };
  }
  return { status: 'ok', initialBalance };
}

// ── orders ──────────────────────────────────────────────────────────────
export async function listPaperOrders() {
  const rows = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT 100').catch(() => ({ rows: [] }))).rows
    : [...mem.orders].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 100);
  return rows.map((r: any) => ({
    id: r.id,
    corr: r.correlation_id,
    time: new Date(r.created_at).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
    instrument: r.symbol,
    type: r.order_type,
    side: r.transaction_type,
    qty: Number(r.quantity),
    price: Number(r.price),
    filled: Number(r.filled_qty),
    avg: Number(r.avg_price),
    leg: 'ENTRY_LEG',
    status: r.status,
    jid: r.correlation_id || r.id,
    latency: r.latency_ms != null ? `${r.latency_ms}ms` : '—',
    createdAt: r.created_at,
  }));
}

export async function getTodayOrderStats() {
  const rows = mode === 'postgres'
    ? (await pool.query(`SELECT * FROM paper_orders WHERE created_at >= CURRENT_DATE ORDER BY created_at ASC`).catch(() => ({ rows: [] }))).rows
    : mem.orders.filter((o: any) => new Date(o.created_at).toDateString() === new Date().toDateString());
  let consecutiveLosses = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const realized = Number(rows[i].realized_pnl || 0);
    if (realized < 0) consecutiveLosses++;
    else break;
  }
  return {
    total: rows.length,
    filled: rows.filter((r: any) => r.status === 'TRADED').length,
    rejected: rows.filter((r: any) => r.status === 'REJECTED').length,
    consecutiveLosses,
  };
}

export interface PaperOrderInput {
  symbol: string;
  securityId?: string;
  exchangeSegment?: string;
  transactionType: 'BUY' | 'SELL';
  orderType?: 'MARKET' | 'LIMIT';
  productType?: 'INTRADAY' | 'MARGIN' | 'CNC';
  quantity: number;
  price?: number;
  correlationId?: string;
  realizedPnl?: number;
}

function calculateBuyUpdate(pos: any, qty: number, price: number) {
  const curNet = Number(pos?.net_qty || 0);
  const curBuyQty = Number(pos?.buy_qty || 0);
  const curBuyAvg = Number(pos?.buy_avg || 0);
  const curSellAvg = Number(pos?.sell_avg || 0);

  if (curNet >= 0) {
    const newQty = curBuyQty + qty;
    const newAvg = (curBuyAvg * curBuyQty + price * qty) / newQty;
    return { buyQty: newQty, buyAvg: newAvg, sellQty: Number(pos?.sell_qty || 0), sellAvg: curSellAvg, netQty: curNet + qty, realized: 0 };
  }
  const closeQty = Math.min(Math.abs(curNet), qty);
  const realized = (curSellAvg - price) * closeQty;
  const remQty = qty - closeQty;
  const newBuyQty = curBuyQty + remQty;
  const newBuyAvg = remQty > 0 ? price : curBuyAvg;
  return { buyQty: newBuyQty, buyAvg: newBuyAvg, sellQty: Number(pos?.sell_qty || 0), sellAvg: curSellAvg, netQty: curNet + qty, realized };
}

function calculateSellUpdate(pos: any, qty: number, price: number) {
  const curNet = Number(pos?.net_qty || 0);
  const curSellQty = Number(pos?.sell_qty || 0);
  const curBuyAvg = Number(pos?.buy_avg || 0);
  const curSellAvg = Number(pos?.sell_avg || 0);

  if (curNet <= 0) {
    const newQty = curSellQty + qty;
    const newAvg = (curSellAvg * curSellQty + price * qty) / newQty;
    return { buyQty: Number(pos?.buy_qty || 0), buyAvg: curBuyAvg, sellQty: newQty, sellAvg: newAvg, netQty: curNet - qty, realized: 0 };
  }
  const closeQty = Math.min(curNet, qty);
  const realized = (price - curBuyAvg) * closeQty;
  const remQty = qty - closeQty;
  const newSellQty = curSellQty + remQty;
  const newSellAvg = remQty > 0 ? price : curSellAvg;
  return { buyQty: Number(pos?.buy_qty || 0), buyAvg: curBuyAvg, sellQty: newSellQty, sellAvg: newSellAvg, netQty: curNet - qty, realized };
}

export async function executePaperOrder(input: PaperOrderInput) {
  const t0 = Date.now();
  const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
  const fillPrice = Number(input.price || 0);
  const qty = Number(input.quantity);
  const sym = input.symbol.toUpperCase();

  if (!fillPrice || fillPrice <= 0) {
    throw new Error('Fill price required — paper orders must be priced from live market LTP (pass explicit price for LIMIT orders)');
  }

  const latencyMs = Math.max(1, Date.now() - t0 + Math.floor(Math.random() * 20));

  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Read position FIRST so the order row can carry its realized PnL
      // (used by the risk engine's consecutive-loss breaker).
      const posRes = await client.query('SELECT * FROM paper_positions WHERE id = $1', [sym]);
      const curPos = posRes.rows[0];
      const u = input.transactionType === 'BUY' ? calculateBuyUpdate(curPos, qty, fillPrice) : calculateSellUpdate(curPos, qty, fillPrice);
      const newRealized = Number(curPos?.realized_pnl || 0) + u.realized;

      await client.query(
        `INSERT INTO paper_orders (id, correlation_id, symbol, security_id, exchange_segment, transaction_type, order_type, product_type, quantity, price, status, filled_qty, avg_price, latency_ms, realized_pnl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'TRADED', $9, $10, $11, $12)`,
        [orderId, input.correlationId || `corr_${orderId}`, sym, input.securityId || '0', input.exchangeSegment || 'NSE_FNO', input.transactionType, input.orderType || 'MARKET', input.productType || 'INTRADAY', qty, fillPrice, latencyMs, u.realized],
      );

      await client.query(
        `INSERT INTO paper_positions (id, symbol, security_id, exchange_segment, product_type, buy_qty, buy_avg, sell_qty, sell_avg, net_qty, realized_pnl, ltp, updated_at)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (id) DO UPDATE SET buy_qty = $5, buy_avg = $6, sell_qty = $7, sell_avg = $8, net_qty = $9, realized_pnl = $10, ltp = $11, updated_at = NOW()`,
        [sym, input.securityId || '0', input.exchangeSegment || 'NSE_FNO', input.productType || 'INTRADAY', u.buyQty, u.buyAvg, u.sellQty, u.sellAvg, u.netQty, newRealized, fillPrice],
      );

      const marginReq = u.netQty !== 0 ? Math.abs(u.netQty) * fillPrice * 0.15 : 0;
      await client.query(
        `UPDATE paper_wallet SET realized_pnl = realized_pnl + $1, available_margin = available_margin + $1 - $2, used_margin = used_margin + $2, updated_at = NOW() WHERE id = 'default'`,
        [u.realized, marginReq],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    // Position first (same reason as PG branch), then order row.
    const curPos = mem.positions.get(sym);
    const u = input.transactionType === 'BUY' ? calculateBuyUpdate(curPos, qty, fillPrice) : calculateSellUpdate(curPos, qty, fillPrice);

    mem.orders.unshift({
      id: orderId, correlation_id: input.correlationId || `corr_${orderId}`, symbol: sym,
      security_id: input.securityId || '0', exchange_segment: input.exchangeSegment || 'NSE_FNO',
      transaction_type: input.transactionType, order_type: input.orderType || 'MARKET',
      product_type: input.productType || 'INTRADAY', quantity: qty, price: fillPrice,
      status: 'TRADED', filled_qty: qty, avg_price: fillPrice, latency_ms: latencyMs,
      realized_pnl: u.realized, created_at: new Date(), updated_at: new Date(),
    });
    if (mem.orders.length > 500) mem.orders.pop();

    mem.positions.set(sym, {
      id: sym, symbol: sym, security_id: input.securityId || '0', exchange_segment: input.exchangeSegment || 'NSE_FNO',
      product_type: input.productType || 'INTRADAY', buy_qty: u.buyQty, buy_avg: u.buyAvg,
      sell_qty: u.sellQty, sell_avg: u.sellAvg, net_qty: u.netQty,
      realized_pnl: Number(curPos?.realized_pnl || 0) + u.realized, ltp: fillPrice, updated_at: new Date(),
    });
    const marginReq = u.netQty !== 0 ? Math.abs(u.netQty) * fillPrice * 0.15 : 0;
    mem.wallet.realized_pnl = Number(mem.wallet.realized_pnl) + u.realized;
    mem.wallet.available_margin = Number(mem.wallet.available_margin) + u.realized - marginReq;
    mem.wallet.used_margin = Number(mem.wallet.used_margin) + marginReq;
  }

  return { orderId, symbol: sym, side: input.transactionType, quantity: qty, fillPrice, status: 'TRADED', latencyMs };
}

export async function closePaperPosition(symbol: string, currentLtp?: number) {
  const sym = symbol.toUpperCase();
  const pos = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_positions WHERE id = $1', [sym]).catch(() => ({ rows: [] }))).rows[0]
    : mem.positions.get(sym);
  if (!pos || Number(pos.net_qty) === 0) return { status: 'noop', message: 'No open position found' };
  const netQty = Number(pos.net_qty);
  return executePaperOrder({
    symbol: sym,
    securityId: pos.security_id,
    exchangeSegment: pos.exchange_segment,
    transactionType: netQty > 0 ? 'SELL' : 'BUY',
    orderType: 'MARKET',
    productType: pos.product_type,
    quantity: Math.abs(netQty),
    price: currentLtp || Number(pos.ltp || (netQty > 0 ? pos.buy_avg : pos.sell_avg)),
    correlationId: `close_${sym}_${Date.now()}`,
  });
}

/** Mark open positions to market — called by the autonomy loop from live ticks. */
export async function markPositionsToMarket(ltpResolver: (securityId: string, symbol: string) => number | null): Promise<number> {
  const rows = mode === 'postgres'
    ? (await pool.query(`SELECT * FROM paper_positions WHERE net_qty <> 0`).catch(() => ({ rows: [] }))).rows
    : [...mem.positions.values()].filter((p: any) => Number(p.net_qty) !== 0);

  let totalUnrealized = 0;
  for (const pos of rows) {
    const ltp = ltpResolver(pos.security_id, pos.symbol);
    if (ltp == null) {
      // keep last known ltp
      const netQty = Number(pos.net_qty);
      const cost = netQty > 0 ? Number(pos.buy_avg) : Number(pos.sell_avg);
      const lastLtp = Number(pos.ltp || cost);
      totalUnrealized += netQty > 0 ? (lastLtp - cost) * netQty : (Number(pos.sell_avg) - lastLtp) * Math.abs(netQty);
      continue;
    }
    const netQty = Number(pos.net_qty);
    const buyAvg = Number(pos.buy_avg), sellAvg = Number(pos.sell_avg);
    const cost = netQty > 0 ? buyAvg : sellAvg;
    const unrealized = netQty > 0 ? (ltp - buyAvg) * netQty : (sellAvg - ltp) * Math.abs(netQty);
    totalUnrealized += unrealized;

    if (mode === 'postgres') {
      await pool.query('UPDATE paper_positions SET ltp = $2, unrealized_pnl = $3, updated_at = NOW() WHERE id = $1', [pos.id, ltp, unrealized]).catch(() => {});
    } else {
      pos.ltp = ltp;
      pos.unrealized_pnl = unrealized;
      pos.updated_at = new Date();
    }
  }
  return totalUnrealized;
}

export async function listPaperPositions() {
  const rows = mode === 'postgres'
    ? (await pool.query('SELECT * FROM paper_positions ORDER BY updated_at DESC').catch(() => ({ rows: [] }))).rows
    : [...mem.positions.values()];
  return rows.map((r: any) => {
    const netQty = Number(r.net_qty), buyAvg = Number(r.buy_avg), sellAvg = Number(r.sell_avg);
    const cost = netQty >= 0 ? buyAvg : sellAvg, ltp = Number(r.ltp || cost);
    const unrealized = netQty !== 0 ? (netQty > 0 ? (ltp - buyAvg) * netQty : (sellAvg - ltp) * Math.abs(netQty)) : 0;
    const realized = Number(r.realized_pnl);
    return {
      id: r.id, tradingSymbol: r.symbol, securityId: r.security_id, exchangeSegment: r.exchange_segment,
      productType: r.product_type, buyQty: Number(r.buy_qty), buyAvg, sellQty: Number(r.sell_qty), sellAvg,
      netQty, realizedProfit: realized, unrealizedProfit: unrealized, rnl: realized, unrealizedPnl: unrealized,
      pnl: realized + unrealized, costPrice: cost, ltp, positionType: r.product_type, crossCurrency: false,
    };
  });
}

export async function closeAllPaperPositions(ltpResolver: (securityId: string, symbol: string) => number | null) {
  const results = [];
  for (const p of await listPaperPositions()) {
    if (p.netQty === 0) continue;
    const ltp = ltpResolver(String(p.securityId), p.tradingSymbol) || p.ltp;
    results.push(await closePaperPosition(p.tradingSymbol, ltp));
  }
  return results;
}
