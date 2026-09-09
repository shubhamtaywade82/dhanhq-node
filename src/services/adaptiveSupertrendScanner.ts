import * as path from 'path';
import type { DhanClient, Candle } from '@nemesis-oss/dhanhq-sdk';
import { supertrend } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { INDEX_INSTRUMENTS, type MarketDataService } from './marketData';
import { nearestIndexExpiry } from './marketHours';
import type { RiskEngine } from './riskEngine';

/** Shared by paper, sandbox, and live engines — kept local to avoid a core import cycle. */
export type ScannerExecutionEngine = { placeOrder(intent: any): Promise<any> };
import { MAX_CONCURRENT_POSITIONS } from './autonomy';
import { listPaperPositions, createPaperStrategy } from '../db';
import type { PortfolioSource } from './portfolioSource';
import { buildAdaptiveSupertrendStrategy } from './strategyConstructor';
import { CandleStore } from './adaptiveSupertrendCandles';
import { extractMarketFeatures, formatRegimeKey, AdaptiveParameterAI, FuzzySignalAI, type AdaptiveSignal } from './adaptiveSupertrend';

// NIFTY/SENSEX scanned first — evaluateOne() below stops opening new
// positions once MAX_CONCURRENT_POSITIONS is hit, so scan order is
// priority order under a full slot table, not just cosmetic.
const WATCHLIST_ALL = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];

function watchlist(): string[] {
  if (process.env.TRADING_MODE === 'sandbox') {
    return WATCHLIST_ALL.filter((s) => s !== 'SENSEX'); // BSE FNO not supported in Dhan sandbox
  }
  return WATCHLIST_ALL;
}
const SCAN_INTERVAL_MS = Number(process.env.ADAPTIVE_SUPERTREND_SCAN_INTERVAL_MS) || 60_000;
// A 2%-move directional return normalizes to a full-magnitude Q-learning
// reward — matches the source strategy's reward scale exactly.
const REWARD_NORMALIZATION_RETURN = 0.02;
const FIVE_MIN_SUPERTREND_PARAMS = { period: 10, multiplier: 3 }; // fixed SDK defaults, not Q-learning-controlled — see class doc

type EntryMode = 'crossover' | 'continuation' | 'both';

function entryMode(): EntryMode {
  const m = process.env.ADAPTIVE_SUPERTREND_ENTRY_MODE || 'both';
  return m === 'crossover' || m === 'continuation' || m === 'both' ? m : 'both';
}

interface PendingLearn {
  state: string;
  actionIndex: number;
  entryPrice: number;
  side: 'LONG' | 'SHORT';
  securityId: string;
}

export type SymbolProbe = {
  symbol: string;
  stage: string;
  candles1m: number;
  candles5m: number;
  dir1m: number | null;
  dir5m: number | null;
  freshCrossover: boolean;
  fuzzyAction?: string;
  fuzzyConfidence?: number;
  openLeg: boolean;
};

/**
 * Naked ATM CE/PE scanner: Q-learning picks the 1m Supertrend's
 * (atrPeriod, multiplier) per market regime. Two entry paths (see
 * ADAPTIVE_SUPERTREND_ENTRY_MODE):
 *   crossover    — 1m flips back INTO agreement with 5m (pullback ended)
 *   continuation — already aligned with 5m, fuzzy passes near the line
 *   both (default)— either path; continuation covers "aligned all session"
 *                   cases where the next 1m flip would oppose 5m.
 *
 * Deliberately does not set its own exit — every deployed leg is picked up
 * by LongOptionPositionManager (any long *_FNO position, no strategy
 * filter) on the very next autonomy cycle, which owns the "let runners
 * run" ratchet exit. This scanner only ever opens positions.
 */
export class AdaptiveSupertrendScanner {
  private candles: CandleStore;
  private paramAI: AdaptiveParameterAI;
  private signalAI = new FuzzySignalAI();
  private lastScanAt = 0;
  private pendingLearns = new Map<string, PendingLearn>();
  private openLeg = new Map<string, string>(); // symbol -> securityId
  private lastProcessedCandleTs = new Map<string, number>();
  /** One continuation entry per alignment episode — cleared when 1m != 5m. */
  private continuationUsed = new Set<string>();

  constructor(
    private client: DhanClient,
    private market: MarketDataService,
    private engine: ScannerExecutionEngine,
    private risk: RiskEngine,
    paramAI?: AdaptiveParameterAI, // test-only override — production epsilon-greedy exploration is inherently random
    private portfolio?: PortfolioSource,
  ) {
    this.candles = new CandleStore(client);
    this.paramAI = paramAI ?? new AdaptiveParameterAI({
      persistencePath: process.env.ADAPTIVE_SUPERTREND_QTABLE_PATH
        || path.resolve(__dirname, '../../data/adaptive_supertrend_qtable.json'),
    });
  }

