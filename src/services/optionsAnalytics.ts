export interface OptionLegData {
  strike: number;
  type: 'CALL' | 'PUT';
  ltp: number;
  iv?: number;
  oi?: number;
  volume?: number;
  securityId?: string;
  tradingSymbol?: string;
}

export interface GreeksResult {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export interface OptionChainAnalytics {
  symbol: string;
  spot: number;
  expiry: string;
  pcrOi: number;
  pcrVolume: number;
  maxPainStrike: number;
  highestCallOiStrike: number;
  highestPutOiStrike: number;
  atmStrike: number;
  totalCallOi: number;
  totalPutOi: number;
  regime: 'HIGH_IV_RANGE' | 'LOW_IV_TREND' | 'EXPIRY_GAMMA' | 'NEUTRAL';
}

export interface PortfolioGreeks {
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  totalPositions: number;
}

/** Quick Black-Scholes calculation for an individual option leg. */
export function calculateGreeks(
  spot: number,
  strike: number,
  expiry: string,
  type: 'CALL' | 'PUT',
  ivHint = 0.15
): GreeksResult {
  const t = Math.max(1 / 365 / 24, yearsToExpiryDate(expiry));
  const r = 0.065;
  const sigma = Math.max(0.01, ivHint > 1 ? ivHint / 100 : ivHint);

  const d1 = (Math.log(spot / strike) + (r + (sigma * sigma) / 2) * t) / (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);

  const nd1 = normalCdf(d1);
  const npd1 = normalPdf(d1);

  const delta = type === 'CALL' ? nd1 : nd1 - 1;
  const gamma = npd1 / (spot * sigma * Math.sqrt(t));
  const theta = (-(spot * npd1 * sigma) / (2 * Math.sqrt(t))
    - (type === 'CALL' ? 1 : -1) * r * strike * Math.exp(-r * t) * normalCdf(type === 'CALL' ? d2 : -d2)) / 365;
  const vega = (spot * npd1 * Math.sqrt(t)) / 100;

  return {
    delta: Number(delta.toFixed(4)),
    gamma: Number(gamma.toFixed(6)),
    theta: Number(theta.toFixed(2)),
    vega: Number(vega.toFixed(2)),
    iv: Number((sigma * 100).toFixed(2)),
  };
}

export function analyzeOptionChain(
  symbol: string,
  chainRows: any[],
  spot: number,
  expiry: string,
  vix = 14
): OptionChainAnalytics {
  let totalCallOi = 0;
  let totalPutOi = 0;
  let totalCallVol = 0;
  let totalPutVol = 0;
  let maxCallOi = -1;
  let maxPutOi = -1;
  let highestCallOiStrike = spot;
  let highestPutOiStrike = spot;

  const strikeRows = normalizeRows(chainRows);
  for (const row of strikeRows) {
    const strike = row.strike;
    const cOi = Number(row.ce?.oi || row.ce?.openInterest || 0);
    const pOi = Number(row.pe?.oi || row.pe?.openInterest || 0);
    totalCallOi += cOi;
    totalPutOi += pOi;
    totalCallVol += Number(row.ce?.volume || 0);
    totalPutVol += Number(row.pe?.volume || 0);

    if (cOi > maxCallOi) { maxCallOi = cOi; highestCallOiStrike = strike; }
    if (pOi > maxPutOi) { maxPutOi = pOi; highestPutOiStrike = strike; }
  }

  const pcrOi = totalCallOi > 0 ? Number((totalPutOi / totalCallOi).toFixed(2)) : 1.0;
  const pcrVolume = totalCallVol > 0 ? Number((totalPutVol / totalCallVol).toFixed(2)) : 1.0;
  const maxPainStrike = computeMaxPain(strikeRows);
  const atmStrike = pickNearestStrike(strikeRows, spot);
  const regime = classifyRegime(vix, pcrOi, expiry);

  return {
    symbol, spot, expiry, pcrOi, pcrVolume, maxPainStrike,
    highestCallOiStrike, highestPutOiStrike, atmStrike,
    totalCallOi, totalPutOi, regime,
  };
}

export function selectStrikeByDelta(
  chainRows: any[],
  targetDelta: number,
  type: 'CALL' | 'PUT',
  spot: number,
  expiry: string
): any | null {
  const rows = normalizeRows(chainRows);
  if (rows.length === 0 || !spot) return null;

  let bestRow: any = null;
  let minDiff = Infinity;

  for (const row of rows) {
    const strike = row.strike;
    const leg = type === 'CALL' ? row.ce : row.pe;
    const iv = Number(leg?.iv || leg?.impliedVolatility || 15) / 100;
    const g = calculateGreeks(spot, strike, expiry, type, iv);
    const absDelta = Math.abs(g.delta);
    const diff = Math.abs(absDelta - Math.abs(targetDelta));

    if (diff < minDiff) {
      minDiff = diff;
      bestRow = { ...row, targetLeg: leg, greeks: g, strike };
    }
  }

  return bestRow;
}

/** Selects the strike row whose option premium (LTP) is closest to target (e.g. ₹200 for near-ITM ORB). */
export function selectStrikeByPremiumTarget(
  chainRows: any[],
  targetPremium: number,
  type: 'CALL' | 'PUT'
): any | null {
  const rows = normalizeRows(chainRows);
  if (rows.length === 0) return null;

  let bestRow: any = null;
  let minDiff = Infinity;

  for (const row of rows) {
    const leg = type === 'CALL' ? row.ce : row.pe;
    const ltp = Number(leg?.ltp ?? leg?.lastPrice ?? leg?.last_price ?? 0);
    if (ltp <= 0) continue;
    const diff = Math.abs(ltp - targetPremium);
    if (diff < minDiff) {
      minDiff = diff;
      bestRow = { ...row, targetLeg: leg, strike: row.strike };
    }
  }

  return bestRow || rows[0];
}

export function aggregatePortfolioGreeks(
  positions: Array<{ tradingSymbol: string; netQty: number; securityId?: string; ltp?: number }>,
  spotPrices: Record<string, number>,
  expiry: string
): PortfolioGreeks {
  let netDelta = 0;
  let netGamma = 0;
  let netTheta = 0;
  let netVega = 0;
  let count = 0;

  for (const pos of positions) {
    if (!pos.netQty || pos.netQty === 0) continue;
    const parsed = parseOptionSymbol(pos.tradingSymbol);
    if (!parsed) continue;

    const spot = spotPrices[parsed.underlying] || pos.ltp || 0;
    if (!spot) continue;

    const g = calculateGreeks(spot, parsed.strike, expiry, parsed.type);
    const multiplier = pos.netQty; // Positive for long, negative for short

    netDelta += g.delta * multiplier;
    netGamma += g.gamma * multiplier;
    netTheta += g.theta * multiplier;
    netVega += g.vega * multiplier;
    count++;
  }

  return {
    netDelta: Number(netDelta.toFixed(2)),
    netGamma: Number(netGamma.toFixed(4)),
    netTheta: Number(netTheta.toFixed(2)),
    netVega: Number(netVega.toFixed(2)),
    totalPositions: count,
  };
}

// ── Internal Helpers ──────────────────────────────────────────────

function normalizeRows(rows: any[]): Array<{ strike: number; ce: any; pe: any; raw: any }> {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    strike: Number(r.strike ?? r.Strike ?? r.strikePrice ?? 0),
    ce: r.ce || r.call || r.CALL || null,
    pe: r.pe || r.put || r.PUT || null,
    raw: r,
  })).filter((r) => Number.isFinite(r.strike) && r.strike > 0);
}

