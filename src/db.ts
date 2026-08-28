import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgres://nemesis@localhost:5432/dhanhq_node_development';

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS paper_wallet (
        id VARCHAR(32) PRIMARY KEY DEFAULT 'default', initial_balance NUMERIC(14, 2) NOT NULL DEFAULT 1000000.00,
        available_margin NUMERIC(14, 2) NOT NULL DEFAULT 1000000.00, used_margin NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
        realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0.00, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS paper_orders (
        id VARCHAR(64) PRIMARY KEY, correlation_id VARCHAR(64), symbol VARCHAR(64) NOT NULL,
        security_id VARCHAR(32), exchange_segment VARCHAR(32) DEFAULT 'NSE_FNO', transaction_type VARCHAR(16) NOT NULL,
        order_type VARCHAR(16) NOT NULL DEFAULT 'MARKET', product_type VARCHAR(16) NOT NULL DEFAULT 'INTRADAY',
        quantity INTEGER NOT NULL, price NUMERIC(12, 2) NOT NULL DEFAULT 0.00, trigger_price NUMERIC(12, 2) DEFAULT 0.00,
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING', filled_qty INTEGER NOT NULL DEFAULT 0,
        avg_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

      INSERT INTO paper_wallet (id, initial_balance, available_margin, used_margin, realized_pnl)
      VALUES ('default', 1000000.00, 1000000.00, 0.00, 0.00)
      ON CONFLICT (id) DO NOTHING;
    `);
    console.log('[Database] PostgreSQL paper trading tables initialized successfully.');
  } finally {
    client.release();
  }
}

export async function getOptionsAnalysisCache(symbol: string, date: string, interval: string) {
  const res = await pool.query('SELECT data FROM options_behavior_analysis WHERE id = $1', [`${symbol}_${date}_${interval}`]);
  return res.rows.length > 0 ? res.rows[0].data : null;
}

export async function saveOptionsAnalysisCache(symbol: string, date: string, interval: string, data: any) {
  const id = `${symbol}_${date}_${interval}`;
  await pool.query(
    `INSERT INTO options_behavior_analysis (id, symbol, date, interval, data, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET data = $5, created_at = NOW()`,
    [id, symbol, date, interval, JSON.stringify(data)],
  );
}

export async function listPaperStrategies() {
  const res = await pool.query('SELECT * FROM paper_strategies ORDER BY updated_at DESC');
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    symbol: r.symbol,
    type: r.strategy_type,
    status: r.status,
    lots: Number(r.lots),
    entryTime: new Date(r.entry_time).toLocaleTimeString('en-GB', { hour12: false }),
    legs: r.legs || [],
    pnl: 0,
  }));
}

export async function createPaperStrategy(s: { id?: string; name: string; symbol: string; type: string; lots: number; legs: any[] }) {
  const id = s.id || `strat_${Date.now().toString(36)}`;
  await pool.query(
    `INSERT INTO paper_strategies (id, name, symbol, strategy_type, status, lots, legs, updated_at)
     VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, NOW())`,
    [id, s.name, s.symbol, s.type, s.lots, JSON.stringify(s.legs)],
  );
  return { id, status: 'RUNNING' };
}

export async function updatePaperStrategyStatus(id: string, status: string) {
  await pool.query('UPDATE paper_strategies SET status = $2, updated_at = NOW() WHERE id = $1', [id, status]);
  return { id, status };
}

export async function deletePaperStrategy(id: string) {
  await pool.query('DELETE FROM paper_strategies WHERE id = $1', [id]);
  return { id, status: 'deleted' };
}

export async function getPaperWallet() {
  const res = await pool.query('SELECT * FROM paper_wallet WHERE id = $1', ['default']);
  if (res.rows.length === 0) {
    return { availableMargin: 1000000, usedMargin: 0, realizedPnl: 0, totalBalance: 1000000 };
  }
  const w = res.rows[0];
  const availableMargin = Number(w.available_margin);
  const usedMargin = Number(w.used_margin);
  const realizedPnl = Number(w.realized_pnl);
  return {
    availableMargin,
    usedMargin,
    realizedPnl,
    totalBalance: availableMargin + usedMargin,
    spanMargin: usedMargin * 0.7,
    exposureMargin: usedMargin * 0.3,
  };
}

export async function resetPaperWallet(initialBalance = 1000000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE paper_wallet
       SET initial_balance = $1, available_margin = $1, used_margin = 0, realized_pnl = 0, updated_at = NOW()
       WHERE id = 'default'`,
      [initialBalance],
    );
    await client.query('DELETE FROM paper_positions');
    await client.query('DELETE FROM paper_orders');
    await client.query('COMMIT');
    return { status: 'ok', initialBalance };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listPaperOrders() {
  const res = await pool.query('SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT 100');
  return res.rows.map((r) => ({
    id: r.id,
    corr: r.correlation_id,
    time: new Date(r.created_at).toLocaleTimeString('en-GB', { hour12: false }),
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
    latency: '15ms',
    createdAt: r.created_at,
  }));
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
  const client = await pool.connect();
  const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
  const fillPrice = Number(input.price || 100.0);
  const qty = Number(input.quantity);
  const sym = input.symbol.toUpperCase();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO paper_orders (id, correlation_id, symbol, security_id, exchange_segment, transaction_type, order_type, product_type, quantity, price, status, filled_qty, avg_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'TRADED', $9, $10)`,
      [orderId, input.correlationId || `corr_${orderId}`, sym, input.securityId || '0', input.exchangeSegment || 'NSE_FNO', input.transactionType, input.orderType || 'MARKET', input.productType || 'INTRADAY', qty, fillPrice],
    );

    const posRes = await client.query('SELECT * FROM paper_positions WHERE id = $1', [sym]);
    const curPos = posRes.rows[0];
    const u = input.transactionType === 'BUY' ? calculateBuyUpdate(curPos, qty, fillPrice) : calculateSellUpdate(curPos, qty, fillPrice);
    const newRealized = Number(curPos?.realized_pnl || 0) + u.realized;

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
    return { orderId, symbol: sym, side: input.transactionType, quantity: qty, fillPrice, status: 'TRADED' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closePaperPosition(symbol: string, currentLtp?: number) {
  const sym = symbol.toUpperCase();
  const posRes = await pool.query('SELECT * FROM paper_positions WHERE id = $1', [sym]);
  const pos = posRes.rows[0];
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

export async function listPaperPositions() {
  const res = await pool.query('SELECT * FROM paper_positions ORDER BY updated_at DESC');
  return res.rows.map((r) => {
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
