import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { MarketStreamManager } from '../ws/marketStream';

const INDEX_SECURITY_IDS: Record<string, string> = {
  NIFTY: '13',
  BANKNIFTY: '25',
  FINNIFTY: '27',
  INDIAVIX: '26',
};

interface IndexQuote {
  ltp: number;
  change: number;
  pct: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
}

function parseQuote(d: any): IndexQuote {
  if (!d) return { ltp: 0, change: 0, pct: 0, high: 0, low: 0, open: 0, prevClose: 0 };
  const ltp = Number(d.lastTradedPrice || d.ltp || 0);
  const prevClose = Number(d.close || d.prevClose || ltp);
  return {
    ltp,
    change: ltp - prevClose,
    pct: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
    high: Number(d.high || d.dayHigh || ltp),
    low: Number(d.low || d.dayLow || ltp),
    open: Number(d.open || d.dayOpen || ltp),
    prevClose,
  };
}

export function marketRoutes(client: DhanClient, stream: MarketStreamManager): Router {
  const router = Router();
  let cachedIndices: Record<string, IndexQuote> | null = null;
  let lastFetchTime = 0;
  const CACHE_TTL_MS = 3000;

  router.get('/indices', async (_req, res) => {
    const now = Date.now();
    if (cachedIndices && now - lastFetchTime < CACHE_TTL_MS) {
      return res.json(cachedIndices);
    }

    try {
      const secIds = Object.values(INDEX_SECURITY_IDS);
      const quote = await client.marketFeed.quote({ IDX_I: secIds });
      const idxData = (quote.data as any)?.IDX_I || {};

      const results: Record<string, IndexQuote> = {};
      for (const [sym, secId] of Object.entries(INDEX_SECURITY_IDS)) {
        results[sym] = parseQuote(idxData[secId]);
      }

      cachedIndices = results;
      lastFetchTime = now;
      res.json(results);
    } catch (e: any) {
      if (cachedIndices) {
        return res.json(cachedIndices);
      }
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/option-chain/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      const secId = INDEX_SECURITY_IDS[symbol.toUpperCase()] || '13';

      const chain = await (client as any).market.optionChain({
        securityId: secId,
        exchangeSegment: 'IDX_I',
      });

      if (chain?.data) {
        const oc = chain.data.oc || chain.data;
        const strikes = Object.keys(oc).sort((a, b) => Number(a) - Number(b));
        const rows = strikes.map((strike) => {
          const entry = oc[strike];
          return {
            strike: Number(strike),
            ce: {
              ltp: Number(entry?.ce?.ltp || 0),
              oi: Number(entry?.ce?.oi || 0),
              volume: Number(entry?.ce?.volume || 0),
              iv: Number(entry?.ce?.iv || 0),
              delta: Number(entry?.ce?.delta || 0),
              gamma: Number(entry?.ce?.gamma || 0),
            },
            pe: {
              ltp: Number(entry?.pe?.ltp || 0),
              oi: Number(entry?.pe?.oi || 0),
              volume: Number(entry?.pe?.volume || 0),
              iv: Number(entry?.pe?.iv || 0),
              delta: Number(entry?.pe?.delta || 0),
              gamma: Number(entry?.pe?.gamma || 0),
            },
          };
        });
        res.json({ strikes: rows, underlying: symbol.toUpperCase() });
      } else {
        res.json({ strikes: [], underlying: symbol.toUpperCase() });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/quote/:securityId', async (req, res) => {
    try {
      const { securityId } = req.params;
      const exchange = req.query.exchange as string || 'NSE_FNO';
      const quote = await client.marketFeed.quote({ [exchange]: [securityId] });
      res.json((quote.data as any)?.[exchange]?.[securityId] || {});
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/subscribe', (req, res) => {
    const { instruments } = req.body;
    if (Array.isArray(instruments)) {
      stream.addInstruments(instruments);
      res.json({ status: 'subscribed', count: instruments.length });
    } else {
      res.status(400).json({ error: 'instruments array required' });
    }
  });

  return router;
}