function computeMaxPain(rows: Array<{ strike: number; ce: any; pe: any }>): number {
  if (rows.length === 0) return 0;
  let minTotalLoss = Infinity;
  let maxPain = rows[0].strike;

  for (const expStrike of rows) {
    let totalLoss = 0;
    for (const cur of rows) {
      const callOi = Number(cur.ce?.oi || 0);
      const putOi = Number(cur.pe?.oi || 0);
      if (expStrike.strike > cur.strike) {
        totalLoss += (expStrike.strike - cur.strike) * callOi;
      } else if (expStrike.strike < cur.strike) {
        totalLoss += (cur.strike - expStrike.strike) * putOi;
      }
    }
    if (totalLoss < minTotalLoss) {
      minTotalLoss = totalLoss;
      maxPain = expStrike.strike;
    }
  }
  return maxPain;
}

function pickNearestStrike(rows: Array<{ strike: number }>, spot: number): number {
  if (rows.length === 0) return spot;
  let best = rows[0].strike;
  let minDiff = Math.abs(best - spot);
  for (const r of rows) {
    const diff = Math.abs(r.strike - spot);
    if (diff < minDiff) { minDiff = diff; best = r.strike; }
  }
  return best;
}

function classifyRegime(vix: number, pcr: number, expiry: string): OptionChainAnalytics['regime'] {
  const hoursLeft = (new Date(`${expiry}T15:30:00+05:30`).getTime() - Date.now()) / (3600 * 1000);
  if (hoursLeft > 0 && hoursLeft <= 6) return 'EXPIRY_GAMMA';
  if (vix >= 16.5) return 'HIGH_IV_RANGE';
  if (vix < 12.5 && (pcr > 1.25 || pcr < 0.75)) return 'LOW_IV_TREND';
  return 'NEUTRAL';
}

function parseOptionSymbol(symbol: string): { underlying: string; strike: number; type: 'CALL' | 'PUT' } | null {
  const match = symbol.match(/^([A-Z]+).*?(\d{4,6})(CE|PE)$/i);
  if (!match) return null;
  return {
    underlying: match[1].toUpperCase(),
    strike: Number(match[2]),
    type: match[3].toUpperCase() === 'CE' ? 'CALL' : 'PUT',
  };
}

function yearsToExpiryDate(expiry: string): number {
  const ms = new Date(`${expiry}T15:30:00+05:30`).getTime() - Date.now();
  return Math.max(1 / 365 / 24, ms / (365 * 24 * 3600 * 1000));
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function erf(x: number): number {
  const sign = Math.sign(x), absX = Math.abs(x), p = 0.3275911;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const t = 1 / (1 + p * absX);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return sign * (1 - poly * Math.exp(-absX * absX));
}
