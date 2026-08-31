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
  SENSEX: 10,
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

export interface BacktestConfig {
  entryType?: 'OPEN_915' | 'ORB_930';
  targetPct?: number;
  slPct?: number;
  timeExit?: string;
  side?: 'BUY' | 'SELL';
  lots?: number;
}

export interface BacktestDayResult {
  date: string;
  pnl: number;
  pnlInr: number;
  roi: number;
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
  profitFactor: number;
  maxDrawdownRoi: number;
  avgRoi: number;
  passedValidation: boolean;
  days: BacktestDayResult[];
}

export function evaluateStrategyBacktest(
  symbol: string,
  type: string,
  daysData: any[],
  cfg: BacktestConfig = {}
): BacktestReport {
  const targetPct = cfg.targetPct ?? 20;
  const slPct = cfg.slPct ?? 15;
  const timeExit = cfg.timeExit || '13:30';
  const lots = cfg.lots || 1;
  const lotSize = getLotSize(symbol);
  const isShort = (cfg.side || (type.includes('SPREAD') || type === 'IRON_CONDOR' ? 'SELL' : 'BUY')) === 'SELL';

  const days: BacktestDayResult[] = (daysData || []).map((d) =>
    simulateDayBacktest(d, type, { targetPct, slPct, timeExit, lots, lotSize, isShort, entryType: cfg.entryType || 'OPEN_915' })
  );

  const wins = days.filter((d) => d.pnl > 0).length;
  const totalDays = days.length;
  const winRate = totalDays > 0 ? Number(((wins / totalDays) * 100).toFixed(1)) : 0;
  const totalPnl = Number(days.reduce((s, d) => s + d.pnl, 0).toFixed(2));
  const totalPnlInr = Number((totalPnl * lotSize * lots).toFixed(2));
  const grossProfit = days.filter((d) => d.pnl > 0).reduce((s, d) => s + d.pnl, 0);
  const grossLoss = Math.abs(days.filter((d) => d.pnl < 0).reduce((s, d) => s + d.pnl, 0));
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99 : 0);
  const maxDrawdownRoi = days.length > 0 ? Math.min(...days.map((d) => d.maxDrawdown)) : 0;
  const avgRoi = totalDays > 0 ? Number((days.reduce((s, d) => s + d.roi, 0) / totalDays).toFixed(1)) : 0;
  const passedValidation = winRate >= 50 && (profitFactor >= 1.2 || grossLoss === 0) && maxDrawdownRoi > -40;

  return {
    symbol, strategyType: type, totalDays, wins, winRate,
    totalPnl, totalPnlInr, profitFactor, maxDrawdownRoi, avgRoi,
    passedValidation, days,
  };
}

function simulateDayBacktest(day: any, type: string, cfg: any): BacktestDayResult {
  const timeline = day?.timeline || [];
  const atm = day?.strikes?.find((s: any) => s.label === 'ATM') || day?.strikes?.[0] || {};
  if (!timeline.length) {
    return { date: day?.date || '', pnl: 0, pnlInr: 0, roi: 0, maxProfit: 0, maxDrawdown: 0, status: 'NO_DATA', reason: 'No timeline' };
  }

  let entryIdx = 0;
  if (cfg.entryType === 'ORB_930' && timeline.length > 15) {
    const orb = timeline.slice(0, 15);
    const hi = Math.max(...orb.map((c: any) => c.spot || 0)), lo = Math.min(...orb.map((c: any) => c.spot || Infinity));
    for (let i = 15; i < timeline.length; i++) {
      if (timeline[i].spot > hi || timeline[i].spot < lo) { entryIdx = i; break; }
    }
  }

  const entry = timeline[entryIdx] || timeline[0];
  const ce0 = atm.call?.open || 1, pe0 = atm.put?.open || 1;
  const entryBase = type.includes('CALL') ? (entry.ce || ce0) : (type.includes('PUT') ? (entry.pe || pe0) : (entry.straddle || ce0 + pe0));
  let exitIdx = timeline.length - 1, reason = 'EOD 15:30', status = 'EOD_EXIT';
  let maxGain = 0, maxDrop = 0;

  for (let i = entryIdx; i < timeline.length; i++) {
    const pt = timeline[i];
    const curVal = type.includes('CALL') ? pt.ce : (type.includes('PUT') ? pt.pe : pt.straddle);
    const pnlPts = cfg.isShort ? (entryBase - curVal) : (curVal - entryBase);
    const roiPct = (pnlPts / (entryBase || 1)) * 100;

    if (roiPct > maxGain) maxGain = roiPct;
    if (roiPct < maxDrop) maxDrop = roiPct;

    if (cfg.targetPct > 0 && roiPct >= cfg.targetPct) {
      exitIdx = i; reason = `Target +${cfg.targetPct}%`; status = 'TARGET_HIT'; break;
    }
    if (cfg.slPct > 0 && roiPct <= -cfg.slPct) {
      exitIdx = i; reason = `Stop Loss -${cfg.slPct}%`; status = 'SL_HIT'; break;
    }
    if (pt.time >= cfg.timeExit) {
      exitIdx = i; reason = `Time Exit ${cfg.timeExit}`; status = 'TIME_EXIT'; break;
    }
  }

  const exitPt = timeline[exitIdx] || timeline[timeline.length - 1];
  const exitVal = type.includes('CALL') ? exitPt.ce : (type.includes('PUT') ? exitPt.pe : exitPt.straddle);
  const finalPnl = Number((cfg.isShort ? entryBase - exitVal : exitVal - entryBase).toFixed(2));
  const finalRoi = Number(((finalPnl / (entryBase || 1)) * 100).toFixed(1));

  return {
    date: day.date, pnl: finalPnl, pnlInr: Number((finalPnl * cfg.lotSize * cfg.lots).toFixed(2)),
    roi: finalRoi, maxProfit: Number(maxGain.toFixed(1)), maxDrawdown: Number(maxDrop.toFixed(1)),
    status, reason,
  };
}
