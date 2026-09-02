import { selectStrikeByDelta, selectStrikeByPremiumTarget, calculateGreeks } from './optionsAnalytics';
import { listPaperStrategies, createPaperStrategy } from '../db';
import { INDEX_INSTRUMENTS } from './marketData';
import { nearestIndexExpiry } from './marketHours';
import { eventBus } from './eventBus';

export interface StrategyLeg {
  instrument: string;
  securityId: string;
  side: 'BUY' | 'SELL';
  qty: number;
  strike: number;
  optionType: 'CE' | 'PE';
  price: number;
  exchangeSegment: string;
  stopLoss?: number;
  target?: number;
  trailingStop?: { distance: number };
}

export type StrategyType =
  | 'IRON_CONDOR'
  | 'IRON_BUTTERFLY'
  | 'BULL_PUT_SPREAD'
  | 'BEAR_CALL_SPREAD'
  | 'BULL_CALL_SPREAD'
  | 'BEAR_PUT_SPREAD'
  | 'STRADDLE'
  | 'SHORT_STRADDLE'
  | 'LONG_STRADDLE'
  | 'STRANGLE'
  | 'SHORT_STRANGLE'
  | 'LONG_STRANGLE'
  | 'RATIO_SPREAD'
  | 'ORB_15M'
  | 'ORB_30M'
  | 'ORB_PREMIUM_200'
  | 'VWAP_RSI_PULLBACK'
  | 'EMA_CROSSOVER'
  | 'NAKED_BUY';

export interface ConstructedStrategy {
  id: string;
  name: string;
  symbol: string;
  type: StrategyType;
  lots: number;
  legs: StrategyLeg[];
  estimatedNetPremium: number; // positive = credit received, negative = debit paid
  lotSize: number;
}

// Last-resort fallback only — real lot size comes from the DhanHQ instrument
// (scrip master) via warmLotSizeCache(). These values are not independently
// verified and only apply if that lookup has never succeeded for a symbol.
const LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  SENSEX: 20,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
};

const LOT_SIZE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // lot size doesn't change intraday
const lotSizeCache = new Map<string, { value: number; expiresAt: number }>();

/** Resolves and caches a symbol's real lot size from the DhanHQ instrument
 * (scrip master). Call once per symbol wherever the option chain is already
 * being fetched with a live client — cheap no-op once cached. */
export async function warmLotSizeCache(client: any, symbol: string, exchangeSegment = 'NSE_FNO'): Promise<void> {
  const sym = symbol.toUpperCase();
  const cached = lotSizeCache.get(sym);
  if (cached && cached.expiresAt > Date.now()) return;
  try {
    const instrument = await client?.instruments?.find?.(exchangeSegment, sym);
    // `find()` on a bare index symbol under NSE_FNO can match a synthetic
    // index reference row (instrument: 'INDEX', lotSize: 1) instead of an
    // actual options/futures contract — never trust that, it would silently
    // undersize every order to 1 contract. Keep the hardcoded fallback then.
    const lotSize = Number(instrument?.lotSize);
    if (lotSize > 1 && instrument?.instrument !== 'INDEX') {
      lotSizeCache.set(sym, { value: lotSize, expiresAt: Date.now() + LOT_SIZE_CACHE_TTL_MS });
    }
  } catch { /* keep the hardcoded fallback */ }
}

export function getLotSize(symbol: string): number {
  const sym = symbol.toUpperCase();
  const cached = lotSizeCache.get(sym);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return LOT_SIZES[sym] || 65;
}

/**
 * Calculates accurate Indian F&O round-trip frictions (STT 0.10% on sell,
 * stamp duty 0.003% on buy, SEBI turnover fee, ₹20 brokerage, 18% GST, 0.20% slippage).
 */
export function calculateFnoFrictions(entryPrem: number, exitPrem: number, qty: number) {
  const buyTurnover = entryPrem * qty;
  const sellTurnover = exitPrem * qty;
  const totalTurnover = buyTurnover + sellTurnover;

  // STT: 0.10% charged on SELL side of options premium (post Oct 1, 2024).
  const stt = Number((sellTurnover * 0.0010).toFixed(2));
  const stampDuty = Number((buyTurnover * 0.00003).toFixed(2)); // 0.003% on buy side only
  const sebiFee = Number((totalTurnover * 0.0000001).toFixed(2)); // ~₹10/crore turnover
  const brokerage = 40; // ₹20 entry + ₹20 exit
  const exchange = Number((totalTurnover * 0.0005).toFixed(2)); // ~0.05% turnover
  const gst = Number(((brokerage + exchange) * 0.18).toFixed(2));
  const slippage = Number((totalTurnover * 0.0020).toFixed(2)); // 0.20% realistic slippage
  const totalFriction = Number((stt + stampDuty + sebiFee + brokerage + gst + exchange + slippage).toFixed(2));

  return { stt, stampDuty, sebiFee, brokerage, gst, exchange, slippage, totalFriction };
}

/**
 * Calculates conservative position size targeting 1% risk per trade.
 */
export function calculatePositionSize(capital: number, stopDistancePts: number, symbol: string, riskPct = 1) {
  const lotSize = getLotSize(symbol);
  const maxRisk = capital * (riskPct / 100);
  const riskPerLot = stopDistancePts * lotSize;
  const lots = riskPerLot > 0 ? Math.max(1, Math.floor(maxRisk / riskPerLot)) : 1;
  return { lots, qty: lots * lotSize, maxRiskRupees: Number(maxRisk.toFixed(2)), lotSize };
}

/**
 * Calculates the number of lots to deploy targeting a % of total available capital (default 30%).
 * Sizing adapts to Option Buying (debit/premium cost) and Spreads/Condors (margin requirements).
 */
