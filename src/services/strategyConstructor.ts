import { selectStrikeByDelta } from './optionsAnalytics';

export interface StrategyLeg {
  instrument: string;
  securityId: string;
  side: 'BUY' | 'SELL';
  qty: number;
  strike: number;
  optionType: 'CE' | 'PE';
  price: number;
  exchangeSegment: string;
}

export interface ConstructedStrategy {
  id: string;
  name: string;
  symbol: string;
  type: 'IRON_CONDOR' | 'BULL_PUT_SPREAD' | 'BEAR_CALL_SPREAD' | 'STRADDLE' | 'STRANGLE';
  lots: number;
  legs: StrategyLeg[];
  estimatedNetPremium: number; // positive = credit received, negative = debit paid
  lotSize: number;
}

const LOT_SIZES: Record<string, number> = {
  NIFTY: 25, // Updated NSE lot size
  BANKNIFTY: 15,
  FINNIFTY: 25,
  MIDCPNIFTY: 50,
};

export function getLotSize(symbol: string): number {
  return LOT_SIZES[symbol.toUpperCase()] || 25;
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

// ── Helpers ───────────────────────────────────────────────────────

function toLeg(row: any, type: 'CALL' | 'PUT', side: 'BUY' | 'SELL', qty: number, symbol: string): StrategyLeg {
  const leg = row.targetLeg || (type === 'CALL' ? row.ce : row.pe) || {};
  const strike = row.strike;
  const optSuffix = type === 'CALL' ? 'CE' : 'PE';
  const sym = leg.tradingSymbol || leg.symbol || `${symbol}${strike}${optSuffix}`;

  return {
    instrument: sym,
    securityId: String(leg.securityId || leg.security_id || '0'),
    side,
    qty,
    strike,
    optionType: optSuffix,
    price: Number(leg.ltp || leg.lastPrice || 0),
    exchangeSegment: 'NSE_FNO',
  };
}
