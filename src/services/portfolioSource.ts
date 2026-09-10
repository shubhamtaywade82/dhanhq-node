import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { journal } from './journal';
import type { FillKind } from './fillModel';
import { redisPublisher } from '../auth';
import {
  listPaperPositions, getPaperWallet, markPositionsToMarket,
  closePaperPosition, closeAllPaperPositions, getTodayOrderStats as getPaperTodayOrderStats,
} from '../db';
import { marketClock } from './marketHours';
import { buildSandboxPlaceRequest, roundToTick } from './sandboxInstruments';

/**
 * Normalizes RiskEngine's and AutonomyEngine's view of "the account" across
 * paper and live trading modes, closing the gap named LIVE-01: before this
 * abstraction existed, both engines called the paper db.ts functions
 * UNCONDITIONALLY regardless of TRADING_MODE — in live mode the daily-loss
 * breaker read an empty paper wallet (₹0), EOD square-off closed paper
 * positions while real ones stayed open, and the kill switch's
 * "positions closed" count was fabricated from an empty paper book. That is
 * why core.ts refuses to boot in live mode until this exists.
 *
 * NormalizedPosition mirrors the DhanHQ v2 PositionResponse field names
 * (buyQty/buyAvg/sellQty/sellAvg/netQty/realizedProfit/unrealizedProfit) —
 * the paper engine's own shape was already modelled on it, so both sources
 * produce the same shape with no lossy translation either direction.
 *
 * IMPORTANT — broker P&L semantics are asserted from the SDK's TYPE
 * DECLARATIONS, not verified against a live DhanHQ account (this
 * environment has no broker credentials or market access to confirm real
 * runtime behavior). Two assumptions a reviewer with real account access
 * should verify before this runs against real capital:
 *   1. That a position flattened intraday still appears in
 *      positions.list() with netQty=0 and realizedProfit populated for the
 *      rest of the trading day (this is standard broker behavior and is
 *      how the paper engine's own mem.positions already works, but it is
 *      NOT independently confirmed against DhanHQ specifically here).
 *   2. That FundLimitResponse.utilizedAmount is a fair stand-in for
 *      "margin currently blocked" for the daily-loss/margin-utilization
 *      breakers — DhanHQ's fund-limit endpoint does not report a
 *      dedicated realized-P&L figure, so session P&L for live mode is
 *      DERIVED by summing positions[].realizedProfit, not read from a
 *      single authoritative field the way the paper wallet's
 *      session_realized_base is.
 */

export interface NormalizedPosition {
  tradingSymbol: string;
  securityId: string;
  exchangeSegment: string;
  productType: string;
  buyQty: number;
  buyAvg: number;
  sellQty: number;
  sellAvg: number;
  netQty: number;
  realizedProfit: number;
  unrealizedProfit: number;
  pnl: number;
  costPrice: number;
  ltp: number;
  marginBlocked: number;
  stopLoss: number | null;
  target: number | null;
  trailingStop: number | null;
  /** Sourced from DhanHQ's own drvStrikePrice/drvOptionType (broker mode
   * only — paper positions leave these null; consumers needing an option's
   * strike/side fall back to parsing the synthesized tradingSymbol, which
   * only paper mode's format supports). Prefer these over parsing
   * tradingSymbol wherever available: a real DhanHQ trading symbol's exact
   * string format is not the synthesized "<UNDERLYING><STRIKE><CE|PE>"
   * shape the paper engine invents, so a regex built for the latter
   * silently matches nothing against a real broker symbol. */
  strike: number | null;
  optionType: 'CALL' | 'PUT' | null;
}

export interface WalletSnapshot {
  availableMargin: number;
  usedMargin: number;
  realizedPnl: number;
  sessionRealizedPnl: number;
  unrealizedPnl: number;
  totalCharges: number;
  netRealizedPnl: number;
  totalBalance: number;
  equity: number;
}

