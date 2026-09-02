import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { marketClock, istNow } from './marketHours';
import type { MarketDataService } from './marketData';
import type { RiskEngine } from './riskEngine';
import type { AgentOrchestrator } from './agent';
import {
  listPaperStrategies, listPaperPositions, markPositionsToMarket,
  closePaperPosition, updatePaperStrategyStatus, getPaperWallet,
} from '../db';

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
  private agent: AgentOrchestrator | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;
  private scanEnabled = process.env.AUTONOMOUS_SCAN_ENABLED !== 'false';
  private running = false;
  private lastCycleAt = 0;
  private lastScanAt = 0;
  private cycles = 0;
  private eodDone = false;
  private eodDate = '';
  private handledExits = new Set<string>();
  private unsubBus: Array<() => void> = [];
  private tickMarkScheduled = false;

  constructor(client: DhanClient, market: MarketDataService, risk: RiskEngine) {
    this.client = client;
    this.market = market;
    this.risk = risk;
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
      }

      if (this.enabled) {
        await markPositionsToMarket((secId) => this.market.getLtp(secId));
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

    const positions = await listPaperPositions();
    if (positions.filter((p: any) => p.netQty !== 0).length >= 4) return;

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
      const positions = await listPaperPositions();
      const pos = positions.find((x: any) => String(x.securityId) === String(p.securityId) && x.netQty !== 0);
      if (pos) {
        const ltp = this.market.getLtp(String(pos.securityId)) || pos.ltp;
        const res = await closePaperPosition(pos.tradingSymbol, ltp);
        eventBus.log('TRADE', `Auto-exit ${pos.tradingSymbol}: ${res.status} @ ₹${ltp} (${p.reason})`, 'autonomy');
      }
    } catch (e: any) {
      eventBus.log('ERROR', `Auto-exit failed: ${e.message}`, 'autonomy');
    }
  }

  private async publishPortfolioSnapshot(): Promise<void> {
    try {
      const [positions, wallet] = await Promise.all([listPaperPositions(), getPaperWallet()]);
      eventBus.emit('portfolio', { positions, funds: wallet, markedAt: Date.now() });
    } catch { /* snapshot failure is non-fatal */ }
  }

  private scheduleTickMark(): void {
    if (this.tickMarkScheduled || !this.enabled) return;
    this.tickMarkScheduled = true;
    setImmediate(async () => {
      this.tickMarkScheduled = false;
      try {
        await markPositionsToMarket((secId) => this.market.getLtp(secId));
        await this.publishPortfolioSnapshot();
      } catch { /* the 2s cycle below is the fallback */ }
    });
  }

  private async enforceStrategyLimits(): Promise<void> {
    const limit = this.risk.getLimits().perStrategyLossLimit;
    const strategies = await listPaperStrategies();
    const positions = await listPaperPositions();
    const posMap = new Map(positions.map((p: any) => [p.tradingSymbol, p]));

    for (const strat of strategies) {
      if (strat.status !== 'RUNNING') continue;
      let pnl = 0;
      for (const leg of strat.legs || []) {
        const pos = posMap.get(leg.instrument);
        if (pos) pnl += Number(pos.pnl || 0);
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
        const ltp = this.market.getLtp(String(pos.securityId)) || pos.ltp;
        await closePaperPosition(leg.instrument, ltp).catch(() => {});
      }
    }
  }

  async squareOffAll(reason: string): Promise<number> {
    eventBus.log('WARN', `Square-off triggered: ${reason}`, 'autonomy');
    const positions = await listPaperPositions();
    let closed = 0;
    for (const pos of positions) {
      if (pos.netQty === 0) continue;
      const ltp = this.market.getLtp(String(pos.securityId)) || pos.ltp;
      await closePaperPosition(pos.tradingSymbol, ltp).catch(() => {});
      closed++;
    }
    for (const s of await listPaperStrategies()) {
      if (s.status === 'RUNNING') await updatePaperStrategyStatus(s.id, 'STOPPED');
    }
    eventBus.log('TRADE', `Square-off complete: ${closed} position(s) closed`, 'autonomy');
    await this.publishPortfolioSnapshot();
    return closed;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsubBus.forEach((u) => u());
  }
}
