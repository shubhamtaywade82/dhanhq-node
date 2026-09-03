import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { journal } from './journal';
import { marketClock, istNow } from './marketHours';
import type { MarketDataService } from './marketData';
import { toTrailConfig } from './marketData';
import type { RiskEngine } from './riskEngine';
import type { AgentOrchestrator } from './agent';
import {
  listPaperStrategies, updatePaperStrategyStatus, pushAlert,
  reconcileLedger, correctLedgerFromPostgres,
} from '../db';
import { PaperPortfolioSource, type PortfolioSource } from './portfolioSource';

/**
 * Autonomy engine — the heartbeat that keeps the system trading when no
 * frontend is attached.
 *
 * Runs every 2s during market hours (30s off-hours):
 *   1. Marks all open paper positions to market from live ticks.
 *   2. Acts on PositionMonitor exit signals autonomously.
 *   3. Enforces strategy loss limits.
 *   4. Periodically scans for autonomous option opportunities (09:20-15:15 IST).
 *   5. Closes every position at 15:20 IST EOD square-off.
 */
export class AutonomyEngine {
  private client: DhanClient;
  private market: MarketDataService;
  private risk: RiskEngine;
  private portfolio: PortfolioSource;
  private agent: AgentOrchestrator | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;
  private scanEnabled = process.env.AUTONOMOUS_SCAN_ENABLED !== 'false';
  private running = false;
  private lastCycleAt = 0;
  private lastScanAt = 0;
  private lastLedgerCheckAt = 0;
  private cycles = 0;
  private eodDone = false;
  private eodDate = '';
  private handledExits = new Set<string>();
  private unsubBus: Array<() => void> = [];
  private tickMarkScheduled = false;

  constructor(client: DhanClient, market: MarketDataService, risk: RiskEngine, portfolio: PortfolioSource = new PaperPortfolioSource()) {
    this.client = client;
    this.market = market;
    this.risk = risk;
    this.portfolio = portfolio;
  }

  setAgent(agent: AgentOrchestrator): void {
    this.agent = agent;
  }

  setScanEnabled(on: boolean): void {
    this.scanEnabled = on;
    eventBus.log('SYSTEM', `Autonomous market scanner ${on ? 'ENABLED' : 'DISABLED'}`, 'autonomy');
  }

  async start(): Promise<void> {
    this.eodDate = istNow().toISOString().slice(0, 10);
    this.eodDone = false;

    this.unsubBus.push(eventBus.on('order', async (env) => {
      const p = env.payload || {};
      if (p.kind !== 'exit_signal') return;
      await this.handleExitSignal(p);
    }));

    // Mark-to-market + portfolio push on every live tick, not just the 2s
    // cycle below — position P&L should move the instant a real price does.
    // Coalesced: a burst of ticks across several instruments in the same
    // turn triggers one recompute, not N. The interval loop remains as a
    // fallback heartbeat (EOD/limits/scan still run on their own cadence).
    this.unsubBus.push(eventBus.on('tick', () => this.scheduleTickMark()));

    this.scheduleNext(1000);
    eventBus.log('SYSTEM', `Autonomy engine started (mode=${process.env.TRADING_MODE || 'paper'}, EOD 15:20 IST, scanner=${this.scanEnabled})`, 'autonomy');
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    eventBus.log('SYSTEM', `Autonomy engine ${on ? 'RESUMED' : 'PAUSED'} by control plane`, 'autonomy');
    eventBus.emit('system', { type: 'autonomy', enabled: on });
    if (on && !this.timer) this.scheduleNext(100);
  }

  isEnabled(): boolean { return this.enabled; }

  stats() {
    return {
      enabled: this.enabled,
      scanEnabled: this.scanEnabled,
      cycles: this.cycles,
      lastCycleAt: this.lastCycleAt ? new Date(this.lastCycleAt).toISOString() : null,
      lastCycleAgoSec: this.lastCycleAt ? Math.round((Date.now() - this.lastCycleAt) / 1000) : null,
      eodDone: this.eodDone,
      clock: marketClock(),
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.cycle(), delayMs);
  }

