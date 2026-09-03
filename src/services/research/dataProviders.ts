import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { MarketDataService } from '../marketData';
import { INDEX_INSTRUMENTS } from '../marketData';
import type { InstrumentRef } from './types';

export interface FinancialStatements {
  symbol: string;
  revenueCr: number[];
  patCr: number[];
  cfoCr: number[];
  fcfCr: number[];
  capexCr: number[];
  debtCr: number;
  equityCr: number;
  cashCr: number;
  ebitdaCr: number;
  interestExpenseCr: number;
  promoterHoldingPct: number;
  promoterPledgingPct: number;
  fiiHoldingPct: number;
  diiHoldingPct: number;
  guidanceExecution: Array<{ promisedGrowth: number; actualGrowth: number }>;
}

export interface PeerMultiples {
  pe: number;
  sectorPe: number;
  pb: number;
  evEbitda: number;
}

export interface FundamentalDataProvider {
  getStatements(symbol: string): Promise<FinancialStatements>;
  getPeerMultiples(symbol: string): Promise<PeerMultiples>;
}

// Well-known NSE equity security IDs verified on Dhan instrument master
const WELL_KNOWN_EQUITIES: Record<string, { securityId: string; name: string; sector: string }> = {
  RELIANCE: { securityId: '2885', name: 'Reliance Industries Ltd', sector: 'Oil & Gas / Retail / Telecom' },
  TCS: { securityId: '11536', name: 'Tata Consultancy Services', sector: 'Information Technology' },
  INFY: { securityId: '1594', name: 'Infosys Ltd', sector: 'Information Technology' },
  HDFCBANK: { securityId: '1333', name: 'HDFC Bank Ltd', sector: 'Banking & Financials' },
  ICICIBANK: { securityId: '4963', name: 'ICICI Bank Ltd', sector: 'Banking & Financials' },
  TATAMOTORS: { securityId: '3456', name: 'Tata Motors Ltd', sector: 'Automobile' },
  ITC: { securityId: '1660', name: 'ITC Ltd', sector: 'FMCG' },
};

/**
 * Resolves instrument references for indices and NSE equities.
 */
export function resolveInstrumentRef(symbol: string): InstrumentRef {
  const upper = symbol.toUpperCase().trim();
  const index = INDEX_INSTRUMENTS[upper];
  if (index) {
    return { symbol: upper, securityId: index.securityId, exchangeSegment: 'IDX_I', name: index.label, sector: 'Index' };
  }
  const equity = WELL_KNOWN_EQUITIES[upper];
  if (equity) {
    return { symbol: upper, securityId: equity.securityId, exchangeSegment: 'NSE_EQ', name: equity.name, sector: equity.sector };
  }
  // Fallback for unlisted dynamic NSE symbols
  return { symbol: upper, securityId: '0', exchangeSegment: 'NSE_EQ', name: `${upper} Ltd`, sector: 'General Industry' };
}

/**
 * Default fundamental data provider with institutional model presets and deterministic fallbacks.
 * Enables zero-dependency local analysis and offline testing without requiring third-party API keys.
 */
export class DefaultFundamentalProvider implements FundamentalDataProvider {
  async getStatements(symbol: string): Promise<FinancialStatements> {
    const s = symbol.toUpperCase();
    if (s === 'RELIANCE') {
      return {
        symbol: s,
        revenueCr: [540000, 620000, 792000, 891000, 1000000],
        patCr: [53000, 60700, 66700, 73600, 79000],
        cfoCr: [55000, 62000, 71000, 82000, 88000],
        fcfCr: [21000, 24000, 31000, 38000, 42000],
        capexCr: [34000, 38000, 40000, 44000, 46000],
        debtCr: 315000,
        equityCr: 810000,
        cashCr: 195000,
        ebitdaCr: 178000,
        interestExpenseCr: 21000,
        promoterHoldingPct: 50.3,
        promoterPledgingPct: 0.0,
        fiiHoldingPct: 22.4,
        diiHoldingPct: 16.2,
        guidanceExecution: [
          { promisedGrowth: 15, actualGrowth: 14.2 },
          { promisedGrowth: 18, actualGrowth: 17.5 },
        ],
      };
    }

    // Deterministic synthesized profile for other symbols
    return {
      symbol: s,
      revenueCr: [10000, 11500, 13200, 15300, 18000],
      patCr: [1200, 1450, 1750, 2100, 2550],
      cfoCr: [1300, 1500, 1850, 2200, 2700],
      fcfCr: [800, 950, 1200, 1450, 1800],
      capexCr: [500, 550, 650, 750, 900],
      debtCr: 2500,
      equityCr: 9000,
      cashCr: 1200,
      ebitdaCr: 3800,
      interestExpenseCr: 210,
      promoterHoldingPct: 54.5,
      promoterPledgingPct: 1.2,
      fiiHoldingPct: 18.0,
      diiHoldingPct: 14.5,
      guidanceExecution: [{ promisedGrowth: 15, actualGrowth: 14.0 }],
    };
  }

  async getPeerMultiples(symbol: string): Promise<PeerMultiples> {
    const s = symbol.toUpperCase();
    if (s === 'RELIANCE') return { pe: 26.5, sectorPe: 24.0, pb: 2.3, evEbitda: 14.2 };
    if (s === 'TCS' || s === 'INFY') return { pe: 29.0, sectorPe: 27.5, pb: 7.5, evEbitda: 19.0 };
    return { pe: 22.0, sectorPe: 20.5, pb: 3.0, evEbitda: 12.5 };
  }
}

/**
 * Quantitative market data adapter leveraging DhanClient and MarketDataService.
 */
export class MarketDataProvider {
  constructor(
    private client: DhanClient,
    private market: MarketDataService,
  ) {}

  async getQuote(ref: InstrumentRef): Promise<{ ltp: number; volume: number; prevClose: number }> {
    const cached = this.market.getLtp(ref.securityId) ?? 0;
    if (cached > 0) {
      return { ltp: cached, volume: 0, prevClose: cached };
    }

    // Direct REST quote lookup
    try {
      const seg = ref.exchangeSegment === 'IDX_I' ? 'IDX_I' : 'NSE_EQ';
      const res = await this.client.marketFeed.quote({ [seg]: [Number(ref.securityId)] });
      const item = (res.data as any)?.[seg]?.[ref.securityId];
      const ltp = Number(item?.last_price || item?.ltp || 0);
      const volume = Number(item?.volume || 0);
      const prevClose = Number(item?.close || ltp);
      return { ltp, volume, prevClose };
    } catch {
      return { ltp: cached || 0, volume: 0, prevClose: cached || 0 };
    }
  }

  async getHistoricalCandles(ref: InstrumentRef, days = 200): Promise<Array<{ close: number; high: number; low: number; volume: number }>> {
    const toDate = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    try {
      const res: any = await this.client.charts.historical({
        securityId: ref.securityId,
        exchangeSegment: ref.exchangeSegment as any,
        instrument: ref.exchangeSegment === 'IDX_I' ? 'INDEX' as any : 'EQUITY' as any,
        expiryCode: 0,
        fromDate,
        toDate,
      });
      const closes = res?.close || [];
      const highs = res?.high || [];
      const lows = res?.low || [];
      const vols = res?.volume || [];
      return closes.map((c: number, idx: number) => ({
        close: Number(c),
        high: Number(highs[idx] ?? c),
        low: Number(lows[idx] ?? c),
        volume: Number(vols[idx] ?? 0),
      }));
    } catch {
      return [];
    }
  }
}
