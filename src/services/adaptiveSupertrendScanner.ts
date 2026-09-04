import * as path from 'path';
import type { DhanClient, Candle } from '@nemesis-oss/dhanhq-sdk';
import { supertrend } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { INDEX_INSTRUMENTS, type MarketDataService } from './marketData';
import { nearestIndexExpiry } from './marketHours';
import type { RiskEngine } from './riskEngine';
import type { PaperExecutionEngine } from '../engines/paper';
import { MAX_CONCURRENT_POSITIONS } from './autonomy';
import { listPaperPositions, createPaperStrategy } from '../db';
import { buildAdaptiveSupertrendStrategy } from './strategyConstructor';
import { CandleStore } from './adaptiveSupertrendCandles';
import { extractMarketFeatures, formatRegimeKey, AdaptiveParameterAI, FuzzySignalAI, type AdaptiveSignal } from './adaptiveSupertrend';

// NIFTY/SENSEX scanned first — evaluateOne() below stops opening new
// positions once MAX_CONCURRENT_POSITIONS is hit, so scan order is
// priority order under a full slot table, not just cosmetic.
const WATCHLIST = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
const SCAN_INTERVAL_MS = 60_000;
// A 2%-move directional return normalizes to a full-magnitude Q-learning
// reward — matches the source strategy's reward scale exactly.
const REWARD_NORMALIZATION_RETURN = 0.02;
const FIVE_MIN_SUPERTREND_PARAMS = { period: 10, multiplier: 3 }; // fixed SDK defaults, not Q-learning-controlled — see class doc

interface PendingLearn {
  state: string;
  actionIndex: number;
  entryPrice: number;
  side: 'LONG' | 'SHORT';
  securityId: string;
}

