import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { RiskEngine } from '../services/riskEngine';
import type { AutonomyEngine } from '../services/autonomy';
import type { AgentOrchestrator } from '../services/agent';
import type { MarketDataService } from '../services/marketData';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import { listAlerts, pushAlert } from '../db';
import { evaluateStrategyBacktest } from '../services/strategyConstructor';
import { analyzeOptionsBehavior } from './market';

/**
 * Control-plane routes.
 *
 * The frontend is a CONTROL PLANE: it reads backend state and issues
 * control commands (kill switch, autonomy toggle, risk limits, agent
 * runs). It never executes trades itself and never substitutes for the
 * backend's autonomous loop — everything here works identically with
 * zero frontend attached.
 */
export function controlRoutes(
  client: DhanClient,
  risk: RiskEngine,
  autonomy: AutonomyEngine,
  agent: AgentOrchestrator,
  market: MarketDataService,
): Router {
  const router = Router();

  // ── system state ────────────────────────────────────────────────────
  router.get('/state', async (_req, res) => {
    const [alerts, agentEvents] = await Promise.all([listAlerts(50), agent.events(50)]);
    res.json({
      mode: process.env.TRADING_MODE || 'paper',
      risk: risk.snapshot(),
      autonomy: autonomy.stats(),
      agent: agent.status(),
      market: market.stats(),
      alerts,
      agentEvents,
      version: {
        node: process.version,
        sdk: require('@nemesis-oss/dhanhq-sdk/package.json').version,
        app: require('../../package.json').version,
      },
    });
  });

  // ── kill switch ─────────────────────────────────────────────────────
  router.post('/kill', async (req, res) => {
    try {
      const { reason, confirm } = req.body || {};
      if (confirm !== 'CONFIRM') {
        return res.status(400).json({ error: 'Send {"confirm":"CONFIRM"} to arm the kill switch' });
      }
      const result = await risk.armKillSwitch(reason || 'Manual kill switch from control plane');
      journal.append('control_command', { route: 'POST /kill', reason, result });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/kill/reset', async (_req, res) => {
    try {
      const result = await risk.disarmKillSwitch();
      journal.append('control_command', { route: 'POST /kill/reset', result });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── autonomy ────────────────────────────────────────────────────────
  router.post('/autonomy', async (req, res) => {
    const { enabled } = req.body || {};
    autonomy.setEnabled(!!enabled);
    await pushAlert('INFO', 'control_plane', `Autonomy engine ${enabled ? 'resumed' : 'paused'} via control plane`);
    journal.append('control_command', { route: 'POST /autonomy', enabled: !!enabled });
    res.json({ status: 'ok', enabled: autonomy.isEnabled(), stats: autonomy.stats() });
  });

  router.post('/scanner', (req, res) => {
    const { enabled } = req.body || {};
    autonomy.setScanEnabled(!!enabled);
    journal.append('control_command', { route: 'POST /scanner', enabled: !!enabled });
    res.json({ status: 'ok', stats: autonomy.stats() });
  });

  // ── long-option peak-profit policy ─────────────────────────────────
  router.get('/long-option-policy', (_req, res) => {
    res.json({ enabled: autonomy.longOptionManager.isEnabled(), positions: autonomy.longOptionManager.snapshot() });
  });

  router.post('/long-option-policy', (req, res) => {
    const { enabled } = req.body || {};
    autonomy.longOptionManager.setEnabled(!!enabled);
    res.json({ status: 'ok', enabled: autonomy.longOptionManager.isEnabled() });
  });

  router.post('/square-off', async (req, res) => {
    try {
      const reason = req.body?.reason || 'Manual square-off from control plane';
      const closed = await autonomy.squareOffAll(reason);
      journal.append('control_command', { route: 'POST /square-off', reason, closed });
      res.json({ status: 'ok', closed });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── risk limits ─────────────────────────────────────────────────────
  router.get('/risk-limits', (_req, res) => {
    res.json(risk.getLimits());
  });

  router.post('/risk-limits', async (req, res) => {
    const patch = req.body || {};
    const clean: any = {};
    if (patch.dailyLossLimit != null) clean.dailyLossLimit = Math.max(1000, Number(patch.dailyLossLimit));
    if (patch.maxMarginUtilPct != null) clean.maxMarginUtilPct = Math.min(100, Math.max(10, Number(patch.maxMarginUtilPct)));
    if (patch.perStrategyLossLimit != null) clean.perStrategyLossLimit = Math.max(500, Number(patch.perStrategyLossLimit));
    if (patch.maxConsecutiveLosses != null) clean.maxConsecutiveLosses = Math.max(1, Number(patch.maxConsecutiveLosses));
    if (patch.maxRejectionRatePct != null) clean.maxRejectionRatePct = Math.max(1, Number(patch.maxRejectionRatePct));
    if (patch.staleTickSec != null) clean.staleTickSec = Math.max(3, Number(patch.staleTickSec));
    const updated = await risk.setLimits(clean);
    journal.append('control_command', { route: 'POST /risk-limits', patch: clean, updated });
    res.json(updated);
  });

  // ── agent ───────────────────────────────────────────────────────────
  router.post('/agent/run', async (req, res) => {
    try {
      const { objective } = req.body || {};
      if (!objective || typeof objective !== 'string' || objective.trim().length < 4) {
        return res.status(400).json({ error: 'objective (string, ≥4 chars) required' });
      }
      const result = await agent.run(objective.trim(), 'control_plane');
      journal.append('control_command', { route: 'POST /agent/run', objective: objective.trim(), result });
      res.json(result);
    } catch (e: any) {
      res.status(e.message?.includes('already in progress') ? 409 : 500).json({ error: e.message });
    }
  });

  router.get('/agent/status', async (_req, res) => {
    const llmOnline = await agent.refreshLlm();
    res.json({ ...agent.status(), llmOnline });
  });

  router.get('/agent/events', async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json(await agent.events(limit));
  });

  router.get('/agent/tools', (_req, res) => {
    res.json(agent.toolCatalog());
  });

  // ── alerts ──────────────────────────────────────────────────────────
  router.get('/alerts', async (req, res) => {
    res.json(await listAlerts(Math.min(500, Number(req.query.limit) || 100)));
  });

  router.post('/alerts/test', async (req, res) => {
    const { level, message } = req.body || {};
    await pushAlert(level || 'INFO', 'control_plane', message || 'Manual test alert');
    eventBus.emit('alert', { level: level || 'INFO', source: 'control_plane', msg: message || 'Manual test alert' });
    res.json({ status: 'ok' });
  });

  // ── strategy backtest ───────────────────────────────────────────────
  router.post('/strategy/backtest', async (req, res) => {
    try {
      const { symbol = 'NIFTY', type = 'STRADDLE', days = 5, entryType, targetPct, slPct, timeExit, lots, side } = req.body || {};
      const secMap: Record<string, string> = { NIFTY: '13', BANKNIFTY: '25', FINNIFTY: '27', MIDCPNIFTY: '442', SENSEX: '51' };
      const sym = symbol.toUpperCase();
      const secId = secMap[sym] || '13';
      const histData = await analyzeOptionsBehavior(client, {
        symbol: sym,
        securityId: secId,
        daysCount: Math.min(10, Math.max(1, Number(days) || 5)),
        interval: '1',
        expiryFlag: 'WEEK',
        expiryCode: 1,
      });
      const report = evaluateStrategyBacktest(sym, type, histData.days || [], {
        entryType,
        targetPct: Number(targetPct) || 20,
        slPct: Number(slPct) || 15,
        timeExit: timeExit || '13:30',
        lots: Number(lots) || 1,
        side,
      });
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: `Strategy backtest failed: ${e.message}` });
    }
  });

  return router;
}