export interface CloseResult {
  status: 'TRADED' | 'REJECTED' | 'noop';
  symbol?: string;
  orderId?: string;
  fillPrice?: number;
  reason?: string;
  [key: string]: any;
}

export type LtpResolver = (securityId: string, symbol: string) => number | null;

export interface OrderFlowStats {
  total: number;
  filled: number;
  rejected: number;
  consecutiveLosses: number;
}

export interface PortfolioSource {
  readonly kind: 'paper' | 'broker';
  getPositions(): Promise<NormalizedPosition[]>;
  getWallet(): Promise<WalletSnapshot>;
  /** Feeds the Order Rejection Rate and Consecutive Losses breakers. Paper
   * already derives this from db.ts's own order log — PaperPortfolioSource
   * delegates there. Broker mode has no equivalent server-side report
   * (DhanHQ's position/funds APIs don't track "was my last order
   * rejected" or a loss streak), so BrokerPortfolioSource builds its own:
   * recordOrderOutcome() (called by LiveExecutionEngine) tallies total/
   * rejected directly, and consecutiveLosses is inferred by diffing
   * realizedProfit across successive position polls — see its docstring
   * for the disclosed limitation that gives it. */
  getTodayOrderStats(): Promise<OrderFlowStats>;
  recordOrderOutcome(outcome: { status: 'TRADED' | 'REJECTED' }): void;
  /** Paper: marks open positions from live ticks. Broker: the account's
   * own unrealizedProfit is already server-computed from real prices, so
   * this just forces a fresh poll rather than doing any local math. */
  markToMarket(ltpResolver: LtpResolver): Promise<{ totalUnrealized: number; staleCount: number }>;
  closePosition(symbol: string, priceHint?: number, kind?: FillKind, quantity?: number): Promise<CloseResult>;
  closeAll(ltpResolver: LtpResolver): Promise<CloseResult[]>;
  /** Forces the next read to bypass any internal cache. Paper mode's mem
   * reads are always current, so this is a no-op there; BrokerPortfolioSource
   * uses it to force a fresh poll right after a fill changes the account —
   * see its own docstring for why that matters. */
  invalidate(): void;
}

// ── paper ────────────────────────────────────────────────────────────────

/** Thin wrapper over the existing db.ts paper functions — zero behavior
 * change versus calling them directly, which is what every caller did
 * before this abstraction existed. */
export class PaperPortfolioSource implements PortfolioSource {
  readonly kind = 'paper' as const;

  async getPositions(): Promise<NormalizedPosition[]> {
    return listPaperPositions() as unknown as Promise<NormalizedPosition[]>;
  }

  async getWallet(): Promise<WalletSnapshot> {
    return getPaperWallet();
  }

  async getTodayOrderStats(): Promise<OrderFlowStats> {
    return getPaperTodayOrderStats();
  }

  /** No-op: db.ts's executePaperOrder already writes every fill/rejection
   * to mem.orders itself — getTodayOrderStats() reads that directly, so
   * paper mode has nothing extra to record here. */
  recordOrderOutcome(): void { /* see docstring */ }

  async markToMarket(ltpResolver: LtpResolver) {
    return markPositionsToMarket(ltpResolver);
  }

  async closePosition(symbol: string, priceHint?: number, kind?: FillKind, _quantity?: number): Promise<CloseResult> {
    return closePaperPosition(symbol, priceHint, undefined, kind) as unknown as Promise<CloseResult>;
  }

  async closeAll(ltpResolver: LtpResolver): Promise<CloseResult[]> {
    return closeAllPaperPositions(ltpResolver) as unknown as Promise<CloseResult[]>;
  }

  /** No-op: mem is always current, there is no cache to invalidate. */
  invalidate(): void { /* see docstring */ }
}

// ── broker ───────────────────────────────────────────────────────────────

