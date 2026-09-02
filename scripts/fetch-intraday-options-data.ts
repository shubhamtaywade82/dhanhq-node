import dotenv from 'dotenv';
dotenv.config();

import { createDhanClient } from '../src/auth';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { nearestIndexExpiry } from '../src/services/marketHours';

/**
 * Target Indices configuration for NIFTY & SENSEX
 */
interface IndexConfig {
  symbol: 'NIFTY' | 'SENSEX';
  label: string;
  securityId: string;
  exchangeSegment: string;
  underlyingSeg: string;
  strikeStep: number;
}

const INDICES: readonly IndexConfig[] = [
  { symbol: 'NIFTY', label: 'NIFTY 50', securityId: '13', exchangeSegment: 'IDX_I', underlyingSeg: 'IDX_I', strikeStep: 50 },
  { symbol: 'SENSEX', label: 'BSE SENSEX', securityId: '51', exchangeSegment: 'IDX_I', underlyingSeg: 'IDX_I', strikeStep: 100 },
];

/**
 * Unified Market & Options Data Structure
 */
export interface IntradayCandle {
  timestamp: number;
  timeIst: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OptionStrikeEntry {
  strikePrice: number;
  distanceFromAtm: number;
  isAtm: boolean;
  ce: {
    securityId?: string;
    ltp: number;
    oi: number;
    volume: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
  pe: {
    securityId?: string;
    ltp: number;
    oi: number;
    volume: number;
    iv: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

export interface RollingOptionTimelinePoint {
  timeIst: string;
  spot: number;
  atmStrike: number;
  ceLtp: number;
  peLtp: number;
  combinedStraddle: number;
  ceIv: number;
  peIv: number;
}

export interface UnifiedIndexMarketData {
  symbol: 'NIFTY' | 'SENSEX';
  label: string;
  securityId: string;
  exchangeSegment: string;
  fetchedAtIst: string;
  spot: {
    ltp: number;
    prevClose: number;
    dayChange: number;
    dayChangePct: number;
    ohlc: { open: number; high: number; low: number; close: number };
    historicalIntradayCandles: IntradayCandle[];
  };
  optionsChain: {
    selectedExpiry: string;
    availableExpiries: string[];
    atmStrike: number;
    pcrOi: number;
    pcrVolume: number;
    maxPain: number;
    totalCallOi: number;
    totalPutOi: number;
    strikes: OptionStrikeEntry[];
  };
  rollingOptionsTimeline: RollingOptionTimelinePoint[];
}

export interface UnifiedMarketDataset {
  generatedAt: string;
  environment: string;
  indices: Record<'NIFTY' | 'SENSEX', UnifiedIndexMarketData>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatPrice(val: number): string {
  return Number(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getIstTime(): string {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function getIstDateStr(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function computeMaxPain(strikes: OptionStrikeEntry[]): number {
  if (!strikes.length) return 0;
  let minLoss = Number.MAX_VALUE;
  let maxPainStrike = strikes[0].strikePrice;

  for (const target of strikes) {
    let totalLoss = 0;
    for (const s of strikes) {
      if (s.strikePrice < target.strikePrice) {
        totalLoss += (target.strikePrice - s.strikePrice) * (s.ce.oi || 0);
      } else if (s.strikePrice > target.strikePrice) {
        totalLoss += (s.strikePrice - target.strikePrice) * (s.pe.oi || 0);
      }
    }
    if (totalLoss < minLoss) {
      minLoss = totalLoss;
      maxPainStrike = target.strikePrice;
    }
  }
  return maxPainStrike;
}

// ── Fetchers ────────────────────────────────────────────────────────────

async function fetchSpotIntradayAndOhlc(client: DhanClient, index: IndexConfig): Promise<{
  ltp: number;
  prevClose: number;
  dayChange: number;
  dayChangePct: number;
  ohlc: { open: number; high: number; low: number; close: number };
  historicalIntradayCandles: IntradayCandle[];
}> {
  const toDate = getIstDateStr();
  const dFrom = new Date();
  dFrom.setDate(dFrom.getDate() - 5);
  const fromDate = getIstDateStr(dFrom);

  // 1. Fetch live quote for latest spot baseline
  let ltp = 0, prevClose = 0, open = 0, high = 0, low = 0, close = 0;
  try {
    const quoteRes = await (client as any).marketFeed?.quote?.({
      [index.exchangeSegment]: [Number(index.securityId)],
    });
    const q = quoteRes?.data?.[index.exchangeSegment]?.[index.securityId] || quoteRes?.[index.exchangeSegment]?.[index.securityId];
    if (q) {
      ltp = Number(q.last_price || q.ltp || 0);
      prevClose = Number(q.ohlc?.close || q.prevClose || ltp);
      open = Number(q.ohlc?.open || q.open || ltp);
      high = Number(q.ohlc?.high || q.high || ltp);
      low = Number(q.ohlc?.low || q.low || ltp);
      close = ltp || prevClose;
    }
  } catch { /* non-fatal fallback */ }

  // 2. Fetch intraday / historical candles
  const candles: IntradayCandle[] = [];
  try {
    const hist = await (client as any).charts.historical({
      securityId: index.securityId,
      exchangeSegment: index.exchangeSegment,
      instrument: 'INDEX',
      expiryCode: 0,
      fromDate,
      toDate,
    });
    const d = hist?.data || hist;
    if (d && Array.isArray(d.open) && d.open.length > 0) {
      for (let i = 0; i < d.open.length; i++) {
        const ts = typeof d.timestamp[i] === 'number' ? d.timestamp[i] : Date.parse(d.timestamp[i]) / 1000;
        const timeIst = new Date(ts * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        candles.push({
          timestamp: ts,
          timeIst,
          open: Number(d.open[i]),
          high: Number(d.high[i]),
          low: Number(d.low[i]),
          close: Number(d.close[i]),
          volume: Number(d.volume?.[i] || 0),
        });
      }
      const last = candles[candles.length - 1];
      if (!ltp && last) {
        ltp = last.close;
        close = last.close;
        open = candles[0].open;
        high = Math.max(...candles.map((c) => c.high));
        low = Math.min(...candles.map((c) => c.low));
      }
    }
  } catch { /* non-fatal */ }

  const dayChange = prevClose ? Number((ltp - prevClose).toFixed(2)) : 0;
  const dayChangePct = prevClose ? Number(((dayChange / prevClose) * 100).toFixed(2)) : 0;

  return {
    ltp,
    prevClose,
    dayChange,
    dayChangePct,
    ohlc: { open, high, low, close },
    historicalIntradayCandles: candles,
  };
}

async function fetchOptionsChainData(
  client: DhanClient,
  index: IndexConfig,
  spotPrice: number,
): Promise<{
  selectedExpiry: string;
  availableExpiries: string[];
  atmStrike: number;
  pcrOi: number;
  pcrVolume: number;
  maxPain: number;
  totalCallOi: number;
  totalPutOi: number;
  strikes: OptionStrikeEntry[];
}> {
  let expiries: string[] = [];
  try {
    const expListRes = await (client as any).optionChain?.expiryList?.({
      underlyingScrip: Number(index.securityId),
      underlyingSeg: index.underlyingSeg,
    });
    const list = expListRes?.data || expListRes?.expiryDates || expListRes;
    if (Array.isArray(list)) expiries = list;
  } catch { /* fallback */ }

  const selectedExpiry = (expiries && expiries.length > 0) ? expiries[0] : nearestIndexExpiry(index.symbol);

  let rawStrikes: any[] = [];
  let chainSpot = spotPrice;
  try {
    const chainRes = await (client as any).optionChain?.fetchNormalized?.({
      underlyingScrip: Number(index.securityId),
      underlyingSeg: index.underlyingSeg,
      expiry: selectedExpiry,
    });
    rawStrikes = chainRes?.strikes || chainRes?.data || [];
    if ((!chainSpot || chainSpot <= 0) && chainRes?.lastPrice) {
      chainSpot = Number(chainRes.lastPrice);
    }
  } catch { /* fallback */ }

  const atmStrike = chainSpot > 0 ? Math.round(chainSpot / index.strikeStep) * index.strikeStep : 0;
  let totalCallOi = 0, totalPutOi = 0, totalCallVol = 0, totalPutVol = 0;
  const strikes: OptionStrikeEntry[] = [];

  for (const r of rawStrikes) {
    const strikePrice = Number(r.strike || r.strikePrice || 0);
    if (!strikePrice) continue;

    const call = r.call || r.ce || {};
    const put = r.put || r.pe || {};

    const ceLtp = Number(call.last_price ?? call.ltp ?? 0);
    const peLtp = Number(put.last_price ?? put.ltp ?? 0);
    const ceOi = Number(call.oi ?? 0);
    const peOi = Number(put.oi ?? 0);
    const ceVol = Number(call.volume ?? 0);
    const peVol = Number(put.volume ?? 0);
    const ceIv = Number(call.implied_volatility ?? call.iv ?? 0);
    const peIv = Number(put.implied_volatility ?? put.iv ?? 0);
    const ceGreeks = call.greeks || {};
    const peGreeks = put.greeks || {};

    totalCallOi += ceOi;
    totalPutOi += peOi;
    totalCallVol += ceVol;
    totalPutVol += peVol;

    strikes.push({
      strikePrice,
      distanceFromAtm: strikePrice - atmStrike,
      isAtm: strikePrice === atmStrike,
      ce: {
        securityId: (call.security_id || call.securityId) ? String(call.security_id || call.securityId) : undefined,
        ltp: ceLtp,
        oi: ceOi,
        volume: ceVol,
        iv: Number(ceIv.toFixed(2)),
        delta: Number(Number(ceGreeks.delta ?? call.delta ?? 0).toFixed(4)),
        gamma: Number(Number(ceGreeks.gamma ?? call.gamma ?? 0).toFixed(5)),
        theta: Number(Number(ceGreeks.theta ?? call.theta ?? 0).toFixed(2)),
        vega: Number(Number(ceGreeks.vega ?? call.vega ?? 0).toFixed(2)),
      },
      pe: {
        securityId: (put.security_id || put.securityId) ? String(put.security_id || put.securityId) : undefined,
        ltp: peLtp,
        oi: peOi,
        volume: peVol,
        iv: Number(peIv.toFixed(2)),
        delta: Number(Number(peGreeks.delta ?? put.delta ?? 0).toFixed(4)),
        gamma: Number(Number(peGreeks.gamma ?? put.gamma ?? 0).toFixed(5)),
        theta: Number(Number(peGreeks.theta ?? put.theta ?? 0).toFixed(2)),
        vega: Number(Number(peGreeks.vega ?? put.vega ?? 0).toFixed(2)),
      },
    });
  }

  // Sort strikes numerically
  strikes.sort((a, b) => a.strikePrice - b.strikePrice);

  const pcrOi = totalCallOi > 0 ? Number((totalPutOi / totalCallOi).toFixed(3)) : 1.0;
  const pcrVolume = totalCallVol > 0 ? Number((totalPutVol / totalCallVol).toFixed(3)) : 1.0;
  const maxPain = computeMaxPain(strikes) || atmStrike;

  return {
    selectedExpiry,
    availableExpiries: expiries,
    atmStrike,
    pcrOi,
    pcrVolume,
    maxPain,
    totalCallOi,
    totalPutOi,
    strikes,
  };
}

async function fetchRollingOptionsTimeline(
  client: DhanClient,
  index: IndexConfig,
  atmStrike: number,
): Promise<RollingOptionTimelinePoint[]> {
  const dateStr = getIstDateStr();
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + 1);
  const toDate = getIstDateStr(nextDate);

  try {
    const base = {
      securityId: Number(index.securityId),
      exchangeSegment: 'NSE_FNO',
      instrument: 'OPTIDX',
      expiryFlag: 'WEEK',
      expiryCode: 1,
      strike: String(atmStrike),
      requiredData: ['open', 'high', 'low', 'close', 'iv', 'volume', 'strike', 'oi', 'spot'],
      fromDate: dateStr,
      toDate,
      interval: '1',
    };

    const [ceRes, peRes] = await Promise.all([
      (client as any).expiredOptionsData?.fetch?.({ ...base, drvOptionType: 'CALL' }).catch(() => null),
      (client as any).expiredOptionsData?.fetch?.({ ...base, drvOptionType: 'PUT' }).catch(() => null),
    ]);

    const cd = (ceRes as any)?.data?.ce || (ceRes as any)?.data;
    const pd = (peRes as any)?.data?.pe || (peRes as any)?.data;

    if (cd?.open?.length && pd?.open?.length) {
      const timeline: RollingOptionTimelinePoint[] = [];
      const step = Math.max(1, Math.floor(cd.open.length / 25)); // Sample ~25 intervals
      for (let i = 0; i < cd.open.length; i += step) {
        const ts = cd.timestamp?.[i] || 0;
        const timeIst = new Date(ts * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        const spot = Number(cd.spot?.[i] || 0);
        const ceLtp = Number(cd.close?.[i] || 0);
        const peLtp = Number(pd.close?.[i] || 0);
        timeline.push({
          timeIst,
          spot,
          atmStrike,
          ceLtp,
          peLtp,
          combinedStraddle: Number((ceLtp + peLtp).toFixed(2)),
          ceIv: Number(cd.iv?.[i] || 0),
          peIv: Number(pd.iv?.[i] || 0),
        });
      }
      return timeline;
    }
  } catch { /* non-fatal */ }

  return [];
}

// ── Orchestrator ────────────────────────────────────────────────────────

export async function fetchUnifiedMarketDataset(): Promise<UnifiedMarketDataset> {
  const client = await createDhanClient();
  const dataset: UnifiedMarketDataset = {
    generatedAt: new Date().toISOString(),
    environment: process.env.TRADING_MODE || 'paper',
    indices: {} as any,
  };

  for (const index of INDICES) {
    console.log(`\n[${getIstTime()} IST] ── Fetching Data for ${index.symbol} (${index.label}) ──`);

    // 1. Spot and Intraday OHLC
    const spotData = await fetchSpotIntradayAndOhlc(client, index);
    console.log(
      `  • Spot LTP: ${formatPrice(spotData.ltp)} | PrevClose: ${formatPrice(spotData.prevClose)} | Change: ${spotData.dayChange >= 0 ? '+' : ''}${spotData.dayChange} (${spotData.dayChangePct}%) | Intraday Candles: ${spotData.historicalIntradayCandles.length}`,
    );

    // 2. Options Chain
    const chainData = await fetchOptionsChainData(client, index, spotData.ltp);
    console.log(
      `  • Expiry: ${chainData.selectedExpiry} | ATM Strike: ${chainData.atmStrike} | MaxPain: ${chainData.maxPain} | PCR (OI): ${chainData.pcrOi} | Total Strikes: ${chainData.strikes.length}`,
    );

    // 3. Rolling Options Intraday Timeline
    const rollingTimeline = await fetchRollingOptionsTimeline(client, index, chainData.atmStrike);
    console.log(`  • Rolling ATM Straddle Points: ${rollingTimeline.length}`);

    dataset.indices[index.symbol] = {
      symbol: index.symbol,
      label: index.label,
      securityId: index.securityId,
      exchangeSegment: index.exchangeSegment,
      fetchedAtIst: `${getIstDateStr()} ${getIstTime()} IST`,
      spot: spotData,
      optionsChain: chainData,
      rollingOptionsTimeline: rollingTimeline,
    };
  }

  return dataset;
}

// ── Main CLI Runner ─────────────────────────────────────────────────────

async function main() {
  console.log(`========================================================================`);
  console.log(` DhanHQ-SDK Unified Intraday OHLC & Rolling Options Chain Extractor`);
  console.log(` Mode: ${process.env.TRADING_MODE || 'paper'} | Time: ${getIstTime()} IST`);
  console.log(`========================================================================`);

  try {
    const dataset = await fetchUnifiedMarketDataset();

    console.log(`\n========================================================================`);
    console.log(` Unified Dataset Generated Successfully (${Object.keys(dataset.indices).length} Indices)`);
    console.log(`========================================================================\n`);

    for (const sym of ['NIFTY', 'SENSEX'] as const) {
      const idx = dataset.indices[sym];
      if (!idx) continue;
      const atmEntry = idx.optionsChain.strikes.find((s) => s.isAtm) || idx.optionsChain.strikes.find((s) => Math.abs(s.distanceFromAtm) <= (sym === 'NIFTY' ? 50 : 100));
      console.log(`┌─ ${idx.symbol} (${idx.label}) Snapshot ────────────────────────────────────────`);
      console.log(`│ Spot LTP: ${formatPrice(idx.spot.ltp)} | O: ${formatPrice(idx.spot.ohlc.open)} H: ${formatPrice(idx.spot.ohlc.high)} L: ${formatPrice(idx.spot.ohlc.low)} C: ${formatPrice(idx.spot.ohlc.close)}`);
      console.log(`│ Expiry: ${idx.optionsChain.selectedExpiry} | ATM Strike: ${idx.optionsChain.atmStrike} | Max Pain: ${idx.optionsChain.maxPain} | PCR (OI): ${idx.optionsChain.pcrOi} | PCR (Vol): ${idx.optionsChain.pcrVolume}`);
      console.log(`│ Strikes Count: ${idx.optionsChain.strikes.length} | ATM Call (${atmEntry?.strikePrice || '-'} CE): ₹${formatPrice(atmEntry?.ce.ltp || 0)} (IV: ${atmEntry?.ce.iv}%, Δ: ${atmEntry?.ce.delta}) | ATM Put (${atmEntry?.strikePrice || '-'} PE): ₹${formatPrice(atmEntry?.pe.ltp || 0)} (IV: ${atmEntry?.pe.iv}%, Δ: ${atmEntry?.pe.delta})`);
      console.log(`│ Total Call OI: ${idx.optionsChain.totalCallOi.toLocaleString('en-IN')} | Total Put OI: ${idx.optionsChain.totalPutOi.toLocaleString('en-IN')}`);
      console.log(`│ Intraday Candles: ${idx.spot.historicalIntradayCandles.length} | Rolling Timeline Points: ${idx.rollingOptionsTimeline.length}`);
      console.log(`└────────────────────────────────────────────────────────────────────────\n`);
    }

    console.log(`✅ Ready to consume as typed data structure in trading algorithms and backtesters.`);
    process.exit(0);
  } catch (err: any) {
    console.error(`❌ Error extracting unified dataset: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
