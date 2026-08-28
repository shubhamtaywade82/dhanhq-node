import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { listPaperPositions, listPaperOrders, getPaperWallet, resetPaperWallet, executePaperOrder, closePaperPosition, listPaperStrategies, createPaperStrategy, updatePaperStrategyStatus } from '../db';

export function portfolioRoutes(client: DhanClient): Router {
  const router = Router();
  const isPaper = () => process.env.TRADING_MODE !== 'live';

  router.get('/positions', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        const positions = await listPaperPositions();
        return res.json(positions);
      }
      const positions = await client.positions.list();
      res.json(positions);
    } catch (e: any) {
      console.warn('[Portfolio] Positions fetch failed:', e.message);
      res.json([]);
    }
  });

  router.get('/orders', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        const orders = await listPaperOrders();
        return res.json(orders);
      }
      const orders = await client.orders.list();
      res.json(orders);
    } catch (e: any) {
      console.warn('[Portfolio] Orders fetch failed:', e.message);
      res.json([]);
    }
  });

  router.get('/funds', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        const funds = await getPaperWallet();
        return res.json(funds);
      }
      const funds = await client.funds.getLimit();
      res.json(funds);
    } catch (e: any) {
      console.warn('[Portfolio] Funds fetch failed:', e.message);
      res.json({});
    }
  });

  router.get('/trades', async (req, res) => {
    try {
      if (isPaper() || req.query.mode === 'paper') {
        const orders = await listPaperOrders();
        return res.json(orders.filter((o) => o.status === 'TRADED'));
      }
      const trades = await client.orders.listTrades();
      res.json(trades);
    } catch (e: any) {
      console.warn('[Portfolio] Trades fetch failed:', e.message);
      res.json([]);
    }
  });

  router.post('/paper/order', async (req, res) => {
    try {
      const { symbol, quantity, transactionType, price, orderType, productType, securityId } = req.body;
      if (!symbol || !quantity || !transactionType) {
        return res.status(400).json({ error: 'symbol, quantity, and transactionType are required' });
      }
      const result = await executePaperOrder({
        symbol,
        quantity: Number(quantity),
        transactionType,
        price: Number(price || 100),
        orderType: orderType || 'MARKET',
        productType: productType || 'INTRADAY',
        securityId: securityId || '0',
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/positions/close', async (req, res) => {
    try {
      const { symbol, ltp } = req.body;
      if (!symbol) return res.status(400).json({ error: 'symbol is required' });
      const result = await closePaperPosition(symbol, ltp ? Number(ltp) : undefined);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/paper/wallet/reset', async (req, res) => {
    try {
      const initialBalance = req.body.initialBalance ? Number(req.body.initialBalance) : 1000000;
      const result = await resetPaperWallet(initialBalance);
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
          const ltp = p ? p.ltp : l.ltp || l.bAvg || l.sAvg || 100;
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
      const strategyId = `s_${Date.now().toString(36)}`;
      for (const leg of legs || []) {
        await executePaperOrder({
          symbol: leg.instrument,
          transactionType: leg.side,
          quantity: leg.qty,
          price: leg.side === 'BUY' ? leg.bAvg : leg.sAvg,
          correlationId: strategyId,
        });
      }
      await createPaperStrategy({ id: strategyId, name, symbol, type, lots, legs });
      res.json({ status: 'ok', strategyId });
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
          await closePaperPosition(leg.instrument);
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
      } catch {
        let total = 0;
        for (const it of items) {
          const px = Number(it.price || 100);
          const qty = Number(it.quantity || 50);
          total += it.transactionType === 'SELL' ? px * qty * 0.18 : px * qty;
        }
        return res.json({ totalMargin: Number(total.toFixed(2)), spanMargin: Number((total * 0.7).toFixed(2)), exposureMargin: Number((total * 0.3).toFixed(2)) });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/holdings', async (_req, res) => {
    try {
      const holdings = await client.positions.listHoldings();
      res.json(holdings);
    } catch (e: any) {
      console.warn('[Portfolio] Holdings fetch failed:', e.message);
      res.json([]);
    }
  });

  router.get('/profile', async (_req, res) => {
    try {
      const profile = await client.profile.get();
      res.json(profile);
    } catch (e: any) {
      console.warn('[Portfolio] Profile fetch failed:', e.message);
      res.json({ name: 'Paper Demo Trader', client_id: 'PAPER_DEMO_01' });
    }
  });

  return router;
}
