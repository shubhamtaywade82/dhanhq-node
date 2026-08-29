import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { marketClock, istNow } from './marketHours';
import type { MarketDataService } from './marketData';
import type { RiskEngine } from './riskEngine';
import {
  listPaperStrategies, listPaperPositions, markPositionsToMarket,
  closePaperPosition, updatePaperStrategyStatus, getPaperWallet,
} from '../db';

/**
 * Autonomy engine — the heartbeat that keeps the system trading when no
 * frontend is attached.
 *
 * Every cycle (2s during market hours, 30s off-hours):
 *   1. Marks all open paper positions to market from live ticks and
 *      publishes a portfolio snapshot (positions, orders, funds).
 *   2. Acts on PositionMonitor exit signals (stop-loss / target / trail)
 *      emitted through the bus — closing the corresponding position.
 *   3. Manages RUNNING strategies: squares off any strategy whose PnL
 *      breaches the per-strategy loss limit.
 *   4. At the EOD square-off window (15:20–15:30 IST) closes every
 *      intraday position and stops strategies — autonomously.
 *
 * The frontend is a pure observer/control plane: it can start/stop the
 * loop via /api/control/autonomy but never drives a cycle itself.
 */
export class AutonomyEngine {
  private client: DhanClient;
  private market: MarketDataService;
  private risk: RiskEngine;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;
  private running = false;            // cycle guard
  private lastCycleAt = 0;
  private cycles = 0;
  private eodDone = false;            // one square-off per day
  private eodDate = '';
  private handledExits = new Set<string>();
  private unsubBus: Array<() => void> = [];

  constructor(client: DhanClient, market: MarketDataService, risk: RiskEngine) {
    this.client = client;
    this.market = market;
    this.risk = risk;
  }

  async start(): Promise<void> {
    this.eodDate = istNow().toISOString().slice(0, 10);
    this.eodDone = false;

    // PositionMonitor exit signals → close positions autonomously.
    this.unsubBus.push(eventBus.on('order', async (env) => {
      const p = env.payload || {};
      if (p.kind !== 'exit_signal') return;
      const key = `${p.positionId}_${p.reason}_${Math.floor(Date.now() / 60000)}`;
      if (this.handledExits.has(key)) return;
      this.handledExits.add(key);
      if (this.handledExits.size > 200) this.handledExits.clear();

      eventBus.log('WARN', `Exit signal (${p.reason}) for ${p.securityId} — PnL ₹${Number(p.pnl || 0).toFixed(2)}`, 'autonomy');
      try {
        const positions = await listPaperPositions();
        const pos = positions.find((x: any) => String(x.securityId) === String(p.securityId) && x.netQty !== 0)
          || positions.find((x: any) => x.netQty !== 0);
        if (pos) {
          const ltp = this.market.getLtp(String(pos.securityId)) || pos.ltp;
          const res = await closePaperPosition(pos.tradingSymbol, ltp);
          eventBus.log('TRADE', `Auto-exit ${pos.tradingSymbol}: ${res.status} @ ₹${ltp?.toFixed?.(2) ?? ltp} (${p.reason})`, 'autonomy');
          eventBus.emit('alert', { level: 'WARN', source: 'autonomy', msg: `Position ${pos.tradingSymbol} auto-exited (${p.reason}), PnL ₹${Number(p.pnl || 0).toFixed(2)}` });
        }
      } catch (e: any) {
        eventBus.log('ERROR', `Auto-exit failed: ${e.message}`, 'autonomy');
      }
    }));

    this.scheduleNext(1000);
    eventBus.log('SYSTEM', `Autonomy engine started (mode=${process.env.TRADING_MODE || 'paper'}, EOD square-off 15:20 IST)`, 'autonomy');
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    eventBus.log('SYSTEM', `Autonomy engine ${on ? 'RESUMED' : 'PAUSED'} by control plane`, 'autonomy');
    eventBus.emit('system', { type: 'autonomy', enabled: on });
    if (on && !this.timer) this.scheduleNext(100);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  stats() {
    return {
      enabled: this.enabled,
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

      // Reset EOD latch on date change.
      if (clock.istDate !== this.eodDate) {
        this.eodDate = clock.istDate;
        this.eodDone = false;
      }

      if (this.enabled) {
        // 1. Mark-to-market from live ticks + publish portfolio snapshot.
        await markPositionsToMarket((secId, _sym) => this.market.getLtp(secId));
        await this.publishPortfolioSnapshot();

        // 2. Strategy guardrails.
        await this.enforceStrategyLimits();

        // 3. EOD square-off (one-shot per trading day).
        if (clock.squareOffWindow && !this.eodDone && !this.risk.isKilled()) {
          await this.squareOffAll('EOD square-off window (15:20 IST)');
          this.eodDone = true;
        }
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

  private async publishPortfolioSnapshot(): Promise<void> {
    try {
      const [positions, wallet] = await Promise.all([listPaperPositions(), getPaperWallet()]);
      eventBus.emit('portfolio', {
        positions,
        funds: wallet,
        markedAt: Date.now(),
      });
    } catch { /* snapshot failure is non-fatal */ }
  }

  private async enforceStrategyLimits(): Promise<void> {
    const limit = this.risk.getLimits().perStrategyLossLimit;
    const strategies = await listPaperStrategies();
    const positions = await listPaperPositions();
    const posBySymbol = new Map(positions.map((p: any) => [p.tradingSymbol, p]));

    for (const strat of strategies) {
      if (strat.status !== 'RUNNING') continue;
      let pnl = 0;
      for (const leg of strat.legs || []) {
        const pos = posBySymbol.get(leg.instrument);
        if (pos) pnl += Number(pos.pnl || 0);
      }
      if (pnl <= -limit) {
        eventBus.log('WARN', `Strategy ${strat.name} breached per-strategy loss limit (₹${pnl.toFixed(0)} ≤ -₹${limit}) — closing legs`, 'autonomy');
        await pushStrategyExit(strat, positions, this.market);
        await updatePaperStrategyStatus(strat.id, 'STOPPED');
        eventBus.emit('alert', { level: 'ERROR', source: 'autonomy', msg: `Strategy ${strat.name} stopped: loss ₹${pnl.toFixed(0)} breached limit ₹${limit}` });
        await this.publishPortfolioSnapshot();
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
      try {
        await closePaperPosition(pos.tradingSymbol, ltp);
        closed++;
      } catch (e: any) {
        eventBus.log('ERROR', `Square-off failed for ${pos.tradingSymbol}: ${e.message}`, 'autonomy');
      }
    }
    // Stop all running strategies.
    for (const s of await listPaperStrategies()) {
      if (s.status === 'RUNNING') await updatePaperStrategyStatus(s.id, 'STOPPED');
    }
    eventBus.log('TRADE', `Square-off complete: ${closed} position(s) closed (${reason})`, 'autonomy');
    eventBus.emit('alert', { level: 'WARN', source: 'autonomy', msg: `Square-off complete: ${closed} position(s) closed — ${reason}` });
    await this.publishPortfolioSnapshot();
    return closed;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsubBus.forEach((u) => u());
  }
}

async function pushStrategyExit(strat: any, positions: any[], market: MarketDataService): Promise<void> {
  for (const leg of strat.legs || []) {
    const pos = positions.find((p) => p.tradingSymbol === leg.instrument);
    if (pos && pos.netQty !== 0) {
      const ltp = market.getLtp(String(pos.securityId)) || pos.ltp;
      await closePaperPosition(leg.instrument, ltp).catch(() => {});
    }
  }
}
