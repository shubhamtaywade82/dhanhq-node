import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { listPaperPositions, listPaperOrders, getPaperWallet, resetPaperWallet, executePaperOrder, closePaperPosition } from '../db';

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