/**
 * Naked ATM CE/PE scanner: Q-learning picks the 1m Supertrend's
 * (atrPeriod, multiplier) per market regime, a 1m Supertrend flip that
 * agrees with the 5m Supertrend direction triggers a fuzzy-logic
 * confluence check, and a passing signal deploys a single-leg BUY.
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

  constructor(
    private client: DhanClient,
    private market: MarketDataService,
    private paper: PaperExecutionEngine,
    private risk: RiskEngine,
    paramAI?: AdaptiveParameterAI, // test-only override — production epsilon-greedy exploration is inherently random
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
    if (!this.risk.canTrade().allowed) return;

    const positions = await listPaperPositions();
    if (positions.filter((p: any) => p.netQty !== 0).length >= MAX_CONCURRENT_POSITIONS) return;

    this.lastScanAt = Date.now();
    for (const symbol of WATCHLIST) {
      try {
        await this.evaluateSymbol(symbol, positions);
      } catch (e: any) {
        eventBus.log('WARN', `Adaptive Supertrend scan failed for ${symbol}: ${e.message}`, 'adaptive_supertrend');
      }
    }
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
    await this.deploy(symbol, decision.signal, decision.state, decision.actionIndex, decision.currentPrice);
  }

  /** Regime -> Q-learning params -> 1m Supertrend flip -> 5m agreement ->
   * fuzzy confluence. Null at any stage means "nothing to act on this bar",
   * not an error. */
  private computeSignal(symbol: string, oneMin: Candle[]): {
    signal: AdaptiveSignal; state: string; actionIndex: number; currentPrice: number;
  } | null {
    const features = extractMarketFeatures(oneMin);
    if (!features) return null;

    const { params, state, actionIndex } = this.paramAI.chooseAction(features);
    const st1m = supertrend(oneMin, { period: params.atrPeriod, multiplier: params.multiplier });
    const dir1m = st1m.direction[st1m.direction.length - 1];
    const prevDir1m = st1m.direction[st1m.direction.length - 2];
    if (dir1m == null || prevDir1m == null || dir1m === prevDir1m) return null; // no fresh crossover

    const fiveMin = this.candles.getFiveMinute(symbol);
    if (fiveMin.length < FIVE_MIN_SUPERTREND_PARAMS.period + 2) return null;
    const st5m = supertrend(fiveMin, FIVE_MIN_SUPERTREND_PARAMS);
    const dir5m = st5m.direction[st5m.direction.length - 1];
    if (dir5m == null || dir1m !== dir5m) return null; // 1m flip against the 5m trend — filtered, not an error

    const currentPrice = oneMin[oneMin.length - 1]!.close;
    const supertrendValue = st1m.trend[st1m.trend.length - 1];
    if (supertrendValue == null) return null;

    const signal = this.signalAI.generateSignal({
      stDirection: dir1m, isCrossover: true, features, params, currentPrice, supertrendValue,
    });
    return { signal, state, actionIndex, currentPrice };
  }

  /** Settles the Q-learning reward for a symbol's prior entry once
   * LongOptionExitPolicy (or EOD/manual close) has flattened it — reward is
   * scored off spot movement, matching the source strategy's semantics: it
   * grades whether the regime-direction call on the underlying was right,
   * not the option premium P&L (theta/IV-dominated, would poison the signal). */
  private async settlePendingLearn(symbol: string, positions: any[]): Promise<void> {
    const pending = this.pendingLearns.get(symbol);
    if (!pending) return;
    const stillOpen = positions.some((p: any) => String(p.securityId) === pending.securityId && p.netQty > 0);
    if (stillOpen) return;

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

  private async deploy(symbol: string, signal: AdaptiveSignal, state: string, actionIndex: number, spot: number): Promise<void> {
    const expiry = nearestIndexExpiry(symbol);
    const chain = await this.client.optionChain
      .fetchNormalized({ underlyingScrip: Number(INDEX_INSTRUMENTS[symbol]!.securityId), underlyingSeg: 'IDX_I', expiry })
      .catch(() => null);
    if (!chain?.strikes?.length) return;

    const optionType = signal.action === 'OPEN_LONG' ? 'CE' : 'PE';
    const strat = buildAdaptiveSupertrendStrategy(symbol, spot, chain.strikes, expiry, 1, optionType);
    if (!strat) return;
    const leg = strat.legs[0]!;

    // Ahead of the fill, not just after — placeOrder's own price resolution
    // needs the instrument already subscribed to have a live quote to fill
    // against (falls back to the leg's chain-snapshot price otherwise).
    this.market.addInstruments([{ securityId: leg.securityId, exchangeSegment: leg.exchangeSegment }]);

    const result: any = await this.paper.placeOrder({
      correlation_id: `${strat.id}_${leg.optionType}_${leg.strike}`,
      intent_id: `adaptive_supertrend_${symbol}`,
      params: {
        security_id: leg.securityId, symbol: leg.instrument, quantity: leg.qty,
        transaction_type: 'BUY', order_type: 'MARKET',
        exchange_segment: leg.exchangeSegment, product_type: 'INTRADAY', price: leg.price,
      },
      // No risk_limits — exits are fully owned by LongOptionExitPolicy via
      // LongOptionPositionManager.evaluate(), never this order's own monitor.
    });
    if (result.status !== 'TRADED') return;

    await createPaperStrategy({
      id: strat.id, name: strat.name, symbol: strat.symbol, type: strat.type, lots: strat.lots,
      legs: [{ ...leg, price: result.fill_price ?? leg.price }],
    });

    this.openLeg.set(symbol, leg.securityId);
    this.pendingLearns.set(symbol, {
      state, actionIndex, entryPrice: spot, side: signal.action === 'OPEN_LONG' ? 'LONG' : 'SHORT', securityId: leg.securityId,
    });
    eventBus.log('TRADE', `Adaptive Supertrend: BUY ${symbol} ${leg.optionType} ${leg.strike} @ ₹${leg.price} (${signal.reasoning})`, 'adaptive_supertrend');
  }
}
