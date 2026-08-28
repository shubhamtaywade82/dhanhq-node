import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';

export function portfolioRoutes(client: DhanClient): Router {
  const router = Router();

  router.get('/positions', async (_req, res) => {
    try {
      const positions = await client.positions.list();
      res.json(positions);
    } catch (e: any) {
      console.warn('[Portfolio] Positions fetch failed:', e.message);
      res.json([]);
    }
  });

  router.get('/orders', async (_req, res) => {
    try {
      const orders = await client.orders.list();
      res.json(orders);
    } catch (e: any) {
      console.warn('[Portfolio] Orders fetch failed:', e.message);
      res.json([]);
    }
  });

  router.get('/trades', async (_req, res) => {
    try {
      const trades = await client.orders.listTrades();
      res.json(trades);
    } catch (e: any) {
      console.warn('[Portfolio] Trades fetch failed:', e.message);
      res.json([]);
    }
  });

  router.get('/funds', async (_req, res) => {
    try {
      const funds = await client.funds.getLimit();
      res.json(funds);
    } catch (e: any) {
      console.warn('[Portfolio] Funds fetch failed:', e.message);
      res.json({});
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
      res.json({});
    }
  });

  return router;
}