  private async cycle(): Promise<void> {
    if (this.running) { this.scheduleNext(2000); return; }
    this.running = true;
    try {
      const clock = marketClock();
      this.cycles++;
      this.lastCycleAt = Date.now();

      if (clock.istDate !== this.eodDate) {
        this.eodDate = clock.istDate;
        this.eodDone = false;
        // Roll the journal to a fresh per-day file too — without this a
        // process that stays up across midnight would keep appending
        // every subsequent day's entries into yesterday's file forever.
        journal.open(clock.istDate);
        eventBus.log('SYSTEM', `Journal rolled to new trading day: ${clock.istDate}`, 'autonomy');
      }

      if (this.enabled) {
        const mark = await this.portfolio.markToMarket((secId) => this.market.getFillablePrice(secId, { allowClosed: true, maxAgeMs: 60_000 }));
        if (clock.isMarketOpen && mark.staleCount > 0) {
          eventBus.log('WARN', `${mark.staleCount} open position(s) marked from a stale price (no fresh quote in 60s)`, 'autonomy');
        }
        await this.reconcileMonitor();
        await this.reconcileLedgerAgainstPostgres();
        await this.publishPortfolioSnapshot();
        await this.enforceStrategyLimits();

        if (clock.squareOffWindow && !this.eodDone && !this.risk.isKilled()) {
          await this.squareOffAll('EOD square-off window (15:20 IST)');
          this.eodDone = true;
        }

        await this.evaluateAutonomousScan(clock);
      }

      const nextDelay = clock.isMarketOpen ? 2000 : 30000;
      this.scheduleNext(nextDelay);
    } catch (e: any) {
      eventBus.log('ERROR', `Autonomy cycle error: ${e.message}`, 'autonomy');
      this.scheduleNext(5000);
    } finally {
      this.running = false;
    }
  }

  private async evaluateAutonomousScan(clock: ReturnType<typeof marketClock>): Promise<void> {
    if (!this.scanEnabled || !this.agent || !clock.isMarketOpen || clock.squareOffWindow) return;
    if (Date.now() - this.lastScanAt < 60_000) return; // 60s scan cooldown

    const gate = this.risk.canTrade();
    if (!gate.allowed) return;

    const positions = await this.portfolio.getPositions();
    if (positions.filter((p) => p.netQty !== 0).length >= 4) return;

    this.lastScanAt = Date.now();
    try {
      await this.agent.run('Autonomous options scan and execute across all watchlist indices (NIFTY, BANKNIFTY, FINNIFTY, SENSEX, MIDCPNIFTY)', 'autonomous_scanner');
    } catch { /* agent busy or skipped */ }
  }

  private async handleExitSignal(p: any): Promise<void> {
    const key = `${p.positionId}_${p.reason}_${Math.floor(Date.now() / 60000)}`;
    if (this.handledExits.has(key)) return;
    this.handledExits.add(key);
    if (this.handledExits.size > 200) this.handledExits.clear();

    eventBus.log('WARN', `Exit signal (${p.reason}) for ${p.securityId}`, 'autonomy');
    try {
      const positions = await this.portfolio.getPositions();
      const pos = positions.find((x) => String(x.securityId) === String(p.securityId) && x.netQty !== 0);
      if (pos) {
        const ltp = this.market.getFillablePrice(String(pos.securityId), { allowClosed: true }) ?? this.market.getLtp(String(pos.securityId)) ?? pos.ltp;
        // A triggered stop (hard SL or trailing) crosses the spread on the
        // adverse move that fired it — priced with extra slippage vs. a
        // target hit or a manual close, which fill more like a resting order.
        const kind = p.reason === 'stop_loss' || p.reason === 'trailing_stop' ? 'STOP' : 'EXIT';
        const res = await this.portfolio.closePosition(pos.tradingSymbol, ltp, kind);
        this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
        eventBus.log('TRADE', `Auto-exit ${pos.tradingSymbol}: ${res.status} @ ₹${ltp} (${p.reason})`, 'autonomy');
        await this.closeParentStrategyIfFlat(pos.tradingSymbol);
      }
    } catch (e: any) {
      eventBus.log('ERROR', `Auto-exit failed: ${e.message}`, 'autonomy');
    }
  }

  /** A leg closing via SL/target/trailing (not the strategy-level loss-limit
   * path below) never told the parent strategy — it stayed RUNNING forever
   * with a stale PnL once all its legs were flat. */
  private async closeParentStrategyIfFlat(tradingSymbol: string): Promise<void> {
    const strategies = await listPaperStrategies();
    const strat = strategies.find((s: any) => s.status === 'RUNNING' && (s.legs || []).some((l: any) => l.instrument === tradingSymbol));
    if (!strat) return;
    const positions = await this.portfolio.getPositions();
    const posMap = new Map(positions.map((p) => [p.tradingSymbol, p]));
    const stillOpen = (strat.legs || []).some((l: any) => Number(posMap.get(l.instrument)?.netQty || 0) !== 0);
    if (!stillOpen) await updatePaperStrategyStatus(strat.id, 'STOPPED');
  }