  async evaluate(clock: { isMarketOpen: boolean; squareOffWindow: boolean }): Promise<void> {
    if (!clock.isMarketOpen || clock.squareOffWindow) return;
    if (Date.now() - this.lastScanAt < SCAN_INTERVAL_MS) return;
    const gate = this.risk.canTrade();
    if (!gate.allowed) return;

    const positions = await this.loadPositions();
    if (this.openPositionCount(positions) >= MAX_CONCURRENT_POSITIONS) return;

    this.lastScanAt = Date.now();
    for (const symbol of watchlist()) {
      try {
        await this.evaluateSymbol(symbol, positions);
      } catch (e: any) {
        eventBus.log('WARN', `Adaptive Supertrend scan failed for ${symbol}: ${e.message}`, 'adaptive_supertrend');
      }
    }
  }

  /** On-demand read of why each watchlist symbol is or isn't firing — no orders placed. */
  /** Prefetch today's index OHLCV for every watchlist symbol — called once
   * at boot so the first scan already has full-session 1m/5m history. */
  async warmup(): Promise<void> {
    for (const symbol of watchlist()) {
      const inst = INDEX_INSTRUMENTS[symbol];
      if (!inst) continue;
      try {
        await this.candles.refresh(symbol, inst.securityId);
      } catch (e: any) {
        eventBus.log('WARN', `Candle warmup failed for ${symbol}: ${e.message}`, 'adaptive_supertrend');
      }
    }
    eventBus.log('SYSTEM', 'Adaptive Supertrend candles warmed up (today intraday OHLCV)', 'adaptive_supertrend');
  }

  async probe(): Promise<{
    lastScanAt: number;
    nextScanInSec: number;
    scanIntervalSec: number;
    canTrade: boolean;
    tradeBlockReason?: string;
    openLegs: string[];
    symbols: SymbolProbe[];
  }> {
    const gate = this.risk.canTrade();
    const symbols: SymbolProbe[] = [];
    for (const symbol of watchlist()) {
      try {
        symbols.push(await this.probeSymbol(symbol));
      } catch (e: any) {
        symbols.push({ symbol, stage: `error: ${e.message}`, candles1m: 0, candles5m: 0, dir1m: null, dir5m: null, freshCrossover: false, openLeg: this.openLeg.has(symbol) });
      }
    }
    const nextMs = Math.max(0, SCAN_INTERVAL_MS - (Date.now() - this.lastScanAt));
    return {
      lastScanAt: this.lastScanAt,
      nextScanInSec: Math.round(nextMs / 1000),
      scanIntervalSec: Math.round(SCAN_INTERVAL_MS / 1000),
      canTrade: gate.allowed,
      tradeBlockReason: gate.reason,
      openLegs: [...this.openLeg.keys()],
      symbols,
    };
  }

  private async loadPositions(): Promise<any[]> {
    if (this.portfolio && this.portfolio.kind === 'broker') return this.portfolio.getPositions();
    return listPaperPositions();
  }

  private async probeSymbol(symbol: string): Promise<SymbolProbe> {
    const inst = INDEX_INSTRUMENTS[symbol];
    if (!inst) {
      return { symbol, stage: 'unknown_symbol', candles1m: 0, candles5m: 0, dir1m: null, dir5m: null, freshCrossover: false, openLeg: false };
    }
    await this.candles.refresh(symbol, inst.securityId);
    const oneMin = this.candles.getOneMinute(symbol);
    const fiveMin = this.candles.getFiveMinute(symbol);
    const base = { symbol, candles1m: oneMin.length, candles5m: fiveMin.length, dir1m: null as number | null, dir5m: null as number | null, freshCrossover: false, openLeg: this.openLeg.has(symbol) };
    if (this.openLeg.has(symbol)) return { ...base, stage: 'open_leg_pending_exit' };
    if (oneMin.length < 35) return { ...base, stage: `warming_up (${oneMin.length}/35 candles)` };

    if (!extractMarketFeatures(oneMin)) return { ...base, stage: 'no_features' };
    if (fiveMin.length < FIVE_MIN_SUPERTREND_PARAMS.period + 2) {
      return { ...base, stage: `5m_warming_up (${fiveMin.length}/${FIVE_MIN_SUPERTREND_PARAMS.period + 2} bars)` };
    }

    const gate = this.trendGate(symbol, oneMin);
    if (!gate) return { ...base, stage: 'no_trend' };
    base.dir1m = gate.dir1m;
    base.dir5m = gate.dir5m;
    base.freshCrossover = gate.freshCrossover;
    return { ...base, ...this.stageFromGate(symbol, gate) };
  }

