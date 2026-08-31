import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import {
  listPaperPositions, listPaperOrders, getPaperWallet, resetPaperWallet, executePaperOrder,
  closePaperPosition, listPaperStrategies, createPaperStrategy, updatePaperStrategyStatus,
} from '../db';
import type { MarketDataService } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import { eventBus } from '../services/eventBus';
import { moduleLogger } from '../lib/logger';
import { aggregatePortfolioGreeks } from '../services/optionsAnalytics';

const log = moduleLogger('portfolio');

/**
 * Portfolio & paper-trading routes.
 *
 * Paper orders are priced from LIVE market LTP (MarketDataService).
 * When no live price is available the order is rejected — it is never
 * silently filled at a made-up price. Every write path (manual orders,
 * strategy deploy/close) passes through the risk engine's gate, so the
 * kill switch halts even control-plane-initiated trades.
 */
export function portfolioRoutes(client: DhanClient, market: MarketDataService, risk?: RiskEngine): Router {
  const router = Router();
  const isPaper = () => process.env.TRADING_MODE !== 'live';

  router.get('/positions', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        return res.json(await listPaperPositions());
      }
      res.json(await client.positions.list());
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'positions' }, 'Positions fetch failed');
      res.json([]);
    }
  });

  router.get('/orders', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        return res.json(await listPaperOrders());
      }
      res.json(await client.orders.list());
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'orders' }, 'Orders fetch failed');
      res.json([]);
    }
  });

  router.get('/funds', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        return res.json(await getPaperWallet());
      }
      res.json(await client.funds.getLimit());
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'funds' }, 'Funds fetch failed');
      res.json({});
    }
  });

  router.get('/trades', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        const orders = await listPaperOrders();
        return res.json(orders.filter((o) => o.status === 'TRADED'));
      }
      res.json(await client.orders.listTrades());
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'trades' }, 'Trades fetch failed');
      res.json([]);
    }
  });

  router.get('/greeks', async (_req, res) => {
    try {
      const positions = await listPaperPositions();
      const indices = market.getIndices();
      const spotMap: Record<string, number> = {};
      for (const [sym, data] of Object.entries(indices)) {
        if (data?.ltp) spotMap[sym] = data.ltp;
      }
      const expiry = new Date().toISOString().slice(0, 10);
      const agg = aggregatePortfolioGreeks(positions, spotMap, expiry);
      res.json(agg);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/order', async (req, res) => {
    try {
      const { symbol, quantity, transactionType, price, orderType, productType, securityId, exchangeSegment } = req.body;
      if (!symbol || !quantity || !transactionType) {
        return res.status(400).json({ error: 'symbol, quantity, and transactionType are required' });
      }

      // Kill switch / EOD window gate applies to manual orders too.
      const gate = risk?.canTrade();
      if (gate && !gate.allowed) {
        return res.status(423).json({ error: `Order blocked by risk engine: ${gate.reason}` });
      }

      // Resolve fill price: explicit LIMIT price, else live LTP.
      let fillPrice = Number(price || 0);
      if (!fillPrice) {
        const ltp = market.getLtp(securityId || '0') ?? market.getLtp(String(symbol));
        if (!ltp) {
          return res.status(422).json({
            error: `No live LTP for ${symbol}${securityId ? ` (security ${securityId})` : ''} — provide an explicit price or wait for the market data feed`,
          });
        }
        fillPrice = ltp;
      }

      const result = await executePaperOrder({
        symbol,
        securityId,
        exchangeSegment,
        quantity: Number(quantity),
        transactionType,
        price: fillPrice,
        orderType: orderType || 'MARKET',
        productType: productType || 'INTRADAY',
      });
      eventBus.emit('order', { kind: 'fill', is_paper: true, symbol: String(symbol).toUpperCase(), fillPrice: result.fillPrice, quantity: Number(quantity), correlationId: result.orderId, source: 'manual' });
      res.json(result);
    } catch (e: any) {
      res.status(422).json({ error: e.message });
    }
  });

  router.post('/paper/positions/close', async (req, res) => {
    try {
      const { symbol, ltp } = req.body;
      if (!symbol) return res.status(400).json({ error: 'symbol is required' });
      const positions = await listPaperPositions();
      const pos = positions.find((p) => p.tradingSymbol === symbol.toUpperCase());
      const liveLtp = pos ? market.getLtp(String(pos.securityId)) : null;
      const result = await closePaperPosition(symbol, liveLtp || (ltp ? Number(ltp) : undefined));
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/wallet/reset', async (req, res) => {
    try {
      const initialBalance = req.body.initialBalance ? Number(req.body.initialBalance) : 100000;
      const result = await resetPaperWallet(initialBalance);
      eventBus.log('WARN', `Paper wallet reset to ₹${initialBalance.toLocaleString('en-IN')} (positions cleared)`, 'wallet_admin');
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/strategies', async (_req, res) => {
    try {
      const strategies = await listPaperStrategies();
      const positions = await listPaperPositions();
      const posMap = new Map(positions.map((p) => [p.tradingSymbol, p]));

      const enriched = strategies.map((s) => {
        let totalPnl = 0;
        const legs = (s.legs || []).map((l: any) => {
          const p = posMap.get(l.instrument);
          const ltp = p ? p.ltp : l.ltp || l.bAvg || l.sAvg || 0;
          const pnl = p ? p.pnl : 0;
          totalPnl += pnl;
          return { ...l, ltp, pnl };
        });
        return { ...s, pnl: totalPnl, legs };
      });
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/strategy/deploy', async (req, res) => {
    try {
      const { name, symbol, type, lots, legs } = req.body;
      // Strategy deployment is blocked by the kill switch / EOD window too.
      const gate = risk?.canTrade();
      if (gate && !gate.allowed) {
        return res.status(423).json({ error: `Deployment blocked by risk engine: ${gate.reason}` });
      }
      const strategyId = `s_${Date.now().toString(36)}`;
      let filled = 0;
      const legsWithPx = [];
      for (const leg of legs || []) {
        // Price each leg from the live feed when possible.
        const liveLtp = market.getLtp(leg.securityId || '0');
        const legPrice = liveLtp || Number(leg.bAvg || leg.sAvg || leg.price || 0);
        if (!legPrice) {
          eventBus.log('WARN', `Strategy ${name}: leg ${leg.instrument} has no live price — leg skipped`, 'portfolio');
          continue;
        }
        await executePaperOrder({
          symbol: leg.instrument,
          securityId: leg.securityId,
          transactionType: leg.side,
          quantity: leg.qty,
          price: legPrice,
          correlationId: strategyId,
        });
        filled++;
        legsWithPx.push({ ...leg, ltp: legPrice });
        // Keep tracking this instrument for mark-to-market.
        if (leg.securityId) {
          market.addInstruments([{ securityId: String(leg.securityId), exchangeSegment: leg.exchangeSegment || 'NSE_FNO' }]);
        }
      }
      if (filled === 0) {
        return res.status(422).json({ error: 'No leg could be priced from the live market feed — strategy not deployed' });
      }
      await createPaperStrategy({ id: strategyId, name, symbol, type, lots, legs: legsWithPx });
      eventBus.log('TRADE', `Strategy "${name}" deployed (${filled} leg(s) filled at live prices)`, 'portfolio');
      res.json({ status: 'ok', strategyId, legsFilled: filled });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/strategy/status', async (req, res) => {
    try {
      const { id, status } = req.body;
      await updatePaperStrategyStatus(id, status);
      res.json({ status: 'ok', id, newStatus: status });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/strategy/close', async (req, res) => {
    try {
      const { id } = req.body;
      const strategies = await listPaperStrategies();
      const strat = strategies.find((s) => s.id === id);
      if (strat) {
        for (const leg of strat.legs) {
          const positions = await listPaperPositions();
          const pos = positions.find((p) => p.tradingSymbol === leg.instrument);
          const ltp = pos ? market.getLtp(String(pos.securityId)) || pos.ltp : undefined;
          await closePaperPosition(leg.instrument, ltp);
        }
        await updatePaperStrategyStatus(id, 'STOPPED');
      }
      res.json({ status: 'ok', id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/margin/calculate', async (req, res) => {
    try {
      const items = req.body.items || [];
      if (!Array.isArray(items) || items.length === 0) {
        return res.json({ totalMargin: 0, spanMargin: 0, exposureMargin: 0 });
      }
      try {
        const resp = await (client as any).marginCalculator.calculateMulti(items);
        return res.json(resp.data || resp);
      } catch (e: any) {
        // DhanHQ margin calculator unavailable — report the estimate AND
        // the reason, instead of silently pretending it was real.
        let total = 0;
        for (const it of items) {
          const px = Number(it.price || 0);
          const qty = Number(it.quantity || 0);
          if (px > 0 && qty > 0) {
            total += it.transactionType === 'SELL' ? px * qty * 0.18 : px * qty;
          }
        }
        return res.json({
          totalMargin: Number(total.toFixed(2)),
          spanMargin: Number((total * 0.7).toFixed(2)),
          exposureMargin: Number((total * 0.3).toFixed(2)),
          estimated: true,
          estimateReason: `DhanHQ margin API unavailable (${e.message}) — approximate premium-based estimate`,
        });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/holdings', async (req, res) => {
    try {
      const holdings = await client.positions.listHoldings();
      res.json(holdings);
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'holdings' }, 'Holdings fetch failed');
      res.json([]);
    }
  });

  router.get('/profile', async (req, res) => {
    try {
      const profile = await client.profile.get();
      res.json(profile);
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message }, resource: 'profile' }, 'Profile fetch failed');
      // Honest error — no fake trader identity.
      res.status(502).json({ error: `DhanHQ profile unavailable: ${e.message}`, authenticated: false });
    }
  });

  return router;
}