  /**
   * Reconciles PositionMonitor's in-memory tracked set against the actual
   * open-position ledger, once per cycle. Two directions of drift, both
   * silent until now:
   *
   *  - Orphaned monitor entries: a tracked position with no matching open
   *    position (its close path failed to untrack it, or a bug elsewhere
   *    leaves it dangling). Left alone, RE-ENTERING the same security later
   *    would inherit the PREVIOUS trade's stop/target and could exit
   *    immediately at a price that has nothing to do with the new position.
   *  - Missing protection: an open position in the ledger with a
   *    stop/target/trailing-stop configured that ISN'T tracked (a restart
   *    that predates this reconciler, or a track() call that silently
   *    failed). Left alone, the position trades with no protection at all
   *    until a human notices.
   *
   * Every correction is logged AND alerted — drift here means the risk
   * layer was blind to something, which is exactly what should never pass
   * silently.
   */
  private async reconcileMonitor(): Promise<void> {
    const positions = await this.portfolio.getPositions();
    const open = new Map<string, any>();
    for (const p of positions) {
      if (p.netQty !== 0 && p.securityId && p.securityId !== '0') {
        open.set(`${p.exchangeSegment || 'NSE_FNO'}:${p.securityId}`, p);
      }
    }

    const tracked = this.market.monitor.tracked();
    for (const t of tracked) {
      const key = `${t.exchangeSegment}:${t.securityId}`;
      if (open.has(key)) continue;
      this.market.monitor.untrack(t.exchangeSegment, t.securityId);
      eventBus.log('WARN', `Reconciler: untracked stale monitor entry ${key} — no matching open position`, 'autonomy');
      await pushAlert('WARN', 'autonomy', `Monitor/position drift corrected: untracked stale entry ${key}`);
    }

    // Re-check after untracking above rather than reusing `tracked` — keeps
    // the two passes independent instead of assuming untrack() synchronously
    // affects a stale local list correctly (it does, but this is cheap and
    // makes that assumption unnecessary to reason about).
    const trackedKeys = new Set(this.market.monitor.tracked().map((t) => `${t.exchangeSegment}:${t.securityId}`));
    for (const [key, p] of open) {
      if (trackedKeys.has(key)) continue;
      if (!p.stopLoss && !p.target && !p.trailingStop) continue;
      this.market.monitor.track({
        securityId: String(p.securityId),
        exchangeSegment: p.exchangeSegment || 'NSE_FNO',
        quantity: p.netQty,
        entryPrice: p.netQty > 0 ? p.buyAvg : p.sellAvg,
        stopLoss: p.stopLoss ?? undefined,
        target: p.target ?? undefined,
        trail: toTrailConfig(p.trailingStop),
      });
      eventBus.log('WARN', `Reconciler: re-armed missing protection for ${key}`, 'autonomy');
      await pushAlert('WARN', 'autonomy', `Monitor/position drift corrected: re-armed protection for ${key}`);
    }
  }

  /**
   * Compares the in-memory ledger (the read path every position/wallet
   * query goes through) against what's actually durable in Postgres, once
   * a minute — a handful of indexed queries, not worth running every 2s
   * cycle. They're expected to always agree; a mismatch means a write
   * silently diverged (a commit that appeared to fail but partially
   * applied, a manual SQL change, a future bug that updates one store and
   * not the other). Postgres is the durable source of truth, so every
   * correction pulls mem back in line with it — consistent with the
   * monitor/position reconciler above: auto-correct AND alert loudly,
   * never silently.
   */
  private async reconcileLedgerAgainstPostgres(): Promise<void> {
    // In-memory-vs-Postgres drift only exists for the paper ledger — broker
    // mode has no local mem mirror to drift from Postgres, it reads the
    // account straight from DhanHQ on every poll. (The equivalent check for
    // broker mode — local book vs the actual broker book — is a separate,
    // not-yet-built reconciler; see PortfolioSource's docstring.)
    if (this.portfolio.kind !== 'paper') return;
    if (Date.now() - this.lastLedgerCheckAt < 60_000) return;
    this.lastLedgerCheckAt = Date.now();

    const report = await reconcileLedger();
    if (report.ok) return;

    const summary = [
      ...report.mismatches.map((m) => `${m.subject}.${m.field}: mem=${m.mem} pg=${m.postgres}`),
      ...report.missingInPostgres.map((s) => `${s}: open in mem, no Postgres row`),
      ...report.missingInMem.map((s) => `${s}: open in Postgres, missing from mem`),
    ].join('; ');

    eventBus.log('ERROR', `Ledger drift detected — correcting mem from Postgres: ${summary}`, 'autonomy');
    await pushAlert('ERROR', 'autonomy', `Ledger drift corrected (Postgres wins): ${summary}`);
    journal.append('risk_decision', { rule: 'Ledger Consistency', from: 'OK', to: 'ERROR', current: summary, threshold: 'mem === postgres', action: 'Corrected mem from Postgres' });

    await correctLedgerFromPostgres(report);
    await this.publishPortfolioSnapshot();
  }

