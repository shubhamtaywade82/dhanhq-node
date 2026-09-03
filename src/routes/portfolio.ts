import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import {
  listPaperPositions, listPaperOrders, getPaperWallet, resetPaperWallet,
  closePaperPosition, listPaperStrategies, createPaperStrategy, updatePaperStrategyStatus,
  defaultMarginResolver, adjustWalletMargin,
} from '../db';
import type { MarketDataService } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import { eventBus } from '../services/eventBus';
import { moduleLogger } from '../lib/logger';
import { aggregatePortfolioGreeks } from '../services/optionsAnalytics';

import type { PaperExecutionEngine } from '../engines/paper';
import type { AgentOrchestrator } from '../services/agent';

const log = moduleLogger('portfolio');

export function portfolioRoutes(client: DhanClient, market: MarketDataService, risk?: RiskEngine, paper?: PaperExecutionEngine, agent?: AgentOrchestrator): Router {
  const router = Router();
  const isPaper = () => process.env.TRADING_MODE !== 'live';

  router.get('/summary', async (req, res) => {
    try {
      const [positions, wallet, strategies, orders] = await Promise.all([
        listPaperPositions(),
        getPaperWallet(),
        listPaperStrategies(),
        listPaperOrders(),
      ]);
      const indices = market.getIndices();
      const spotMap: Record<string, number> = {};
      for (const [sym, data] of Object.entries(indices)) {
        if (data?.ltp) spotMap[sym] = data.ltp;
      }
      const greeks = aggregatePortfolioGreeks(positions, spotMap, new Date().toISOString().slice(0, 10));
      res.json({
        wallet,
        positions,
        strategies,
        ordersCount: orders.length,
        openPositionsCount: positions.filter((p: any) => p.netQty !== 0).length,
        greeks,
        risk: risk?.snapshot() || null,
      });
    } catch (e: any) {
      log.warn({ requestId: req.id, err: { message: e.message } }, 'Portfolio summary fetch failed');
      res.status(500).json({ error: e.message });
    }
  });

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
      if (!paper) {
        return res.status(503).json({ error: 'Paper execution engine not available' });
      }

      // Route through PaperExecutionEngine so manual orders get the same
      // risk gate, LTP/LIMIT marketability check, slippage, latency, and
      // margin/fee handling as every other paper fill — no second path.
      const result = await paper.placeOrder({
        correlation_id: `manual_${Date.now().toString(36)}`,
        intent_id: 'manual_order',
        params: {
          security_id: securityId || '0',
          symbol,
          quantity: Number(quantity),
          transaction_type: transactionType,
          order_type: orderType || 'MARKET',
          exchange_segment: exchangeSegment || 'NSE_FNO',
          product_type: productType || 'INTRADAY',
          price: Number(price || 0),
        },
      });
      if (result.status === 'REJECTED') {
        return res.status(422).json({ error: result.reason });
      }
      eventBus.emit('order', { kind: 'fill', is_paper: true, symbol: String(symbol).toUpperCase(), fillPrice: result.fill_price, quantity: Number(quantity), correlationId: result.correlation_id, source: 'manual' });
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
      if (pos) market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
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
      if (!paper) {
        return res.status(503).json({ error: 'Paper execution engine not available' });
      }
      const strategyId = `s_${Date.now().toString(36)}`;

      // Price every leg up front so a multi-leg strategy's combined margin
      // (with hedge benefit) can be resolved before any leg fills.
      const pricedLegs = (legs || []).map((leg: any) => {
        const liveLtp = market.getLtp(leg.securityId || '0');
        const legPrice = liveLtp || Number(leg.bAvg || leg.sAvg || leg.price || 0);
        return { leg, legPrice };
      }).filter((p: any) => {
        if (!p.legPrice) eventBus.log('WARN', `Strategy ${name}: leg ${p.leg.instrument} has no live price — leg skipped`, 'portfolio');
        return p.legPrice > 0;
      });
      if (pricedLegs.length === 0) {
        return res.status(422).json({ error: 'No leg could be priced from the live market feed — strategy not deployed' });
      }

      let combinedMargin: number | null = null;
      if (pricedLegs.length > 1) {
        try {
          const resp: any = await (client as any).marginCalculator.calculateMulti(
            pricedLegs.map(({ leg, legPrice }: any) => ({
              exchangeSegment: leg.exchangeSegment || 'NSE_FNO',
              productType: 'INTRADAY',
              transactionType: leg.side,
              securityId: leg.securityId,
              quantity: leg.qty,
              price: legPrice,
            })),
          );
          const total = Number(resp?.totalMargin ?? resp?.data?.totalMargin);
          if (total > 0) combinedMargin = total;
        } catch { /* hedge-netted margin unavailable — each leg blocks its own standalone margin */ }
      }

      const usedMarginBefore = (await getPaperWallet()).usedMargin;
      let filled = 0;
      const legsWithPx = [];
      for (const { leg, legPrice } of pricedLegs) {
        // Route through PaperExecutionEngine — same risk/margin/fee/slippage
        // handling as every other paper fill, no second path.
        const result = await paper.placeOrder({
          correlation_id: `${strategyId}_${leg.instrument}`,
          intent_id: strategyId,
          params: {
            security_id: leg.securityId || '0',
            symbol: leg.instrument,
            quantity: leg.qty,
            transaction_type: leg.side,
            order_type: 'MARKET',
            exchange_segment: leg.exchangeSegment || 'NSE_FNO',
            product_type: 'INTRADAY',
            price: legPrice,
          },
        });
        if (result.status !== 'TRADED') {
          // Stop rather than skip to the next leg — firing more legs into a
          // structure that's already broken only adds more exposure to unwind.
          eventBus.log('WARN', `Strategy ${name}: leg ${leg.instrument} rejected — ${result.reason}`, 'portfolio');
          break;
        }
        filled++;
        legsWithPx.push({ ...leg, ltp: result.fill_price });
        // Keep tracking this instrument for mark-to-market.
        if (leg.securityId) {
          market.addInstruments([{ securityId: String(leg.securityId), exchangeSegment: leg.exchangeSegment || 'NSE_FNO' }]);
        }
      }
      if (filled === 0) {
        return res.status(422).json({ error: 'No leg could be priced from the live market feed — strategy not deployed' });
      }
      if (filled < pricedLegs.length) {
        // Partial fill on a multi-leg structure is worse than no fill — e.g.
        // a short leg filling without its hedge is naked, undefined risk.
        // Unwind whatever filled rather than leaving it to stand.
        for (const filledLeg of legsWithPx) {
          const unwindPrice = market.getFillablePrice(String(filledLeg.securityId || '0'), { allowClosed: true }) ?? filledLeg.ltp;
          await paper.placeOrder({
            correlation_id: `${strategyId}_${filledLeg.instrument}_unwind`,
            intent_id: strategyId,
            params: {
              security_id: filledLeg.securityId || '0', symbol: filledLeg.instrument, quantity: filledLeg.qty,
              transaction_type: filledLeg.side === 'BUY' ? 'SELL' : 'BUY', order_type: 'MARKET',
              exchange_segment: filledLeg.exchangeSegment || 'NSE_FNO', product_type: 'INTRADAY', price: unwindPrice,
            },
          }).catch(() => {});
          if (filledLeg.securityId) market.monitor.untrack(filledLeg.exchangeSegment || 'NSE_FNO', String(filledLeg.securityId));
        }
        eventBus.log('ERROR', `Strategy ${name}: partial fill (${filled}/${pricedLegs.length} legs) — unwound`, 'portfolio');
        return res.status(422).json({ error: `Partial fill (${filled}/${pricedLegs.length} legs) — unwound, strategy not deployed` });
      }

      // Release the hedge benefit: legs above each blocked their own
      // standalone margin, but a hedged combo needs less than the sum.
      let marginHedgeCredit = 0;
      if (combinedMargin != null) {
        const usedMarginAfter = (await getPaperWallet()).usedMargin;
        const standaloneAdded = usedMarginAfter - usedMarginBefore;
        marginHedgeCredit = Math.max(0, Number((standaloneAdded - combinedMargin).toFixed(2)));
        if (marginHedgeCredit > 0) await adjustWalletMargin(marginHedgeCredit);
      }

      await createPaperStrategy({ id: strategyId, name, symbol, type, lots, legs: legsWithPx, marginHedgeCredit });
      eventBus.log('TRADE', `Strategy "${name}" deployed (${filled} leg(s) filled at live prices${marginHedgeCredit > 0 ? `, ₹${marginHedgeCredit.toFixed(2)} hedge margin released` : ''})`, 'portfolio');
      res.json({ status: 'ok', strategyId, legsFilled: filled, marginHedgeCredit });
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

  router.post('/paper/strategy/execute', async (req, res) => {
    try {
      const { id } = req.body;
      const strategies = await listPaperStrategies();
      const strat = strategies.find((s) => s.id === id);
      if (!strat) return res.status(404).json({ error: 'Strategy not found' });

      if (!paper) {
        return res.status(503).json({ error: 'Paper execution engine not available' });
      }
      const gate = risk?.canTrade();
      if (gate && !gate.allowed) {
        return res.status(423).json({ error: `Execution blocked by risk engine: ${gate.reason}` });
      }

      let filled = 0;
      for (const leg of strat.legs || []) {
        const liveLtp = market.getLtp(leg.securityId || '0') ?? market.getLtp(String(leg.instrument));
        const legPrice = liveLtp || Number(leg.bAvg || leg.sAvg || leg.price || 0);
        if (!legPrice) continue;

        await paper.placeOrder({
          correlation_id: `${strat.id}_${leg.optionType || 'OPT'}_${leg.strike || '0'}`,
          intent_id: `trigger_${strat.id}`,
          params: {
            security_id: leg.securityId,
            symbol: leg.instrument,
            quantity: leg.qty,
            transaction_type: leg.side,
            order_type: 'MARKET',
            exchange_segment: leg.exchangeSegment || 'NSE_FNO',
            product_type: 'INTRADAY',
            price: legPrice,
          },
          risk_limits: {
            stop_loss: leg.stopLoss,
            target: leg.target,
            trailing_stop: leg.trailingStop,
          },
        });
        filled++;
      }

      await updatePaperStrategyStatus(id, 'RUNNING');
      eventBus.log('TRADE', `Strategy "${strat.name}" executed & RUNNING (${filled} leg(s) filled with SL/TP)`, 'portfolio');
      res.json({ status: 'ok', strategyId: id, legsFilled: filled });
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
        // updatePaperStrategyStatus('STOPPED') below reverses any
        // hedge-margin credit exactly once — don't duplicate it here.
        for (const leg of strat.legs) {
          const positions = await listPaperPositions();
          const pos = positions.find((p) => p.tradingSymbol === leg.instrument);
          const ltp = pos ? market.getLtp(String(pos.securityId)) || pos.ltp : undefined;
          await closePaperPosition(leg.instrument, ltp);
          if (pos) market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
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
        // the reason, instead of silently pretending it was real. Uses the
        // same conservative fallback as paper order execution (db.ts):
        // BUY = full premium (correct, no leverage on long options), SELL =
        // a conservative multiple, since SPAN+exposure isn't a fixed
        // fraction of premium and this only runs if the real API fails.
        let total = 0;
        for (const it of items) {
          const px = Number(it.price || 0);
          const qty = Number(it.quantity || 0);
          if (px > 0 && qty > 0) {
            total += await defaultMarginResolver({ side: it.transactionType, securityId: String(it.securityId || '0'), exchangeSegment: it.exchangeSegment || 'NSE_FNO', productType: it.productType || 'INTRADAY', quantity: qty, price: px });
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