export function calculateCapitalAllocationLots(
  capital: number,
  symbol: string,
  strategyType: 'BUY' | 'SPREAD' | 'CONDOR' | 'STRADDLE',
  unitCostOrMargin = 0,
  allocationPct = 30
): number {
  const lotSize = getLotSize(symbol);
  const targetCapital = Math.max(0, capital * (allocationPct / 100));

  let requiredPerLot = unitCostOrMargin;
  if (!requiredPerLot || requiredPerLot <= 0) {
    switch (strategyType) {
      case 'BUY':
        requiredPerLot = 150 * lotSize; // Average near-ATM index premium
        break;
      case 'SPREAD':
        requiredPerLot = 40_000; // Average hedged 2-leg spread margin
        break;
      case 'CONDOR':
        requiredPerLot = 55_000; // Average hedged 4-leg Iron Condor margin
        break;
      case 'STRADDLE':
        requiredPerLot = 120_000; // Average short straddle margin
        break;
    }
  }

  const rawLots = Math.floor(targetCapital / requiredPerLot);
  // Cap at 10 lots / 1000 quantity per single strategy execution for risk safety
  const maxLotsCap = Math.max(1, Math.floor(1000 / lotSize));
  return Math.min(maxLotsCap, Math.max(1, rawLots));
}

/**
 * Builds an Opening Range Breakout (ORB) buying strategy:
 * - Directional BUY CE or BUY PE using near-ITM or ~₹200 premium strike for delta ~0.55-0.65.
 */
export function buildOrbBuyingStrategy(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1,
  direction: 'BULLISH' | 'BEARISH' = 'BULLISH',
  targetPremium?: number
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;
  const optType = direction === 'BULLISH' ? 'CALL' : 'PUT';

  const strikeRow = targetPremium
    ? selectStrikeByPremiumTarget(chainRows, targetPremium, optType)
    : selectStrikeByDelta(chainRows, 0.55, optType, spot, expiry);

  if (!strikeRow) return null;
  const leg = toLeg(strikeRow, optType, 'BUY', qty, symbol);
  const cost = -(leg.price * qty);

  return {
    id: `strat_orb_${Date.now().toString(36)}`,
    name: `${symbol} ORB Buy ${direction === 'BULLISH' ? 'Call' : 'Put'} (${leg.strike})`,
    symbol,
    type: targetPremium ? 'ORB_PREMIUM_200' : 'ORB_15M',
    lots,
    legs: [leg],
    estimatedNetPremium: Number(cost.toFixed(2)),
    lotSize,
  };
}

/**
 * Builds a VWAP + RSI Pullback buying strategy.
 */
export function buildVwapPullbackStrategy(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1,
  direction: 'BULLISH' | 'BEARISH' = 'BULLISH'
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;
  const optType = direction === 'BULLISH' ? 'CALL' : 'PUT';
  const strikeRow = selectStrikeByDelta(chainRows, 0.50, optType, spot, expiry);
  if (!strikeRow) return null;

  const leg = toLeg(strikeRow, optType, 'BUY', qty, symbol);
  return {
    id: `strat_vwap_${Date.now().toString(36)}`,
    name: `${symbol} VWAP Pullback ${direction === 'BULLISH' ? 'CE' : 'PE'} (${leg.strike})`,
    symbol,
    type: 'VWAP_RSI_PULLBACK',
    lots,
    legs: [leg],
    estimatedNetPremium: Number((-(leg.price * qty)).toFixed(2)),
    lotSize,
  };
}

/**
 * Builds a Directional Option Buy (ATM CE or ATM PE).
 */
export function buildDirectionalOptionBuy(
  symbol: string,
  optionType: 'CE' | 'PE',
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;
  const optType = optionType === 'CE' ? 'CALL' : 'PUT';
  const strikeRow = selectStrikeByDelta(chainRows, 0.50, optType, spot, expiry);
  if (!strikeRow) return null;

  const leg = toLeg(strikeRow, optType, 'BUY', qty, symbol);
  return {
    id: `strat_buy_${Date.now().toString(36)}`,
    name: `${symbol} Long ${optionType} (${leg.strike})`,
    symbol,
    type: 'NAKED_BUY',
    lots,
    legs: [leg],
    estimatedNetPremium: Number((-(leg.price * qty)).toFixed(2)),
    lotSize,
  };
}

/**
 * Builds an Iron Condor:
 * - Buy OTM Put (wing hedge) [BUY FIRST for margin relief]
 * - Buy OTM Call (wing hedge) [BUY FIRST for margin relief]
 * - Sell OTM Put (short strike)
 * - Sell OTM Call (short strike)
 */
export function buildIronCondor(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;

  const shortCall = selectStrikeByDelta(chainRows, 0.25, 'CALL', spot, expiry);
  const longCall = selectStrikeByDelta(chainRows, 0.10, 'CALL', spot, expiry);
  const shortPut = selectStrikeByDelta(chainRows, 0.25, 'PUT', spot, expiry);
  const longPut = selectStrikeByDelta(chainRows, 0.10, 'PUT', spot, expiry);

  if (!shortCall || !longCall || !shortPut || !longPut) return null;

  // Margin-first execution order: BUY wings before SELLING short legs.
  const legs: StrategyLeg[] = [
    toLeg(longPut, 'PUT', 'BUY', qty, symbol),
    toLeg(longCall, 'CALL', 'BUY', qty, symbol),
    toLeg(shortPut, 'PUT', 'SELL', qty, symbol),
    toLeg(shortCall, 'CALL', 'SELL', qty, symbol),
  ];

  const netCredit = (shortCall.targetLeg?.ltp || 0) + (shortPut.targetLeg?.ltp || 0)
    - (longCall.targetLeg?.ltp || 0) - (longPut.targetLeg?.ltp || 0);

  return {
    id: `strat_ic_${Date.now().toString(36)}`,
    name: `${symbol} Iron Condor (${expiry})`,
    symbol,
    type: 'IRON_CONDOR',
    lots,
    legs,
    estimatedNetPremium: Number((netCredit * qty).toFixed(2)),
    lotSize,
  };
}

/**
 * Builds a Vertical Credit Spread:
 * - Bull Put (Bullish): Buy OTM Put, Sell Higher OTM Put
 * - Bear Call (Bearish): Buy OTM Call, Sell Lower OTM Call
 */