function normalizeBrokerPosition(p: any): NormalizedPosition {
  const netQty = Number(p.netQty ?? 0);
  const buyAvg = Number(p.buyAvg ?? 0);
  const sellAvg = Number(p.sellAvg ?? 0);
  const realized = Number(p.realizedProfit ?? 0);
  const unrealized = Number(p.unrealizedProfit ?? 0);
  return {
    tradingSymbol: String(p.tradingSymbol ?? '').toUpperCase(),
    securityId: String(p.securityId ?? '0'),
    exchangeSegment: String(p.exchangeSegment ?? 'NSE_FNO'),
    productType: String(p.productType ?? 'INTRADAY'),
    buyQty: Number(p.buyQty ?? 0),
    buyAvg,
    sellQty: Number(p.sellQty ?? 0),
    sellAvg,
    netQty,
    realizedProfit: realized,
    unrealizedProfit: unrealized,
    pnl: realized + unrealized,
    costPrice: Number(p.costPrice ?? (netQty >= 0 ? buyAvg : sellAvg)),
    // DhanHQ's PositionResponse doesn't carry a live LTP field directly —
    // it's derived from cost + unrealized/netQty, the same relationship
    // the paper engine's own listPaperPositions() uses.
    ltp: netQty !== 0 ? Number((netQty > 0 ? buyAvg : sellAvg) + unrealized / netQty).valueOf() : Number(p.costPrice ?? 0),
    marginBlocked: 0, // not reported per-position by DhanHQ; wallet-level utilizedAmount covers the breaker's actual need
    // DhanHQ positions carry no local stop/target/trailing-stop config —
    // that protection lives entirely in PositionMonitor for both modes.
    stopLoss: null,
    target: null,
    trailingStop: null,
    strike: p.drvStrikePrice != null ? Number(p.drvStrikePrice) : null,
    optionType: p.drvOptionType === 'CALL' || p.drvOptionType === 'PUT' ? p.drvOptionType : null,
  };
}

function emptyWallet(): WalletSnapshot {
  return { availableMargin: 0, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0, unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: 0, equity: 0 };
}

/**
 * Polls the real DhanHQ account on a fixed cadence (default 3s — the same
 * order of magnitude as the market-data REST fallback poll elsewhere in
 * this codebase) rather than on every caller, since RiskEngine.evaluate()
 * runs on every tick/fill plus a 5s timer and would otherwise hammer the
 * account/positions endpoints far past any sane rate limit. Concurrent
 * callers during a poll share the one in-flight request rather than each
 * starting their own.
 *
 * A failed poll serves the last-known snapshot rather than throwing —
 * matching the read-degrades-gracefully posture of getFillablePrice() and
 * the REST market-data fallback — and marks `degraded` so a caller that
 * cares (the broker reconciler, /api/health) can tell freshness from
 * failure.
 */
export class BrokerPortfolioSource implements PortfolioSource {
  readonly kind = 'broker' as const;
  private client: DhanClient;
  private pollIntervalMs: number;
  private cachedPositions: NormalizedPosition[] = [];
  private cachedWallet: WalletSnapshot = emptyWallet();
  // lastPollAt: last SUCCESSFUL refresh (what isDegraded()/lastPolledAt()
  // report freshness against). lastAttemptAt: last time a poll was
  // ATTEMPTED, successful or not — this is what ensureFresh() throttles on.
  // Splitting these matters: a broker outage or a 429 would otherwise leave
  // lastPollAt frozen at its last success forever, permanently defeating the
  // throttle (Date.now() - lastPollAt < pollIntervalMs never re-becomes
  // true) and turning every subsequent tick into a fresh positions.list()/
  // funds.getLimit() call — exactly the hammering this class exists to
  // prevent, and self-sustaining under a rate limit.
  private lastPollAt = 0;
  private lastAttemptAt = 0;
  private pollPromise: Promise<void> | null = null;
  private degraded = false;

