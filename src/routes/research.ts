import { Router } from 'express';
import type { ResearchOrchestrator } from '../services/research/researchOrchestrator';

/**
 * Express REST API router for the Institutional Equity Research Engine.
 * Exposes research initiation, runs query, and audit evidence trails.
 */
export function researchRoutes(orchestrator: ResearchOrchestrator): Router {
  const router = Router();

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

  return router;
}