export function buildCreditSpread(
  symbol: string,
  direction: 'BULLISH' | 'BEARISH',
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;
  const optType = direction === 'BULLISH' ? 'PUT' : 'CALL';

  const shortLeg = selectStrikeByDelta(chainRows, 0.30, optType, spot, expiry);
  const longLeg = selectStrikeByDelta(chainRows, 0.15, optType, spot, expiry);
  if (!shortLeg || !longLeg) return null;

  // Long leg first for margin benefit
  const legs: StrategyLeg[] = [
    toLeg(longLeg, optType, 'BUY', qty, symbol),
    toLeg(shortLeg, optType, 'SELL', qty, symbol),
  ];

  const netCredit = (shortLeg.targetLeg?.ltp || 0) - (longLeg.targetLeg?.ltp || 0);

  return {
    id: `strat_cs_${Date.now().toString(36)}`,
    name: `${symbol} ${direction === 'BULLISH' ? 'Bull Put' : 'Bear Call'} Spread`,
    symbol,
    type: direction === 'BULLISH' ? 'BULL_PUT_SPREAD' : 'BEAR_CALL_SPREAD',
    lots,
    legs,
    estimatedNetPremium: Number((netCredit * qty).toFixed(2)),
    lotSize,
  };
}

/**
 * Builds an ATM Straddle (Sell ATM Call + Sell ATM Put).
 */
export function buildStraddle(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1,
  side: 'BUY' | 'SELL' = 'SELL'
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;

  const atmCall = selectStrikeByDelta(chainRows, 0.50, 'CALL', spot, expiry);
  const atmPut = selectStrikeByDelta(chainRows, 0.50, 'PUT', spot, expiry);
  if (!atmCall || !atmPut) return null;

  const legs: StrategyLeg[] = [
    toLeg(atmCall, 'CALL', side, qty, symbol),
    toLeg(atmPut, 'PUT', side, qty, symbol),
  ];

  const premium = (atmCall.targetLeg?.ltp || 0) + (atmPut.targetLeg?.ltp || 0);
  const netPrem = side === 'SELL' ? premium * qty : -premium * qty;

  return {
    id: `strat_strad_${Date.now().toString(36)}`,
    name: `${symbol} ATM ${side} Straddle (${atmCall.strike})`,
    symbol,
    type: 'STRADDLE',
    lots,
    legs,
    estimatedNetPremium: Number(netPrem.toFixed(2)),
    lotSize,
  };
}

/**
 * Builds an OTM Strangle (Delta 0.20-0.30 Call + Put).
 */
export function buildStrangle(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1,
  side: 'BUY' | 'SELL' = 'SELL'
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;

  const otmCall = selectStrikeByDelta(chainRows, 0.25, 'CALL', spot, expiry);
  const otmPut = selectStrikeByDelta(chainRows, 0.25, 'PUT', spot, expiry);
  if (!otmCall || !otmPut) return null;

  const legs: StrategyLeg[] = [
    toLeg(otmCall, 'CALL', side, qty, symbol),
    toLeg(otmPut, 'PUT', side, qty, symbol),
  ];

  const premium = (otmCall.targetLeg?.ltp || 0) + (otmPut.targetLeg?.ltp || 0);
  const netPrem = side === 'SELL' ? premium * qty : -premium * qty;

  return {
    id: `strat_strang_${Date.now().toString(36)}`,
    name: `${symbol} OTM ${side} Strangle (${otmPut.strike}P / ${otmCall.strike}C)`,
    symbol,
    type: 'STRANGLE',
    lots,
    legs,
    estimatedNetPremium: Number(netPrem.toFixed(2)),
    lotSize,
  };
}

/**
 * Builds an Iron Butterfly:
 * - Buy OTM Put (wing hedge, delta ~0.15) [BUY FIRST for margin relief]
 * - Buy OTM Call (wing hedge, delta ~0.15) [BUY FIRST for margin relief]
 * - Sell ATM Put (delta ~0.50)
 * - Sell ATM Call (delta ~0.50)
 */
export function buildIronButterfly(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;

  const atmCall = selectStrikeByDelta(chainRows, 0.50, 'CALL', spot, expiry);
  const atmPut = selectStrikeByDelta(chainRows, 0.50, 'PUT', spot, expiry);
  const otmCall = selectStrikeByDelta(chainRows, 0.15, 'CALL', spot, expiry);
  const otmPut = selectStrikeByDelta(chainRows, 0.15, 'PUT', spot, expiry);

  if (!atmCall || !atmPut || !otmCall || !otmPut) return null;

  const legs: StrategyLeg[] = [
    toLeg(otmPut, 'PUT', 'BUY', qty, symbol),
    toLeg(otmCall, 'CALL', 'BUY', qty, symbol),
    toLeg(atmPut, 'PUT', 'SELL', qty, symbol),
    toLeg(atmCall, 'CALL', 'SELL', qty, symbol),
  ];

  const netCredit = (atmCall.targetLeg?.ltp || 0) + (atmPut.targetLeg?.ltp || 0)
    - (otmCall.targetLeg?.ltp || 0) - (otmPut.targetLeg?.ltp || 0);

  return {
    id: `strat_ib_${Date.now().toString(36)}`,
    name: `${symbol} Iron Butterfly (${atmCall.strike})`,
    symbol,
    type: 'IRON_BUTTERFLY',
    lots,
    legs,
    estimatedNetPremium: Number((netCredit * qty).toFixed(2)),
    lotSize,
  };
}

/**
 * Builds a Vertical Debit Spread:
 * - Bull Call Spread (Bullish): Buy ATM Call (Delta 0.50) + Sell OTM Call (Delta 0.25)
 * - Bear Put Spread (Bearish): Buy ATM Put (Delta 0.50) + Sell OTM Put (Delta 0.25)
 */
