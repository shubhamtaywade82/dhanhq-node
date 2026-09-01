import { selectStrikeByDelta, selectStrikeByPremiumTarget } from './optionsAnalytics';

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

export type StrategyType =
  | 'IRON_CONDOR'
  | 'BULL_PUT_SPREAD'
  | 'BEAR_CALL_SPREAD'
  | 'STRADDLE'
  | 'STRANGLE'
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

// SEBI revised lot sizes effective 2025–2026 (target ₹15–20L contract value).
const LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  SENSEX: 20,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
};

export function getLotSize(symbol: string): number {
  return LOT_SIZES[symbol.toUpperCase()] || 65;
}

/**
 * Calculates accurate Indian F&O frictions (STT 0.10% on sell, ₹20 brokerage, 18% GST, 0.20% slippage).
 */
export function calculateFnoFrictions(entryPrem: number, exitPrem: number, qty: number) {
  const sellTurnover = exitPrem * qty;
  const totalTurnover = (entryPrem + exitPrem) * qty;

  // STT: 0.10% charged on SELL side of options premium (post Oct 1, 2024).
  const stt = Number((sellTurnover * 0.0010).toFixed(2));
  const brokerage = 40; // ₹20 entry + ₹20 exit
  const exchange = Number((totalTurnover * 0.0005).toFixed(2)); // ~0.05% turnover
  const gst = Number(((brokerage + exchange) * 0.18).toFixed(2));
  const slippage = Number((totalTurnover * 0.0020).toFixed(2)); // 0.20% realistic slippage
  const totalFriction = Number((stt + brokerage + gst + exchange + slippage).toFixed(2));

  return { stt, brokerage, gst, exchange, slippage, totalFriction };
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
  const targetPct = cfg.targetPct ?? 20, slPct = cfg.slPct ?? 15, timeExit = cfg.timeExit || '13:30', lots = cfg.lots || 1;
  const lotSize = getLotSize(symbol);
  const isShort = (cfg.side || (type.includes('SPREAD') || type === 'IRON_CONDOR' ? 'SELL' : 'BUY')) === 'SELL';

  const days: BacktestDayResult[] = (daysData || []).map((d) =>
    simulateDayBacktest(d, type, { targetPct, slPct, timeExit, lots, lotSize, isShort, entryType: cfg.entryType || type, skipMidday: cfg.skipMidday ?? true })
  );

  const wins = days.filter((d) => d.netPnlInr > 0).length, totalDays = days.length;
  const winRate = totalDays > 0 ? Number(((wins / totalDays) * 100).toFixed(1)) : 0;
  const totalPnl = Number(days.reduce((s, d) => s + d.pnl, 0).toFixed(2));
  const totalPnlInr = Number((totalPnl * lotSize * lots).toFixed(2));
  const netPnlInr = Number(days.reduce((s, d) => s + d.netPnlInr, 0).toFixed(2));
  const totalFrictionInr = Number(days.reduce((s, d) => s + d.frictionInr, 0).toFixed(2));
  const grossProfit = days.filter((d) => d.netPnlInr > 0).reduce((s, d) => s + d.netPnlInr, 0);
  const grossLoss = Math.abs(days.filter((d) => d.netPnlInr < 0).reduce((s, d) => s + d.netPnlInr, 0));
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99 : 0);
  const maxDrawdownRoi = days.length > 0 ? Math.min(...days.map((d) => d.maxDrawdown)) : 0;
  const avgRoi = totalDays > 0 ? Number((days.reduce((s, d) => s + d.netRoi, 0) / totalDays).toFixed(1)) : 0;
  const passedValidation = winRate >= 45 && (profitFactor >= 1.2 || grossLoss === 0) && maxDrawdownRoi > -40;

  return { symbol, strategyType: type, totalDays, wins, winRate, totalPnl, totalPnlInr, netPnlInr, totalFrictionInr, profitFactor, maxDrawdownRoi, avgRoi, passedValidation, days };
}