  // Order-flow tracking (see PortfolioSource.getTodayOrderStats docstring):
  // total/rejected come from recordOrderOutcome() calls the execution
  // engine makes directly; consecutiveLosses is INFERRED by diffing
  // realizedProfit across successive polls, since DhanHQ's APIs report
  // position state, not a fill-by-fill P&L history. Day-scoped like every
  // other session figure in this codebase.
  private statsDate = '';
  private orderTotal = 0;
  private orderRejected = 0;
  private consecutiveLosses = 0;
  private realizedProfitBySymbol = new Map<string, number>();

  constructor(client: DhanClient, pollIntervalMs = 3000) {
    this.client = client;
    this.pollIntervalMs = pollIntervalMs;
  }

  private rollStatsIfNewDay(): void {
    const today = marketClock().istDate;
    if (this.statsDate === today) return;
    this.statsDate = today;
    this.orderTotal = 0;
    this.orderRejected = 0;
    this.consecutiveLosses = 0;
    // Deliberately NOT cleared: realizedProfitBySymbol. A position carried
    // over a day boundary still needs its LAST KNOWN realizedProfit as the
    // diff baseline for the next poll — clearing it would read the
    // position's entire multi-day realized total as "since the last poll"
    // on the first poll of the new day, one giant false loss/gain signal.
  }

  isDegraded(): boolean { return this.degraded; }
  lastPolledAt(): number { return this.lastPollAt; }

  /** Forces the NEXT read to poll rather than serve the cache, regardless
   * of how recently the last poll ran. Used right after a live fill: the
   * cached snapshot from before the fill doesn't yet contain the new/
   * changed position, and reconcileMonitor/reconcileUnmanagedLivePositions
   * (autonomy.ts) would otherwise judge PositionMonitor's already-updated
   * tracked set against that stale snapshot and "correct" a position that
   * is not actually orphaned — untracking it, then on the following cycle
   * flattening it and arming the kill switch as an "unmanaged" position. */
  invalidate(): void {
    this.lastAttemptAt = 0;
  }

  private async ensureFresh(force = false): Promise<void> {
    // Checked BEFORE the throttle: poll() sets lastAttemptAt synchronously
    // as its very first statement, so a concurrent caller arriving while a
    // poll is already in flight would otherwise see "an attempt just
    // started" and bail out early serving the STALE pre-poll cache, instead
    // of dedup-ing onto the in-flight request like it's supposed to.
    if (this.pollPromise) return this.pollPromise;
    if (!force && Date.now() - this.lastAttemptAt < this.pollIntervalMs) return;
    this.pollPromise = this.poll().finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  private async poll(): Promise<void> {
    this.lastAttemptAt = Date.now();
    try {
      const [positionsRes, fundsRes] = await Promise.all([
        this.client.positions.list(),
        this.client.funds.getLimit(),
      ]);
      const positions = (positionsRes || []).map(normalizeBrokerPosition);
      this.detectClosesFromRealizedDiff(positions);
      const sessionRealizedPnl = positions.reduce((s, p) => s + p.realizedProfit, 0);
      const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedProfit, 0);
      const availableMargin = Number((fundsRes as any)?.availabelBalance ?? 0);
      const usedMargin = Number((fundsRes as any)?.utilizedAmount ?? 0);
      this.cachedPositions = positions;
      this.cachedWallet = {
        availableMargin,
        usedMargin,
        // Live mode has no separate "lifetime" realized figure the way the
        // paper wallet does (initial_balance + accumulated realized_pnl) —
        // DhanHQ reports account balance, not a running P&L ledger. Both
        // fields report the same session-derived number here; a caller
        // wanting genuine lifetime P&L in live mode needs the broker's
        // ledger/statement API, out of scope for the risk gate's needs.
        realizedPnl: sessionRealizedPnl,
        sessionRealizedPnl,
        unrealizedPnl,
        totalCharges: 0, // not separately reported by getLimit(); charges are already netted into realizedProfit
        netRealizedPnl: sessionRealizedPnl,
        totalBalance: availableMargin + usedMargin,
        equity: Number((availableMargin + usedMargin + unrealizedPnl).toFixed(2)),
      };
      this.lastPollAt = Date.now();
      this.degraded = false;
    } catch (e: any) {
      this.degraded = true;
      eventBus.log('WARN', `Broker portfolio poll failed: ${e.message} — serving last-known snapshot`, 'portfolio_source');
    }
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    await this.ensureFresh();
    if (this.brokerMode() === 'sandbox' && this.cachedPositions.length === 0) {
      return listPaperPositions() as unknown as Promise<NormalizedPosition[]>;
    }
    return this.cachedPositions;
  }

