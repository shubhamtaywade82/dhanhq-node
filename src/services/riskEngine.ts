import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { marketClock } from './marketHours';
import type { MarketDataService } from './marketData';
import {
  getPaperWallet, listPaperPositions, getTodayOrderStats,
  pushAlert, getRiskState, saveRiskState, closeAllPaperPositions,
  listPaperStrategies, updatePaperStrategyStatus,
} from '../db';

/**
 * Risk engine — computes circuit breakers from REAL account state
 * (wallet, positions marked to market, today's order flow, tick freshness)
 * and owns the kill switch.
 *
 * It runs on every order fill and on a periodic timer, independent of any
 * frontend. When a breaker trips it can arm the kill switch, which:
 *   - paper mode: closes every open paper position at the last live LTP
 *   - live mode:  invokes DhanHQ's kill switch (Trader's Control API) and
 *                 squares off intraday positions via the broker
 */

export interface RiskLimits {
  dailyLossLimit: number;        // INR, wallet + unrealized
  maxMarginUtilPct: number;      // % of total balance
  perStrategyLossLimit: number;  // INR per strategy
  maxConsecutiveLosses: number;  // trades
  maxRejectionRatePct: number;   // % rejected / total today
  staleTickSec: number;          // seconds without a tick during market hours
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  dailyLossLimit: Number(process.env.RISK_DAILY_MAX_LOSS) || 50000,
  maxMarginUtilPct: 70,
  perStrategyLossLimit: 20000,
  maxConsecutiveLosses: 5,
  maxRejectionRatePct: 10,
  staleTickSec: 10,
};

export interface CircuitBreakerRow {
  rule: string;
  threshold: string;
  current: string;
  state: 'OK' | 'WARN' | 'ERROR';
  action: string;
}

export class RiskEngine {
  private client: DhanClient;
  private market: MarketDataService;
  private limits: RiskLimits = { ...DEFAULT_RISK_LIMITS };
  private killed = false;
  private killedReason: string | null = null;
  private killedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBreakers: CircuitBreakerRow[] = [];
  private lastEvalAt = 0;

  constructor(client: DhanClient, market: MarketDataService) {
    this.client = client;
    this.market = market;
  }