export function buildDebitSpread(
  symbol: string,
  direction: 'BULLISH' | 'BEARISH',
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;
  const optType = direction === 'BULLISH' ? 'CALL' : 'PUT';

  const longLeg = selectStrikeByDelta(chainRows, 0.50, optType, spot, expiry);
  const shortLeg = selectStrikeByDelta(chainRows, 0.25, optType, spot, expiry);
  if (!longLeg || !shortLeg) return null;

  const legs: StrategyLeg[] = [
    toLeg(longLeg, optType, 'BUY', qty, symbol),
    toLeg(shortLeg, optType, 'SELL', qty, symbol),
  ];

  const netDebit = (longLeg.targetLeg?.ltp || 0) - (shortLeg.targetLeg?.ltp || 0);

  return {
    id: `strat_ds_${Date.now().toString(36)}`,
    name: `${symbol} ${direction === 'BULLISH' ? 'Bull Call' : 'Bear Put'} Debit Spread`,
    symbol,
    type: direction === 'BULLISH' ? 'BULL_CALL_SPREAD' : 'BEAR_PUT_SPREAD',
    lots,
    legs,
    estimatedNetPremium: Number((-(netDebit * qty)).toFixed(2)),
    lotSize,
  };
}

/**
 * Builds a 1x2 Ratio Spread:
 * - Buy 1 ATM contract + Sell 2 OTM contracts for low debit or net credit.
 */
export function buildRatioSpread(
  symbol: string,
  direction: 'BULLISH' | 'BEARISH',
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const optType = direction === 'BULLISH' ? 'CALL' : 'PUT';

  const longLeg = selectStrikeByDelta(chainRows, 0.50, optType, spot, expiry);
  const shortLeg = selectStrikeByDelta(chainRows, 0.20, optType, spot, expiry);
  if (!longLeg || !shortLeg) return null;

  const legs: StrategyLeg[] = [
    toLeg(longLeg, optType, 'BUY', lots * lotSize, symbol),
    toLeg(shortLeg, optType, 'SELL', lots * lotSize * 2, symbol),
  ];

  const netPrem = (shortLeg.targetLeg?.ltp || 0) * 2 - (longLeg.targetLeg?.ltp || 0);

  return {
    id: `strat_ratio_${Date.now().toString(36)}`,
    name: `${symbol} ${direction} 1x2 Ratio Spread`,
    symbol,
    type: 'RATIO_SPREAD',
    lots,
    legs,
    estimatedNetPremium: Number((netPrem * lots * lotSize).toFixed(2)),
    lotSize,
  };
}

/**
 * Builds a 30-Minute Opening Range Breakout (ORB 30M) strategy.
 */
export function buildOrb30mStrategy(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1,
  direction: 'BULLISH' | 'BEARISH' = 'BULLISH'
): ConstructedStrategy | null {
  const strat = buildOrbBuyingStrategy(symbol, spot, chainRows, expiry, lots, direction);
  if (!strat) return null;
  strat.type = 'ORB_30M';
  strat.name = `${symbol} 30m ORB Buy ${direction === 'BULLISH' ? 'Call' : 'Put'} (${strat.legs[0]?.strike})`;
  return strat;
}

/**
 * Builds an EMA 9/21 Crossover Trend-Following buying strategy.
 */