  private async evaluateSymbol(symbol: string, positions: any[]): Promise<void> {
    const inst = INDEX_INSTRUMENTS[symbol];
    if (!inst) return;
    await this.candles.refresh(symbol, inst.securityId);
    await this.settlePendingLearn(symbol, positions);
    if (this.openLeg.has(symbol)) return;

    const oneMin = this.candles.getOneMinute(symbol);
    if (oneMin.length < 35) return;
    const latestTs = oneMin[oneMin.length - 1]!.timestamp;
    if (this.lastProcessedCandleTs.get(symbol) === latestTs) return;
    this.lastProcessedCandleTs.set(symbol, latestTs); // bar consumed either way from here

    const decision = this.computeSignal(symbol, oneMin);
    if (!decision || decision.signal.action === 'HOLD') return;
    const traded = await this.deploy(symbol, decision.signal, decision.state, decision.actionIndex, decision.currentPrice);
    if (traded) this.continuationUsed.add(symbol);
  }

  /** Regime -> trends -> crossover OR continuation -> fuzzy. Null = no act. */
  private computeSignal(symbol: string, oneMin: Candle[]): {
    signal: AdaptiveSignal; state: string; actionIndex: number; currentPrice: number;
  } | null {
    const gate = this.trendGate(symbol, oneMin);
    if (!gate) return null;
    const mode = entryMode();

    if ((mode === 'crossover' || mode === 'both') && gate.freshCrossover && gate.aligned) {
      const decision = this.decisionFromGate(gate, true);
      return decision?.signal.action === 'HOLD' ? null : decision;
    }

    if ((mode === 'continuation' || mode === 'both') && gate.aligned && !gate.freshCrossover && !this.continuationUsed.has(symbol)) {
      const decision = this.decisionFromGate(gate, false);
      return decision?.signal.action === 'HOLD' ? null : decision;
    }

    return null;
  }

  private trendGate(symbol: string, oneMin: Candle[]) {
    const features = extractMarketFeatures(oneMin);
    if (!features) return null;

    const { params, state, actionIndex } = this.paramAI.chooseAction(features);
    const st1m = supertrend(oneMin, { period: params.atrPeriod, multiplier: params.multiplier });
    const dir1m = st1m.direction[st1m.direction.length - 1];
    const prevDir1m = st1m.direction[st1m.direction.length - 2];
    if (dir1m == null || prevDir1m == null) return null;

    const fiveMin = this.candles.getFiveMinute(symbol);
    if (fiveMin.length < FIVE_MIN_SUPERTREND_PARAMS.period + 2) return null;
    const dir5m = supertrend(fiveMin, FIVE_MIN_SUPERTREND_PARAMS).direction.at(-1) ?? null;

    if (dir1m !== dir5m) this.continuationUsed.delete(symbol);
    const aligned = dir5m != null && dir1m === dir5m;
    const freshCrossover = dir1m !== prevDir1m;
    const currentPrice = oneMin[oneMin.length - 1]!.close;
    const supertrendValue = st1m.trend[st1m.trend.length - 1];
    if (supertrendValue == null) return null;

    return { features, params, state, actionIndex, dir1m, prevDir1m, dir5m, aligned, freshCrossover, currentPrice, supertrendValue };
  }

  private decisionFromGate(gate: NonNullable<ReturnType<AdaptiveSupertrendScanner['trendGate']>>, isCrossover: boolean) {
    const signal = this.signalAI.generateSignal({
      stDirection: gate.dir1m, isCrossover, features: gate.features, params: gate.params,
      currentPrice: gate.currentPrice, supertrendValue: gate.supertrendValue,
    });
    return { signal, state: gate.state, actionIndex: gate.actionIndex, currentPrice: gate.currentPrice };
  }

  private stageFromGate(symbol: string, gate: NonNullable<ReturnType<AdaptiveSupertrendScanner['trendGate']>>) {
    const mode = entryMode();
    const probe = (path: string, isCrossover: boolean) => {
      const signal = this.signalAI.generateSignal({
        stDirection: gate.dir1m, isCrossover, features: gate.features, params: gate.params,
        currentPrice: gate.currentPrice, supertrendValue: gate.supertrendValue,
      });
      if (signal.action === 'HOLD') {
        return { stage: `${path}_fuzzy_hold (${(signal.confidence * 100).toFixed(0)}%)`, fuzzyAction: signal.action, fuzzyConfidence: signal.confidence };
      }
      return { stage: `ready_${signal.action} via ${path}`, fuzzyAction: signal.action, fuzzyConfidence: signal.confidence };
    };

    if (gate.freshCrossover && !gate.aligned) {
      return { stage: 'crossover_opposes_5m — next flip exits alignment, no entry' };
    }
    if (gate.aligned && gate.freshCrossover && (mode === 'crossover' || mode === 'both')) {
      return probe('crossover', true);
    }
    if (gate.aligned && !gate.freshCrossover) {
      if (this.continuationUsed.has(symbol)) {
        return { stage: 'continuation_used — wait for 1m to break 5m then re-align' };
      }
      if (mode === 'continuation' || mode === 'both') return probe('continuation', false);
      return { stage: 'aligned — crossover-only mode waits for 1m flip into 5m' };
    }
    if (!gate.aligned) {
      return { stage: 'misaligned — wait for 1m flip that agrees with 5m' };
    }
    return { stage: 'no_entry' };
  }

