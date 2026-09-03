import { Router } from 'express';
import type { ResearchOrchestrator } from '../services/research/researchOrchestrator';
import { listUniverses } from '../services/research/universe';

/**
 * Express REST API router for the Institutional Equity Research Engine.
 * Exposes research initiation, runs query, and audit evidence trails.
 */
export function researchRoutes(orchestrator: ResearchOrchestrator): Router {
  const router = Router();

  // GET /api/research/universes - List predefined stock baskets
  router.get('/universes', (_req, res) => {
    return res.json({ universes: listUniverses() });
  });

  // POST /api/research/screen - Fast deterministic quantitative screening
  router.post('/screen', async (req, res) => {
    const { universe = 'FNO_HEAVYWEIGHTS', preset = 'QUALITY_COMPOUNDERS' } = req.body || {};
    try {
      const result = await orchestrator.screen(universe, preset);
      return res.status(200).json(result);
    } catch (e: any) {
      return res.status(500).json({ error: `Screening failed: ${e.message}` });
    }
  });

  // POST /api/research/screen-and-analyze - Stage 1 filter + Stage 2 Agentic AI deep dive
  router.post('/screen-and-analyze', async (req, res) => {
    const { universe = 'FNO_HEAVYWEIGHTS', preset = 'QUALITY_COMPOUNDERS', topN = 3 } = req.body || {};
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