export function buildEmaCrossoverStrategy(
  symbol: string,
  spot: number,
  chainRows: any[],
  expiry: string,
  lots = 1,
  direction: 'BULLISH' | 'BEARISH' = 'BULLISH'
): ConstructedStrategy | null {
  const lotSize = getLotSize(symbol);
  const qty = lots * lotSize;
  const optType = direction === 'BULLISH' ? 'CALL' : 'PUT';
  const strikeRow = selectStrikeByDelta(chainRows, 0.55, optType, spot, expiry);
  if (!strikeRow) return null;

  const leg = toLeg(strikeRow, optType, 'BUY', qty, symbol);
  return {
    id: `strat_ema_${Date.now().toString(36)}`,
    name: `${symbol} EMA Crossover ${direction === 'BULLISH' ? 'CE' : 'PE'} (${leg.strike})`,
    symbol,
    type: 'EMA_CROSSOVER',
    lots,
    legs: [leg],
    estimatedNetPremium: Number((-(leg.price * qty)).toFixed(2)),
    lotSize,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function toLeg(row: any, type: 'CALL' | 'PUT', side: 'BUY' | 'SELL', qty: number, symbol: string): StrategyLeg {
  const leg = row.targetLeg || (type === 'CALL' ? row.ce : row.pe) || {};
  const strike = row.strike;
  const optSuffix = type === 'CALL' ? 'CE' : 'PE';
  const sym = leg.tradingSymbol || leg.symbol || `${symbol}${strike}${optSuffix}`;
  const price = Number(leg.ltp || leg.lastPrice || leg.last_price || 0);

  // Dynamic SL / TP / Trailing calculation based on trade side:
  // Long Options (debit): 25% SL, 50% TP (2:1 R:R), 10% Trailing distance
  // Short Options (credit): 60% SL on sold premium, 70% theta decay capture TP, 15% Trailing distance
  const isBuy = side === 'BUY';
  const stopLoss = price > 0 ? Number((isBuy ? price * 0.75 : price * 1.60).toFixed(2)) : undefined;
  const target = price > 0 ? Number((isBuy ? price * 1.50 : price * 0.30).toFixed(2)) : undefined;
  const trailDist = price > 0 ? Number((price * (isBuy ? 0.10 : 0.15)).toFixed(2)) : undefined;

  return {
    instrument: sym,
    securityId: String(leg.securityId || leg.security_id || '0'),
    side,
    qty,
    strike,
    optionType: optSuffix,
    price,
    // SENSEX options trade on BSE, not NSE — a wrong segment here means
    // every quote lookup for the leg silently returns nothing and its LTP
    // (and therefore P&L) never updates past the entry fill price.
    exchangeSegment: symbol.toUpperCase() === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
    stopLoss,
    target,
    trailingStop: trailDist && trailDist > 0 ? { distance: trailDist } : undefined,
  };
}

export interface BacktestConfig {
  entryType?: 'OPEN_915' | 'ORB_930' | 'ORB_15M' | 'ORB_30M' | 'ORB_PREM_200' | 'VWAP_RSI';
  targetPct?: number;
  slPct?: number;
  timeExit?: string;
  side?: 'BUY' | 'SELL';
  lots?: number;
  skipMidday?: boolean;
}

export interface BacktestDayResult {
  date: string;
  pnl: number;
  pnlInr: number;
  netPnlInr: number;
  frictionInr: number;
  roi: number;
  netRoi: number;
  maxProfit: number;
  maxDrawdown: number;
  status: string;
  reason: string;
}

export interface BacktestReport {
  symbol: string;
  strategyType: string;
  totalDays: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  totalPnlInr: number;
  netPnlInr: number;
  totalFrictionInr: number;
  profitFactor: number;
  maxDrawdownRoi: number;
  avgRoi: number;
  passedValidation: boolean;
  days: BacktestDayResult[];
}

export function evaluateStrategyBacktest(symbol: string, type: string, daysData: any[], cfg: BacktestConfig = {}): BacktestReport {
  const targetPct = cfg.targetPct ?? 25, slPct = cfg.slPct ?? 20, timeExit = cfg.timeExit || '15:20', lots = cfg.lots || 1;
  const lotSize = getLotSize(symbol);
  const isShort = (cfg.side || (type.includes('SPREAD') || type === 'IRON_CONDOR' ? 'SELL' : 'BUY')) === 'SELL';

  const validDays = (daysData || []).filter((d) => d && Array.isArray(d.timeline) && d.timeline.length > 0);
  const days: BacktestDayResult[] = validDays.map((d) =>
    simulateDayBacktest(d, type, { targetPct, slPct, timeExit, lots, lotSize, isShort, entryType: cfg.entryType || type, symbol })
  );

  const wins = days.filter((d) => d.netPnlInr > 0).length, totalDays = days.length;
  const winRate = totalDays > 0 ? Number(((wins / totalDays) * 100).toFixed(1)) : 0;
  const totalPnl = Number(days.reduce((s, d) => s + d.pnl, 0).toFixed(2));
  const totalPnlInr = Number((totalPnl * lotSize * lots).toFixed(2));
  const netPnlInr = Number(days.reduce((s, d) => s + d.netPnlInr, 0).toFixed(2));
  const totalFrictionInr = Number(days.reduce((s, d) => s + d.frictionInr, 0).toFixed(2));
  const grossProfit = days.filter((d) => d.netPnlInr > 0).reduce((s, d) => s + d.netPnlInr, 0);
  const grossLoss = Math.abs(days.filter((d) => d.netPnlInr < 0).reduce((s, d) => s + d.netPnlInr, 0));
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99 : 1.5);
  const maxDrawdownRoi = days.length > 0 ? Math.min(...days.map((d) => d.maxDrawdown)) : 0;
  const avgRoi = totalDays > 0 ? Number((days.reduce((s, d) => s + d.netRoi, 0) / totalDays).toFixed(1)) : 0;
  // Statistical edge validation: Buyers need high payoff ratio (PF >= 1.15, positive net P&L); Sellers need win rate >= 35%, PF >= 1.10, positive net P&L.
  // maxDrawdownRoi > -50%: a single tail-risk session (gamma shock, gap) must
  // not be able to pass just because the rest of the sample was profitable —
  // this is the risk-of-ruin gate, not optional.
  const isBuyer = type.startsWith('ORB') || type.startsWith('VWAP') || type.startsWith('EMA') || type === 'NAKED_BUY';
  const passedValidation = totalDays > 0 && (
    isBuyer
      ? (winRate >= 20 && profitFactor >= 1.15 && netPnlInr > 0 && maxDrawdownRoi > -50)
      : (winRate >= 35 && profitFactor >= 1.10 && netPnlInr > 0 && maxDrawdownRoi > -50)
  );

  return { symbol, strategyType: type, totalDays, wins, winRate, totalPnl, totalPnlInr, netPnlInr, totalFrictionInr, profitFactor, maxDrawdownRoi, avgRoi, passedValidation, days };
}

interface BacktestLegSpec {
  optType: 'CALL' | 'PUT';
  targetDelta: number;
  side: 'BUY' | 'SELL';
  qtyMultiplier: number;
}

/**
 * Leg definitions mirroring each live build* function's actual strike-delta
 * targets and sides, so a backtest for a given type simulates the same
 * combination of strikes the live strategy would actually open — not a
 * generic ATM-straddle stand-in for every multi-leg type.
 */
function getStrategyLegSpecs(type: string, direction: 'CALL' | 'PUT', side: 'BUY' | 'SELL'): BacktestLegSpec[] {
  const t = type.toUpperCase();
  if (t.includes('STRADDLE')) {
    return [
      { optType: 'CALL', targetDelta: 0.50, side, qtyMultiplier: 1 },
      { optType: 'PUT', targetDelta: 0.50, side, qtyMultiplier: 1 },
    ];
  }
  if (t.includes('STRANGLE')) {
    return [
      { optType: 'CALL', targetDelta: 0.25, side, qtyMultiplier: 1 },
      { optType: 'PUT', targetDelta: 0.25, side, qtyMultiplier: 1 },
    ];
  }
  if (t === 'IRON_CONDOR') {
    return [
      { optType: 'PUT', targetDelta: 0.10, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'CALL', targetDelta: 0.10, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'PUT', targetDelta: 0.25, side: 'SELL', qtyMultiplier: 1 },
      { optType: 'CALL', targetDelta: 0.25, side: 'SELL', qtyMultiplier: 1 },
    ];
  }
  if (t === 'IRON_BUTTERFLY') {
    return [
      { optType: 'PUT', targetDelta: 0.15, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'CALL', targetDelta: 0.15, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'PUT', targetDelta: 0.50, side: 'SELL', qtyMultiplier: 1 },
      { optType: 'CALL', targetDelta: 0.50, side: 'SELL', qtyMultiplier: 1 },
    ];
  }
  if (t === 'BULL_PUT_SPREAD') {
    return [
      { optType: 'PUT', targetDelta: 0.15, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'PUT', targetDelta: 0.30, side: 'SELL', qtyMultiplier: 1 },
    ];
  }
  if (t === 'BEAR_CALL_SPREAD') {
    return [
      { optType: 'CALL', targetDelta: 0.15, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'CALL', targetDelta: 0.30, side: 'SELL', qtyMultiplier: 1 },
    ];
  }
  if (t === 'BULL_CALL_SPREAD') {
    return [
      { optType: 'CALL', targetDelta: 0.50, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'CALL', targetDelta: 0.25, side: 'SELL', qtyMultiplier: 1 },
    ];
  }
  if (t === 'BEAR_PUT_SPREAD') {
    return [
      { optType: 'PUT', targetDelta: 0.50, side: 'BUY', qtyMultiplier: 1 },
      { optType: 'PUT', targetDelta: 0.25, side: 'SELL', qtyMultiplier: 1 },
    ];
  }
  if (t === 'RATIO_SPREAD') {
    return [
      { optType: direction, targetDelta: 0.50, side: 'BUY', qtyMultiplier: 1 },
      { optType: direction, targetDelta: 0.20, side: 'SELL', qtyMultiplier: 2 },
    ];
  }
  if (t === 'ORB_15M' || t === 'ORB_30M' || t === 'ORB_PREMIUM_200' || t === 'EMA_CROSSOVER') {
    return [{ optType: direction, targetDelta: 0.55, side: 'BUY', qtyMultiplier: 1 }];
  }
  // VWAP_RSI_PULLBACK, NAKED_BUY, and anything unrecognized: single ATM leg.
  return [{ optType: direction, targetDelta: 0.50, side, qtyMultiplier: 1 }];
}

/** Finds the historical strike (from the day's fetched ATM±5 rows) whose
 * Black-Scholes delta is closest to the target — the same selection logic
 * live strike selection uses, applied to historical IV/spot instead of a
 * live chain. */
function selectHistoricalStrikeByDelta(strikes: any[], targetDelta: number, optType: 'CALL' | 'PUT', spot: number, expiry: string): any | null {
  let best: any = null, minDiff = Infinity;
  for (const s of strikes || []) {
    const leg = optType === 'CALL' ? s.call : s.put;
    if (!leg || !leg.open) continue;
    const iv = Number(leg.iv || 15) / 100;
    const g = calculateGreeks(spot, s.strike, expiry, optType, iv);
    const diff = Math.abs(Math.abs(g.delta) - targetDelta);
    if (diff < minDiff) { minDiff = diff; best = s; }
  }
  return best;
}

/** A resolved strike may carry its own full timeline (real historical data);
 * fall back to the day's shared timeline when it doesn't (e.g. a fixture
 * with only one strike's series, or missing per-strike history). */
function buildLegTimeline(strikeRow: any, dayTimeline: any[]): any[] {
  const src = strikeRow?.timeline?.length > 0 ? strikeRow.timeline : dayTimeline;
  return [...src].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** As-of lookup, not exact-match: each strike is fetched independently and
 * can sample slightly different timestamps (data gaps on illiquid OTM
 * strikes), so a leg's most recent VALUE at-or-before `time` is used rather
 * than requiring every leg to share the exact same time grid. Walks past
 * candles that exist at that time but lack the needed field too (ce/pe can
 * be individually missing on a shared-time candle) — stopping at the first
 * present-but-fieldless candle would silently drop back to `fallback`. */
function legPremiumAt(leg: { optType: 'CALL' | 'PUT'; timeline: any[] }, time: string, fallback: number): number {
  let value: number | null = null;
  for (const pt of leg.timeline) {
    if (pt.time > time) break;
    const v = leg.optType === 'CALL' ? pt.ce : pt.pe;
    if (v != null) value = v;
  }
  return value != null ? value : fallback;
}

function simulateDayBacktest(day: any, type: string, cfg: any): BacktestDayResult {
  const timeline = day?.timeline || [];
  if (!timeline.length) {
    return { date: day?.date || '', pnl: 0, pnlInr: 0, netPnlInr: 0, frictionInr: 0, roi: 0, netRoi: 0, maxProfit: 0, maxDrawdown: 0, status: 'NO_DATA', reason: 'No timeline' };
  }

  const { entryIdx, direction: rawDirection } = findEntrySignal(timeline, type, cfg);
  const t = type.toUpperCase();
  const direction: 'CALL' | 'PUT' = rawDirection !== 'BOTH' ? rawDirection : (t.includes('PUT') || t.includes('PE') ? 'PUT' : 'CALL');
  const side: 'BUY' | 'SELL' = cfg.side || (cfg.isShort ? 'SELL' : (type.startsWith('SHORT') || type === 'IRON_CONDOR' || type === 'IRON_BUTTERFLY' || type.includes('CREDIT') || type === 'STRANGLE' || type === 'STRADDLE' ? 'SELL' : 'BUY'));
  const legSpecs = getStrategyLegSpecs(type, direction, side);

  // Strikes are selected off the spot AT ENTRY, not the day's open — ATM
  // (and every delta-target strike) shifts as spot moves intraday, and an
  // ORB/VWAP entry can fire well after open. Once selected the strike is
  // fixed for the rest of the trade (below), matching a real position.
  const entryPt = timeline[entryIdx] || timeline[0];
  const spot = Number(entryPt?.spot) || Number(day?.spot?.open) || 0;
  const expiry = cfg.expiry || nearestIndexExpiry(cfg.symbol || 'NIFTY', new Date(day.date || Date.now()));

  const resolved = legSpecs.map((spec) => {
    const row = selectHistoricalStrikeByDelta(day?.strikes || [], spec.targetDelta, spec.optType, spot, expiry);
    return row ? { ...spec, timeline: buildLegTimeline(row, timeline) } : null;
  });
  if (resolved.some((l) => l === null)) {
    return { date: day?.date || '', pnl: 0, pnlInr: 0, netPnlInr: 0, frictionInr: 0, roi: 0, netRoi: 0, maxProfit: 0, maxDrawdown: 0, status: 'NO_DATA', reason: 'Could not resolve one or more legs from historical strikes' };
  }
  const legs = resolved as Array<BacktestLegSpec & { timeline: any[] }>;

  const signedQty = (leg: BacktestLegSpec) => (leg.side === 'BUY' ? 1 : -1) * leg.qtyMultiplier;
  const portfolioValue = (time: string, fallback: number) =>
    legs.reduce((sum, leg) => sum + signedQty(leg) * legPremiumAt(leg, time, fallback), 0);

  const entryFallback = entryPt.ce ?? entryPt.pe ?? entryPt.straddle ?? 1;
  const entryValue = portfolioValue(entryPt.time, entryFallback);
  const riskBase = Math.abs(entryValue) || 1;

  const sim = trackTradeProgression(timeline, entryIdx, entryValue, riskBase, portfolioValue, cfg);

  const exitPt = timeline[sim.exitIdx] || timeline[timeline.length - 1];
  const exitValue = portfolioValue(exitPt.time, entryValue);
  const finalPnl = Number((exitValue - entryValue).toFixed(2));
  const grossPnlInr = Number((finalPnl * cfg.lotSize * cfg.lots).toFixed(2));

  // Per-leg frictions, oriented by each leg's own side — a 4-leg condor
  // charges brokerage/STT/stamp-duty per leg, not once for the whole combo.
  let totalFriction = 0;
  for (const leg of legs) {
    const entryPrem = legPremiumAt(leg, entryPt.time, entryFallback);
    const exitPrem = legPremiumAt(leg, exitPt.time, entryPrem);
    const qty = cfg.lotSize * cfg.lots * leg.qtyMultiplier;
    const [buyPrem, sellPrem] = leg.side === 'SELL' ? [exitPrem, entryPrem] : [entryPrem, exitPrem];
    totalFriction += calculateFnoFrictions(buyPrem, sellPrem, qty).totalFriction;
  }
  totalFriction = Number(totalFriction.toFixed(2));

  const netPnlInr = Number((grossPnlInr - totalFriction).toFixed(2));
  const finalRoi = Number(((finalPnl / riskBase) * 100).toFixed(1));
  const netRoi = Number(((netPnlInr / (riskBase * cfg.lotSize * cfg.lots || 1)) * 100).toFixed(1));

  return {
    date: day.date, pnl: finalPnl, pnlInr: grossPnlInr, netPnlInr, frictionInr: totalFriction,
    roi: finalRoi, netRoi, maxProfit: Number(sim.maxGain.toFixed(1)), maxDrawdown: Number(sim.maxDrop.toFixed(1)),
    status: sim.status, reason: sim.reason,
  };
}

function findEntrySignal(timeline: any[], type: string, cfg: any): { entryIdx: number; direction: 'CALL' | 'PUT' | 'BOTH' } {
  if (timeline.length < 3) return { entryIdx: 0, direction: 'BOTH' };
  // 15M ORB: first 2 bars (09:15-09:30). 30M ORB: first 4 bars (09:15-09:45)
  const is30m = type.includes('30M') || cfg.entryType === 'ORB_30M';
  const rangeBars = is30m ? 4 : 2;
  const orb = timeline.slice(0, Math.min(rangeBars, timeline.length));
  const hi = Math.max(...orb.map((c: any) => c.spot || 0));
  const lo = Math.min(...orb.map((c: any) => c.spot || Infinity));

  for (let i = rangeBars; i < timeline.length; i++) {
    const pt = timeline[i];
    if (pt.spot > hi) return { entryIdx: i, direction: 'CALL' };
    if (pt.spot < lo) return { entryIdx: i, direction: 'PUT' };
  }
  const defDir = type.includes('CALL') || type.includes('CE') ? 'CALL' : type.includes('PUT') || type.includes('PE') ? 'PUT' : 'BOTH';
  return { entryIdx: 0, direction: defDir };
}

/** Walks the shared reference timeline (drives the time axis + breakout
 * detection); `portfolioValue` combines every leg's own premium series
 * (independent strikes) into one signed position value at each timestamp. */
function trackTradeProgression(timeline: any[], entryIdx: number, entryValue: number, riskBase: number, portfolioValue: (time: string, fallback: number) => number, cfg: any) {
  let exitIdx = timeline.length - 1, reason = 'EOD 15:20', status = 'EOD_EXIT';
  let maxGain = 0, maxDrop = 0;

  for (let i = entryIdx; i < timeline.length; i++) {
    const pt = timeline[i];
    const curVal = portfolioValue(pt.time, entryValue);
    const pnlPts = curVal - entryValue;
    const roiPct = (pnlPts / riskBase) * 100;

    if (roiPct > maxGain) maxGain = roiPct;
    if (roiPct < maxDrop) maxDrop = roiPct;

    if (cfg.targetPct > 0 && roiPct >= cfg.targetPct) { exitIdx = i; reason = `Target +${cfg.targetPct}%`; status = 'TARGET_HIT'; break; }
    if (cfg.slPct > 0 && roiPct <= -cfg.slPct) { exitIdx = i; reason = `Stop Loss -${cfg.slPct}%`; status = 'SL_HIT'; break; }
    if (cfg.timeExit && pt.time >= cfg.timeExit) { exitIdx = i; reason = `Time Exit ${cfg.timeExit}`; status = 'TIME_EXIT'; break; }
  }
  return { exitIdx, reason, status, maxGain, maxDrop };
}

/**
 * Seeds well-known option trading strategies across NIFTY and BANKNIFTY
 * so standard setups are immediately active and visible in the UI.
 */
export async function seedStandardStrategies(
  client: any,
  market: any,
  paper: any
): Promise<number> {
  // Warm the real lot-size cache for every watchlist symbol on every boot —
  // before the early-return below, so a restart with strategies already
  // seeded (the normal case) still primes it for the autonomous scanner's
  // first strategy build, not just a fresh seed.
  await Promise.all(Object.keys(INDEX_INSTRUMENTS).map((sym) => warmLotSizeCache(client, sym)));
  try {
    const existing = await listPaperStrategies();
    if (existing && existing.length >= 4) return 0;

    let count = 0;
    const niftyExpiry = nearestIndexExpiry('NIFTY');
    const niftySecId = Number(INDEX_INSTRUMENTS.NIFTY.securityId);
    let niftyRows: any[] = [];
    try {
      const chain = await client.optionChain?.fetchNormalized?.({ underlyingScrip: niftySecId, underlyingSeg: 'IDX_I', expiry: niftyExpiry });
      niftyRows = chain?.strikes || chain || [];
    } catch { /* non-fatal */ }

    const niftySpot = market.getLtp(niftySecId) || 24000;
    if (niftyRows.length > 0) {
      const ic = buildIronCondor('NIFTY', niftySpot, niftyRows, niftyExpiry, 1);
      if (ic) { await deploySeeded(ic, paper, market); count++; }

      const bps = buildCreditSpread('NIFTY', 'BULLISH', niftySpot, niftyRows, niftyExpiry, 1);
      if (bps) { await deploySeeded(bps, paper, market); count++; }

      const orb = buildOrbBuyingStrategy('NIFTY', niftySpot, niftyRows, niftyExpiry, 1, 'BULLISH');
      if (orb) { await deploySeeded(orb, paper, market); count++; }

      const vwap = buildVwapPullbackStrategy('NIFTY', niftySpot, niftyRows, niftyExpiry, 1, 'BULLISH');
      if (vwap) { await deploySeeded(vwap, paper, market); count++; }
    }

    const bnfExpiry = nearestIndexExpiry('BANKNIFTY');
    const bnfSecId = Number(INDEX_INSTRUMENTS.BANKNIFTY.securityId);
    let bnfRows: any[] = [];
    try {
      const chain = await client.optionChain?.fetchNormalized?.({ underlyingScrip: bnfSecId, underlyingSeg: 'IDX_I', expiry: bnfExpiry });
      bnfRows = chain?.strikes || chain || [];
    } catch { /* non-fatal */ }

    const bnfSpot = market.getLtp(bnfSecId) || 57200;
    if (bnfRows.length > 0) {
      const ib = buildIronButterfly('BANKNIFTY', bnfSpot, bnfRows, bnfExpiry, 1);
      if (ib) { await deploySeeded(ib, paper, market); count++; }

      const bcs = buildCreditSpread('BANKNIFTY', 'BEARISH', bnfSpot, bnfRows, bnfExpiry, 1);
      if (bcs) { await deploySeeded(bcs, paper, market); count++; }
    }

    // 3. FINNIFTY Strategies
    const finExpiry = nearestIndexExpiry('FINNIFTY');
    const finSecId = Number(INDEX_INSTRUMENTS.FINNIFTY?.securityId || '27');
    let finRows: any[] = [];
    try {
      const chain = await client.optionChain?.fetchNormalized?.({ underlyingScrip: finSecId, underlyingSeg: 'IDX_I', expiry: finExpiry });
      finRows = chain?.strikes || chain || [];
    } catch { /* non-fatal */ }

    const finSpot = market.getLtp(finSecId) || 25900;
    if (finRows.length > 0) {
      const strad = buildStraddle('FINNIFTY', finSpot, finRows, finExpiry, 1, 'SELL');
      if (strad) { await deploySeeded(strad, paper, market); count++; }

      const ds = buildDebitSpread('FINNIFTY', 'BULLISH', finSpot, finRows, finExpiry, 1);
      if (ds) { await deploySeeded(ds, paper, market); count++; }
    }

    // 4. SENSEX Strategies (BSE F&O)
    const snxExpiry = nearestIndexExpiry('SENSEX');
    const snxSecId = Number(INDEX_INSTRUMENTS.SENSEX?.securityId || '51');
    let snxRows: any[] = [];
    try {
      const chain = await client.optionChain?.fetchNormalized?.({ underlyingScrip: snxSecId, underlyingSeg: 'IDX_I', expiry: snxExpiry });
      snxRows = chain?.strikes || chain || [];
    } catch { /* non-fatal */ }

    const snxSpot = market.getLtp(snxSecId) || 76900;
    if (snxRows.length > 0) {
      const ic = buildIronCondor('SENSEX', snxSpot, snxRows, snxExpiry, 1);
      if (ic) { await deploySeeded(ic, paper, market); count++; }

      const orb = buildOrbBuyingStrategy('SENSEX', snxSpot, snxRows, snxExpiry, 1, 'BEARISH');
      if (orb) { await deploySeeded(orb, paper, market); count++; }
    }

    // 5. MIDCPNIFTY Strategies
    const midExpiry = nearestIndexExpiry('MIDCPNIFTY');
    const midSecId = Number(INDEX_INSTRUMENTS.MIDCPNIFTY?.securityId || '442');
    let midRows: any[] = [];
    try {
      const chain = await client.optionChain?.fetchNormalized?.({ underlyingScrip: midSecId, underlyingSeg: 'IDX_I', expiry: midExpiry });
      midRows = chain?.strikes || chain || [];
    } catch { /* non-fatal */ }

    const midSpot = market.getLtp(midSecId) || 12800;
    if (midRows.length > 0) {
      const bps = buildCreditSpread('MIDCPNIFTY', 'BULLISH', midSpot, midRows, midExpiry, 1);
      if (bps) { await deploySeeded(bps, paper, market); count++; }
    }

    eventBus.log('SYSTEM', `Seeded ${count} standard option trading strategies across all watchlist indices`, 'strategy_engine');
    return count;
  } catch (e: any) {
    eventBus.log('WARN', `Strategy seeding notice: ${e.message}`, 'strategy_engine');
    return 0;
  }
}

async function deploySeeded(strat: ConstructedStrategy, _paper: any, market: any): Promise<void> {
  try {
    market.addInstruments(strat.legs.map((l) => ({ securityId: l.securityId, exchangeSegment: l.exchangeSegment || 'NSE_FNO' })));
    await createPaperStrategy({
      id: strat.id,
      name: strat.name,
      symbol: strat.symbol,
      type: strat.type,
      lots: strat.lots,
      legs: strat.legs,
      status: 'MONITORING',
    });
    eventBus.log('SYSTEM', `Strategy ${strat.name} [MONITORING] — subscribed & waiting for entry signal / AI trigger`, 'strategy_engine');
  } catch { /* non-fatal */ }
}