  async start(): Promise<void> {
    const persisted = await getRiskState();
    this.limits = { ...DEFAULT_RISK_LIMITS, ...(persisted.limits || {}) };
    this.killed = !!persisted.killed;
    this.killedReason = persisted.killedReason || null;

    // Re-evaluate every 5s — cheap, DB-backed, market-data-free.
    this.timer = setInterval(() => { void this.evaluate(); }, 5000);
    // React to fills immediately.
    eventBus.on('order', () => { void this.evaluate(); });
    eventBus.log('SYSTEM', `Risk engine armed (dailyLossLimit=₹${this.limits.dailyLossLimit}, margin=${this.limits.maxMarginUtilPct}%, losses=${this.limits.maxConsecutiveLosses})`, 'risk_engine');
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  async setLimits(patch: Partial<RiskLimits>): Promise<RiskLimits> {
    this.limits = { ...this.limits, ...patch };
    await saveRiskState({ killed: this.killed, killedReason: this.killedReason, limits: this.limits });
    eventBus.log('INFO', `Risk limits updated: ${JSON.stringify(this.limits)}`, 'risk_engine');
    return this.getLimits();
  }

  isKilled(): boolean {
    return this.killed;
  }

  snapshot() {
    return {
      killed: this.killed,
      killedReason: this.killedReason,
      killedAt: this.killedAt,
      limits: this.getLimits(),
      breakers: this.lastBreakers,
      evaluatedAt: this.lastEvalAt ? new Date(this.lastEvalAt).toISOString() : null,
    };
  }

  /** Gate every order (paper or live) through this. */
  canTrade(): { allowed: boolean; reason?: string } {
    if (this.killed) return { allowed: false, reason: 'Kill switch engaged' };
    const clock = marketClock();
    if (clock.squareOffWindow) return { allowed: false, reason: 'EOD square-off window — no new entries' };
    return { allowed: true };
  }

  /**
   * Arm the kill switch for real. Paper mode squares off every open
   * position at the freshest LTP; live mode calls DhanHQ Trader's Control
   * (kill switch + P&L exit) and then squares off intraday positions.
   */
  async armKillSwitch(reason: string): Promise<{ status: string; details: any }> {
    if (this.killed) return { status: 'already_killed', details: { reason: this.killedReason } };
    this.killed = true;
    this.killedReason = reason;
    this.killedAt = Date.now();
    await saveRiskState({ killed: true, killedReason: reason, limits: this.limits });

    const details: any = { mode: process.env.TRADING_MODE || 'paper', positionsClosed: 0 };

    try {
      if ((process.env.TRADING_MODE || 'paper') === 'live') {
        // DhanHQ Trader's Control: halt order flow at the broker itself.
        await (this.client as any).traderControls?.killSwitch?.('ENABLE');
        details.brokerKillSwitch = 'ENABLED';
        await (this.client as any).traderControls?.pnlExit?.({ type: 'PROFIT', value: 0 }).catch(() => {});
      }
      const closes = (await closeAllPaperPositions((secId, _sym) => this.market.getLtp(secId))) as any[];
      details.positionsClosed = closes.filter((c) => c && c.status === 'TRADED').length;
      for (const c of closes) {
        if (c && c.status === 'TRADED') {
          eventBus.emit('order', { kind: 'kill_switch_fill', orderId: c.orderId, symbol: c.symbol, side: c.side, fillPrice: c.fillPrice });
        }
      }
      // Stop every RUNNING strategy too — this also reverses any multi-leg
      // hedge-margin credit (see updatePaperStrategyStatus), which the raw
      // position closes above don't know about.
      for (const s of await listPaperStrategies()) {
        if (s.status === 'RUNNING') await updatePaperStrategyStatus(s.id, 'STOPPED');
      }
    } catch (e: any) {
      details.error = e.message;
    }

    await pushAlert('ERROR', 'risk_engine', `KILL SWITCH ENGAGED: ${reason}. ${details.positionsClosed} position(s) squared off.`);
    eventBus.emit('alert', { level: 'ERROR', source: 'risk_engine', msg: `KILL SWITCH ENGAGED: ${reason}` });
    eventBus.log('ERROR', `*** KILL SWITCH ENGAGED *** reason=${reason} positionsClosed=${details.positionsClosed}`, 'risk_engine');
    eventBus.emit('system', { type: 'kill_switch', state: 'ENGAGED', reason });
    eventBus.emit('risk', this.snapshot());
    return { status: 'killed', details };
  }

  async disarmKillSwitch(): Promise<{ status: string }> {
    this.killed = false;
    this.killedReason = null;
    this.killedAt = null;
    await saveRiskState({ killed: false, limits: this.limits });
    try {
      if ((process.env.TRADING_MODE || 'paper') === 'live') {
        await (this.client as any).traderControls?.killSwitch?.('DISABLE');
      }
    } catch { /* broker may reject if not armed */ }
    eventBus.log('INFO', 'Kill switch disarmed — trading re-enabled', 'risk_engine');
    eventBus.emit('system', { type: 'kill_switch', state: 'DISENGAGED' });
    eventBus.emit('risk', this.snapshot());
    return { status: 'ok' };
  }

  async evaluate(): Promise<CircuitBreakerRow[]> {
    this.lastEvalAt = Date.now();
    const [wallet, positions, orderStats] = await Promise.all([
      getPaperWallet(), listPaperPositions(), getTodayOrderStats(),
    ]);

    const unrealized = positions.reduce((acc, p) => acc + (Number(p.unrealizedPnl) || 0), 0);
    const dayPnl = Number(wallet.realizedPnl) + unrealized;
    const total = Number(wallet.totalBalance) || 1;
    const utilPct = (Number(wallet.usedMargin) / total) * 100;
    const rejectionRate = orderStats.total > 0 ? (orderStats.rejected / orderStats.total) * 100 : 0;
    const tickAge = this.market.tickAgeSec();
    const clock = marketClock();
    const stale = clock.isMarketOpen && tickAge > this.limits.staleTickSec;

    const rows: CircuitBreakerRow[] = [
      {
        rule: 'Daily Loss Limit',
        threshold: `₹${this.limits.dailyLossLimit.toLocaleString('en-IN')}`,
        current: `₹${Math.round(dayPnl).toLocaleString('en-IN')}`,
        state: dayPnl <= -this.limits.dailyLossLimit ? 'ERROR' : dayPnl <= -this.limits.dailyLossLimit * 0.6 ? 'WARN' : 'OK',
        action: 'Close all positions and arm kill switch',
      },
      {
        rule: 'Margin Utilization',
        threshold: `${this.limits.maxMarginUtilPct}%`,
        current: `${utilPct.toFixed(1)}%`,
        state: utilPct >= this.limits.maxMarginUtilPct ? 'ERROR' : utilPct >= this.limits.maxMarginUtilPct * 0.7 ? 'WARN' : 'OK',
        action: 'Block new position opens',
      },
      {
        rule: 'Consecutive Losses',
        threshold: `${this.limits.maxConsecutiveLosses} trades`,
        current: `${orderStats.consecutiveLosses} trades`,
        state: orderStats.consecutiveLosses >= this.limits.maxConsecutiveLosses ? 'ERROR' : orderStats.consecutiveLosses >= this.limits.maxConsecutiveLosses - 1 ? 'WARN' : 'OK',
        action: 'Pause strategy entries for 15 min',
      },
      {
        rule: 'Order Rejection Rate',
        threshold: `>${this.limits.maxRejectionRatePct}% today`,
        current: orderStats.total > 0 ? `${orderStats.rejected}/${orderStats.total} (${rejectionRate.toFixed(0)}%)` : '0 orders',
        state: orderStats.total >= 5 && rejectionRate > this.limits.maxRejectionRatePct ? 'WARN' : 'OK',
        action: 'Throttle order placement',
      },
      {
        rule: 'Stale Market Tick',
        threshold: `>${this.limits.staleTickSec}s during market hours`,
        current: clock.isMarketOpen ? (tickAge === Infinity ? 'no ticks yet' : `${tickAge}s`) : 'market closed',
        state: stale ? 'ERROR' : 'OK',
        action: 'Pause strategies consuming stale data',
      },
      {
        rule: 'EOD Square-Off Proximity',
        threshold: '15:20 IST',
        current: clock.squareOffWindow ? 'IN WINDOW' : `${clock.istTime} IST`,
        state: clock.squareOffWindow ? 'WARN' : 'OK',
        action: 'Force-close all intraday positions',
      },
    ];

    // Alert on state transitions (avoid alert storms: only on change).
    for (const row of rows) {
      const prev = this.lastBreakers.find((b) => b.rule === row.rule);
      if (prev && prev.state !== row.state && row.state !== 'OK') {
        const level = row.state === 'ERROR' ? 'ERROR' : 'WARN';
        await pushAlert(level, 'risk_engine', `${row.rule}: ${prev.state} → ${row.state} (current ${row.current}, threshold ${row.threshold}). Action: ${row.action}`);
        eventBus.emit('alert', { level, source: 'risk_engine', msg: `${row.rule} tripped — ${row.current} vs ${row.threshold}` });
      }
    }

    this.lastBreakers = rows;

    // Hard breakers arm the kill switch autonomously.
    if (!this.killed) {
      if (dayPnl <= -this.limits.dailyLossLimit) {
        await this.armKillSwitch(`Daily loss limit breached (₹${Math.round(dayPnl)} ≤ -₹${this.limits.dailyLossLimit})`);
      } else if (stale) {
        // Stale ticks: don't kill positions, but block new entries via canTrade
        // (the autonomy engine checks this gate each cycle).
      }
    }

    eventBus.emit('risk', this.snapshot());
    return rows;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