  /** Settles the Q-learning reward for a symbol's prior entry once
   * LongOptionExitPolicy (or EOD/manual close) has flattened it — reward is
   * scored off spot movement, matching the source strategy's semantics: it
   * grades whether the regime-direction call on the underlying was right,
   * not the option premium P&L (theta/IV-dominated, would poison the signal). */
  private async settlePendingLearn(symbol: string, positions: any[]): Promise<void> {
    const pending = this.pendingLearns.get(symbol);
    if (!pending) return;
    if (this.isScannerLegOpen(pending, positions)) return;

    const oneMin = this.candles.getOneMinute(symbol);
    const currentSpot = oneMin.length > 0 ? oneMin[oneMin.length - 1]!.close : pending.entryPrice;
    const directionalReturn = pending.side === 'LONG'
      ? (currentSpot - pending.entryPrice) / pending.entryPrice
      : (pending.entryPrice - currentSpot) / pending.entryPrice;
    const reward = Math.max(-1, Math.min(1, directionalReturn / REWARD_NORMALIZATION_RETURN));

    const features = extractMarketFeatures(oneMin);
    this.paramAI.learn(pending.state, pending.actionIndex, reward, features ? formatRegimeKey(features) : undefined);

    this.pendingLearns.delete(symbol);
    this.openLeg.delete(symbol);
  }

  private async deploy(symbol: string, signal: AdaptiveSignal, state: string, actionIndex: number, spot: number): Promise<boolean> {
    const expiry = nearestIndexExpiry(symbol);
    const chain = await this.client.optionChain
      .fetchNormalized({ underlyingScrip: Number(INDEX_INSTRUMENTS[symbol]!.securityId), underlyingSeg: 'IDX_I', expiry })
      .catch(() => null);
    if (!chain?.strikes?.length) return false;

    const optionType = signal.action === 'OPEN_LONG' ? 'CE' : 'PE';
    const strat = buildAdaptiveSupertrendStrategy(symbol, spot, chain.strikes, expiry, 1, optionType);
    if (!strat) return false;
    const leg = strat.legs[0]!;

    // Ahead of the fill, not just after — placeOrder's own price resolution
    // needs the instrument already subscribed to have a live quote to fill
    // against (falls back to the leg's chain-snapshot price otherwise).
    this.market.addInstruments([{ securityId: leg.securityId, exchangeSegment: leg.exchangeSegment }]);

    const result: any = await this.engine.placeOrder({
      correlation_id: `${strat.id}_${leg.optionType}_${leg.strike}`,
      intent_id: `adaptive_supertrend_${symbol}`,
      params: {
        security_id: leg.securityId, symbol: leg.instrument, quantity: leg.qty,
        underlying: symbol, strike: leg.strike, option_type: leg.optionType, expiry,
        transaction_type: 'BUY', order_type: 'MARKET',
        exchange_segment: leg.exchangeSegment, product_type: 'INTRADAY', price: leg.price,
      },
      // No risk_limits — exits are fully owned by LongOptionExitPolicy via
      // LongOptionPositionManager.evaluate(), never this order's own monitor.
    });
    if (result.status !== 'TRADED') return false;

    if ((process.env.TRADING_MODE || 'paper') === 'paper') {
      await createPaperStrategy({
        id: strat.id, name: strat.name, symbol: strat.symbol, type: strat.type, lots: strat.lots,
        legs: [{ ...leg, price: result.fill_price ?? leg.price }],
      });
    }

    this.openLeg.set(symbol, leg.securityId);
    this.pendingLearns.set(symbol, {
      state, actionIndex, entryPrice: spot, side: signal.action === 'OPEN_LONG' ? 'LONG' : 'SHORT', securityId: leg.securityId,
    });
    eventBus.log('TRADE', `Adaptive Supertrend: BUY ${symbol} ${leg.optionType} ${leg.strike} @ ₹${leg.price} (${signal.reasoning})`, 'adaptive_supertrend');
    return true;
  }

  private openPositionCount(positions: any[]): number {
    if ((process.env.TRADING_MODE || 'paper') === 'paper') {
      return positions.filter((p: any) => p.netQty !== 0).length;
    }
    return this.openLeg.size;
  }

  private isScannerLegOpen(pending: PendingLearn, positions: any[]): boolean {
    return positions.some((p: any) => String(p.securityId) === pending.securityId && p.netQty > 0);
  }
}