function simulateDayBacktest(day: any, type: string, cfg: any): BacktestDayResult {
  const timeline = day?.timeline || [];
  const atm = day?.strikes?.find((s: any) => s.label === 'ATM') || day?.strikes?.[0] || {};
  if (!timeline.length) {
    return { date: day?.date || '', pnl: 0, pnlInr: 0, netPnlInr: 0, frictionInr: 0, roi: 0, netRoi: 0, maxProfit: 0, maxDrawdown: 0, status: 'NO_DATA', reason: 'No timeline' };
  }

  const { entryIdx, direction } = findEntrySignal(timeline, type, cfg);
  const entry = timeline[entryIdx] || timeline[0];
  const isCall = direction === 'CALL' || type.includes('CALL') || (type.includes('CE') && !type.includes('PE'));
  const isPut = direction === 'PUT' || type.includes('PUT') || (type.includes('PE') && !type.includes('CE'));

  const entryBase = isCall ? (entry.ce || atm.call?.open || 1) : (isPut ? (entry.pe || atm.put?.open || 1) : (entry.straddle || (atm.call?.open + atm.put?.open) || 1));
  const sim = trackTradeProgression(timeline, entryIdx, entryBase, isCall, isPut, cfg);

  const exitPt = timeline[sim.exitIdx] || timeline[timeline.length - 1];
  const exitVal = isCall ? exitPt.ce : (isPut ? exitPt.pe : exitPt.straddle);
  const finalPnl = Number((cfg.isShort ? entryBase - exitVal : exitVal - entryBase).toFixed(2));
  const grossPnlInr = Number((finalPnl * cfg.lotSize * cfg.lots).toFixed(2));
  const frictions = calculateFnoFrictions(entryBase, exitVal, cfg.lotSize * cfg.lots);
  const netPnlInr = Number((grossPnlInr - frictions.totalFriction).toFixed(2));
  const finalRoi = Number(((finalPnl / (entryBase || 1)) * 100).toFixed(1));
  const netRoi = Number(((netPnlInr / ((entryBase * cfg.lotSize * cfg.lots) || 1)) * 100).toFixed(1));

  return {
    date: day.date, pnl: finalPnl, pnlInr: grossPnlInr, netPnlInr, frictionInr: frictions.totalFriction,
    roi: finalRoi, netRoi, maxProfit: Number(sim.maxGain.toFixed(1)), maxDrawdown: Number(sim.maxDrop.toFixed(1)),
    status: sim.status, reason: sim.reason,
  };
}

function findEntrySignal(timeline: any[], type: string, cfg: any): { entryIdx: number; direction: 'CALL' | 'PUT' | 'BOTH' } {
  if ((type.includes('ORB') || cfg.entryType?.includes('ORB')) && timeline.length >= 15) {
    const rangeBars = type.includes('30M') || cfg.entryType === 'ORB_30M' ? 30 : 15;
    const orb = timeline.slice(0, Math.min(rangeBars, timeline.length));
    const hi = Math.max(...orb.map((c: any) => c.spot || 0)), lo = Math.min(...orb.map((c: any) => c.spot || Infinity));

    for (let i = rangeBars; i < timeline.length; i++) {
      if (cfg.skipMidday && timeline[i].time >= '11:00' && timeline[i].time <= '13:30') continue;
      if (timeline[i].spot > hi) return { entryIdx: i, direction: 'CALL' };
      if (timeline[i].spot < lo) return { entryIdx: i, direction: 'PUT' };
    }
  }
  return { entryIdx: 0, direction: 'BOTH' };
}

function trackTradeProgression(timeline: any[], entryIdx: number, entryBase: number, isCall: boolean, isPut: boolean, cfg: any) {
  let exitIdx = timeline.length - 1, reason = 'EOD 15:30', status = 'EOD_EXIT';
  let maxGain = 0, maxDrop = 0;

  for (let i = entryIdx; i < timeline.length; i++) {
    const pt = timeline[i];
    const curVal = isCall ? pt.ce : (isPut ? pt.pe : pt.straddle);
    const pnlPts = cfg.isShort ? (entryBase - curVal) : (curVal - entryBase);
    const roiPct = (pnlPts / (entryBase || 1)) * 100;

    if (roiPct > maxGain) maxGain = roiPct;
    if (roiPct < maxDrop) maxDrop = roiPct;

    if (cfg.targetPct > 0 && roiPct >= cfg.targetPct) { exitIdx = i; reason = `Target +${cfg.targetPct}%`; status = 'TARGET_HIT'; break; }
    if (cfg.slPct > 0 && roiPct <= -cfg.slPct) { exitIdx = i; reason = `Stop Loss -${cfg.slPct}%`; status = 'SL_HIT'; break; }
    if (pt.time >= cfg.timeExit) { exitIdx = i; reason = `Time Exit ${cfg.timeExit}`; status = 'TIME_EXIT'; break; }
  }
  return { exitIdx, reason, status, maxGain, maxDrop };
}