  async getWallet(): Promise<WalletSnapshot> {
    await this.ensureFresh();
    return this.cachedWallet;
  }

  /** Compares this poll's realizedProfit per symbol against the last poll's
   * to infer a close that happened between them, incrementing or resetting
   * the consecutive-loss streak. DISCLOSED LIMITATION: this only detects
   * closes at POLL granularity (default 3s) — two losing closes inside the
   * same poll window are indistinguishable from one, and their combined
   * realized delta is still correctly negative, so this under-counts the
   * NUMBER of losses in that rare case without misjudging their direction. */
  private detectClosesFromRealizedDiff(positions: NormalizedPosition[]): void {
    this.rollStatsIfNewDay();
    for (const p of positions) {
      const prev = this.realizedProfitBySymbol.get(p.tradingSymbol);
      if (prev !== undefined) {
        const delta = p.realizedProfit - prev;
        if (delta < 0) this.consecutiveLosses++;
        else if (delta > 0) this.consecutiveLosses = 0;
        // delta === 0: nothing closed since the last poll — streak unchanged.
      }
      this.realizedProfitBySymbol.set(p.tradingSymbol, p.realizedProfit);
    }
  }

  async getTodayOrderStats(): Promise<OrderFlowStats> {
    this.rollStatsIfNewDay();
    return {
      total: this.orderTotal,
      filled: this.orderTotal - this.orderRejected,
      rejected: this.orderRejected,
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  /** Called by LiveExecutionEngine right after every order outcome —
   * DhanHQ's account APIs report position/fund STATE, not a log of this
   * app's own order attempts, so nothing else can build the rejection-rate
   * breaker's input in live mode. */
  recordOrderOutcome(outcome: { status: 'TRADED' | 'REJECTED' }): void {
    this.rollStatsIfNewDay();
    this.orderTotal++;
    if (outcome.status === 'REJECTED') this.orderRejected++;
  }

  async markToMarket(ltpResolver: LtpResolver): Promise<{ totalUnrealized: number; staleCount: number }> {
    if (this.brokerMode() === 'sandbox') {
      await this.ensureFresh();
      const mark = await markPositionsToMarket(ltpResolver);
      if (this.cachedPositions.length === 0) {
        this.cachedPositions = (await listPaperPositions()) as unknown as NormalizedPosition[];
      }
      this.cachedWallet.unrealizedPnl = mark.totalUnrealized;
      this.cachedWallet.equity = Number((this.cachedWallet.totalBalance + mark.totalUnrealized).toFixed(2));
      return mark;
    }
    await this.ensureFresh();
    return { totalUnrealized: this.cachedWallet.unrealizedPnl, staleCount: this.degraded ? this.cachedPositions.length : 0 };
  }

  private async findOpenPosition(symbol: string): Promise<NormalizedPosition | undefined> {
    const sym = symbol.toUpperCase();
    const positions = await this.getPositions();
    return positions.find((p) => p.tradingSymbol === sym && p.netQty !== 0);
  }

  /** Places a REAL reversing MARKET order — no priceHint/kind: a market
   * order lets the broker fill at its own best price, which is more
   * correct for real capital than forcing a specific price the way the
   * paper fill model does. */
  private brokerMode(): 'sandbox' | 'live' {
    return process.env.TRADING_MODE === 'sandbox' ? 'sandbox' : 'live';
  }

  private async reversePosition(pos: NormalizedPosition, reason: string, quantity?: number): Promise<CloseResult> {
    const transactionType = pos.netQty > 0 ? 'SELL' : 'BUY';
    const qty = Math.min(quantity ?? Math.abs(pos.netQty), Math.abs(pos.netQty));
    const correlationId = `c_${pos.securityId || pos.tradingSymbol}_${Date.now().toString(36)}`.slice(0, 25);
    const mode = this.brokerMode();

    journal.append('order_intent', {
      correlation_id: correlationId, mode,
      params: { security_id: pos.securityId, quantity: qty, transaction_type: transactionType, exchange_segment: pos.exchangeSegment, product_type: pos.productType },
    });

    try {
      const fallbackPrice = pos.costPrice || pos.buyAvg || pos.sellAvg || 100;
      const limitPrice = roundToTick(pos.ltp > 0 ? pos.ltp : fallbackPrice, 5);
      const placeReq = mode === 'sandbox'
        ? buildSandboxPlaceRequest({
          correlationId, securityId: pos.securityId, exchangeSegment: pos.exchangeSegment,
          transactionType, orderType: 'MARKET', quantity: qty, price: limitPrice, productType: pos.productType,
        })
        : {
          correlationId, securityId: pos.securityId, exchangeSegment: pos.exchangeSegment as any,
          transactionType: transactionType as any, orderType: 'MARKET' as any, quantity: qty, price: 0,
          productType: pos.productType as any,
        };
      const placed: any = await this.client.orders.place(placeReq);
      const orderId = placed?.data?.orderId ?? placed?.orderId;
      const settled: any = orderId ? await this.client.orders.getById(orderId).catch(() => placed?.data ?? placed) : placed?.data ?? placed;
      const fillPrice = Number(settled?.averagePrice ?? settled?.price ?? 0) || undefined;

      const fillPayload = {
        correlation_id: correlationId, mode, is_paper: false, symbol: pos.tradingSymbol,
        security_id: pos.securityId, quantity: qty, transaction_type: transactionType,
        order_id: orderId, fill_price: fillPrice, filled_at: new Date().toISOString(), reason,
      };
      eventBus.log('TRADE', `Broker close ${transactionType} ${qty} ${pos.tradingSymbol} (${reason})`, 'portfolio_source');
      eventBus.emit('order', { kind: 'fill', ...fillPayload });
      journal.append('order_result', { status: 'TRADED', ...fillPayload });
      redisPublisher.publish('dhan:execution:fills', JSON.stringify(fillPayload)).catch(() => {});

      if (mode === 'sandbox') {
        await closePaperPosition(pos.tradingSymbol, limitPrice, async () => 0, 'EXIT').catch(() => {});
      }

      this.invalidate();
      return { status: 'TRADED', symbol: pos.tradingSymbol, orderId, fillPrice };
    } catch (e: any) {
      eventBus.log('ERROR', `Broker close FAILED for ${pos.tradingSymbol}: ${e.message}`, 'portfolio_source');
      journal.append('order_result', { correlation_id: correlationId, status: 'REJECTED', reason: e.message, mode });
      return { status: 'REJECTED', symbol: pos.tradingSymbol, reason: e.message };
    }
  }

  async closePosition(symbol: string, _priceHint?: number, _kind?: FillKind, quantity?: number): Promise<CloseResult> {
    await this.ensureFresh(true);
    const pos = await this.findOpenPosition(symbol);
    if (!pos) return { status: 'noop', reason: 'No open position found', symbol };
    return this.reversePosition(pos, 'manual close', quantity);
  }

  async closeAll(_ltpResolver: LtpResolver): Promise<CloseResult[]> {
    await this.ensureFresh(true);
    const open = this.cachedPositions.filter((p) => p.netQty !== 0);
    const results: CloseResult[] = [];
    for (const pos of open) {
      results.push(await this.reversePosition(pos, 'square-off'));
    }
    return results;
  }
}