  private async publishPortfolioSnapshot(): Promise<void> {
    try {
      const [positions, wallet] = await Promise.all([this.portfolio.getPositions(), this.portfolio.getWallet()]);
      eventBus.emit('portfolio', { positions, funds: wallet, markedAt: Date.now() });
    } catch { /* snapshot failure is non-fatal */ }
  }

  private scheduleTickMark(): void {
    if (this.tickMarkScheduled || !this.enabled) return;
    this.tickMarkScheduled = true;
    setImmediate(async () => {
      this.tickMarkScheduled = false;
      try {
        await this.portfolio.markToMarket((secId) => this.market.getFillablePrice(secId, { allowClosed: true, maxAgeMs: 60_000 }));
        await this.publishPortfolioSnapshot();
      } catch { /* the 2s cycle below is the fallback */ }
    });
  }

  private async enforceStrategyLimits(): Promise<void> {
    const limit = this.risk.getLimits().perStrategyLossLimit;
    const strategies = await listPaperStrategies();
    const positions = await this.portfolio.getPositions();
    const posMap = new Map(positions.map((p) => [p.tradingSymbol, p]));

    for (const strat of strategies) {
      if (strat.status !== 'RUNNING') continue;
      let pnl = 0;
      for (const leg of strat.legs || []) {
        const pos = posMap.get(leg.instrument);
        if (pos) pnl += Number(pos.realizedProfit || 0) + Number(pos.unrealizedProfit || 0);
      }
      if (pnl <= -limit) {
        eventBus.log('WARN', `Strategy ${strat.name} loss limit breached (₹${pnl} ≤ -₹${limit})`, 'autonomy');
        await this.closeStrategyLegs(strat, positions);
        await updatePaperStrategyStatus(strat.id, 'STOPPED');
        await this.publishPortfolioSnapshot();
      }
    }
  }

  private async closeStrategyLegs(strat: any, positions: any[]): Promise<void> {
    for (const leg of strat.legs || []) {
      const pos = positions.find((p) => p.tradingSymbol === leg.instrument);
      if (pos && pos.netQty !== 0) {
        const ltp = this.market.getFillablePrice(String(pos.securityId), { allowClosed: true }) ?? this.market.getLtp(String(pos.securityId)) ?? pos.ltp;
        await this.portfolio.closePosition(leg.instrument, ltp).catch(() => {});
        this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
      }
    }
  }

  async squareOffAll(reason: string): Promise<number> {
    eventBus.log('WARN', `Square-off triggered: ${reason}`, 'autonomy');
    const positions = await this.portfolio.getPositions();
    let closed = 0;
    for (const pos of positions) {
      if (pos.netQty === 0) continue;
      const ltp = this.market.getFillablePrice(String(pos.securityId), { allowClosed: true }) ?? this.market.getLtp(String(pos.securityId)) ?? pos.ltp;
      await this.portfolio.closePosition(pos.tradingSymbol, ltp).catch(() => {});
      this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
      closed++;
    }
    for (const s of await listPaperStrategies()) {
      if (s.status === 'RUNNING') await updatePaperStrategyStatus(s.id, 'STOPPED');
    }
    eventBus.log('TRADE', `Square-off complete: ${closed} position(s) closed`, 'autonomy');
    journal.append('eod', { reason, closed });
    await this.publishPortfolioSnapshot();
    return closed;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsubBus.forEach((u) => u());
  }
}
