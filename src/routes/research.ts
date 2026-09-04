import { Router } from 'express';
import type { ResearchOrchestrator } from '../services/research/researchOrchestrator';
import type { ResearchScheduler } from '../services/research/researchScheduler';
import { listUniverses } from '../services/research/universe';
import { getActiveWatchlist } from '../services/research/researchRepository';

/**
 * Express REST API router for the Institutional Equity Research Engine.
 * Exposes research initiation, runs query, screener, and autonomous scheduler.
 */
export function researchRoutes(orchestrator: ResearchOrchestrator, scheduler?: ResearchScheduler): Router {
  const router = Router();

  // GET /api/research/watchlist - List active persistent research watchlist
  router.get('/watchlist', async (_req, res) => {
    try {
      const items = await getActiveWatchlist();
      return res.json({ count: items.length, watchlist: items });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/research/watchlist/refresh - Manually trigger watchlist screening refresh
  router.post('/watchlist/refresh', async (req, res) => {
    const { universe = 'FNO_HEAVYWEIGHTS', preset = 'QUALITY_COMPOUNDERS', exchange = 'NSE' } = req.body || {};
    try {
      await orchestrator.screen(universe, preset, exchange);
      const items = await getActiveWatchlist();
      return res.json({ count: items.length, watchlist: items });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/research/scheduler/status - Autonomous market lifecycle status
  router.get('/scheduler/status', async (_req, res) => {
    const items = await getActiveWatchlist().catch(() => []);
    if (scheduler) {
      const status = scheduler.getStatus();
      status.activeWatchlistCount = items.length;
      return res.json(status);
    }
    return res.json({
      enabled: false,
      marketPhase: 'CLOSED',
      nextScheduledJob: 'Autonomous scheduler armed',
      nextJobTimeIst: '--',
      telegramEnabled: false,
      activeWatchlistCount: items.length,
      lastRunTimes: {},
    });
  });

  // POST /api/research/scheduler/trigger - Trigger a specific market lifecycle phase
  router.post('/scheduler/trigger', async (req, res) => {
    const { phase = 'pre_market' } = req.body || {};
    if (!scheduler) {
      return res.status(400).json({ error: 'Scheduler is not running' });
    }
    try {
      const result = await scheduler.triggerPhase(phase);
      return res.json(result);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/research/universes - List predefined stock baskets
  router.get('/universes', async (req, res) => {
    const exchange = (req.query.exchange as any) === 'BSE' ? 'BSE' : 'NSE';
    try {
      return res.json({ exchange, universes: await listUniverses(orchestrator.client, exchange) });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/research/screen - Fast deterministic quantitative screening
  router.post('/screen', async (req, res) => {
    const { universe = 'FNO_HEAVYWEIGHTS', preset = 'QUALITY_COMPOUNDERS', exchange = 'NSE' } = req.body || {};
    try {
      const result = await orchestrator.screen(universe, preset, exchange);
      return res.status(200).json(result);
    } catch (e: any) {
      return res.status(500).json({ error: `Screening failed: ${e.message}` });
    }
  });

  // POST /api/research/screen-and-analyze - Stage 1 filter + Stage 2 Agentic AI deep dive
  router.post('/screen-and-analyze', async (req, res) => {
    const { universe = 'FNO_HEAVYWEIGHTS', preset = 'QUALITY_COMPOUNDERS', topN = 3, exchange = 'NSE' } = req.body || {};
    try {
      const result = await orchestrator.screenAndAnalyze(universe, preset, Number(topN) || 3);
      return res.status(200).json(result);
    } catch (e: any) {
      return res.status(500).json({ error: `Screen and analyze failed: ${e.message}` });
    }
  });

  // POST /api/research/analyze - Start equity research on a symbol
  router.post('/analyze', async (req, res) => {
    const { symbol, exchange } = req.body || {};
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol is required (e.g. "RELIANCE")' });
    }

    try {
      // Run analysis synchronously or return run result
      const run = await orchestrator.analyze(symbol.trim().toUpperCase(), { exchange });
      return res.status(200).json(run);
    } catch (e: any) {
      return res.status(500).json({ error: `Research failed: ${e.message}` });
    }
  });

  // GET /api/research/runs - List recent research runs
  router.get('/runs', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    try {
      const runs = await orchestrator.listRuns(limit);
      return res.json({ count: runs.length, runs });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/research/:runId - Fetch detailed research run and verdict
  router.get('/:runId', async (req, res) => {
    const { runId } = req.params;
    try {
      const run = await orchestrator.getRun(runId);
      if (!run) {
        return res.status(404).json({ error: `Research run ${runId} not found` });
      }
      return res.json(run);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/research/:runId/evidence - Fetch evidence ledger and audit trail
  router.get('/:runId/evidence', async (req, res) => {
    const { runId } = req.params;
    try {
      const evidence = await orchestrator.getEvidence(runId);
      return res.json({ runId, count: evidence.length, evidence });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/research/:runId/status - Check progress of a research run
  router.get('/:runId/status', async (req, res) => {
    const { runId } = req.params;
    try {
      const run = await orchestrator.getRun(runId);
      if (!run) {
        return res.status(404).json({ error: `Research run ${runId} not found` });
      }
      return res.json({ runId: run.runId, status: run.status, completedAt: run.completedAt });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/research/signal/:symbol - Get latest active research trade signal
  router.get('/signal/:symbol', (req, res) => {
    const { symbol } = req.params;
    const signal = orchestrator.getSignal(symbol);
    if (!signal) {
      return res.status(404).json({ error: `No active research trade signal found for ${symbol}` });
    }
    return res.json(signal);
  });

  return router;
}
