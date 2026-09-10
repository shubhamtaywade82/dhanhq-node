import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { MarketDataService } from '../marketData';
import { INDEX_INSTRUMENTS } from '../marketData';
import { resolveSymbol, type ExchangePreference } from './universe';
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

/**
 * Resolves an index or equity to a live instrument reference.
 *
 * Equities are looked up in the scrip master rather than a hardcoded table:
 * the old table had BHARTIARTL pointing at 317 (Bajaj Finance's id) and
 * TATAMOTORS at 3456 (now TMPV after the demerger), so those two symbols
 * silently analysed the wrong company.
 */
export async function resolveInstrumentRef(
  symbol: string,
  client?: any,
  exchange: ExchangePreference = 'NSE',
): Promise<InstrumentRef> {
  const upper = symbol.toUpperCase().trim();
  const index = INDEX_INSTRUMENTS[upper];
  if (index) {
    return { symbol: upper, securityId: index.securityId, exchangeSegment: 'IDX_I', name: index.label, sector: 'Index' };
  }
  if (client) {
    const resolved = await resolveSymbol(client, upper, exchange).catch(() => null);
    if (resolved) return resolved;
  }
  // Unresolvable: securityId '0' fetches nothing, which surfaces as missing
  // data downstream instead of as a plausible-looking wrong company.
  return { symbol: upper, securityId: '0', exchangeSegment: exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ', name: upper, sector: 'Unclassified' };
}

/**
 * SYNTHETIC fundamentals — not a data feed.
 *
 * There is no fundamentals provider wired to this system. This returns one
 * hardcoded RELIANCE profile and an identical made-up profile for every other
 * symbol, so any ranking built on it is meaningless (that is exactly how the
 * old screener came to pass all ten symbols with the same score). The
 * screener no longer consumes it; it survives only to keep the deep-dive
 * analysis path running, and anything it produces must be presented as an
 * illustrative model, never as reported financials.
 */
export class DefaultFundamentalProvider implements FundamentalDataProvider {
  readonly isSynthetic = true;

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
    private dhan: DhanClient,
    private market: MarketDataService,
  ) {}

  /** Exposed so callers can resolve universes against the same scrip master
   * this provider fetches prices from. */
  get client(): DhanClient { return this.dhan; }

  async getQuote(ref: InstrumentRef): Promise<{ ltp: number; volume: number; prevClose: number }> {
    const cached = this.market.getLtp(ref.securityId) ?? 0;
    if (cached > 0) {
      return { ltp: cached, volume: 0, prevClose: cached };
    }

    // Direct REST quote lookup
    try {
      // Honours the instrument's real segment. This used to force NSE_EQ for
      // anything non-index, so a BSE instrument was queried against NSE with
      // a BSE security id — wrong instrument or no data, silently.
      const seg = ref.exchangeSegment;
      const res = await this.dhan.marketFeed.quote({ [seg]: [Number(ref.securityId)] });
      const item = (res.data as any)?.[seg]?.[ref.securityId];
      const ltp = Number(item?.last_price || item?.ltp || 0);
      const volume = Number(item?.volume || 0);
      const prevClose = Number(item?.close || ltp);
      return { ltp, volume, prevClose };
    } catch {
      return { ltp: cached || 0, volume: 0, prevClose: cached || 0 };
    }
  }

  /** NIFTY 50 daily closes — the benchmark every relative-strength number in
   * the screener is measured against. */
  async getBenchmarkCandles(days = 400): Promise<Array<{ close: number; high: number; low: number; volume: number }>> {
    const nifty = INDEX_INSTRUMENTS.NIFTY;
    if (!nifty) return [];
    return this.getHistoricalCandles(
      { symbol: 'NIFTY', securityId: nifty.securityId, exchangeSegment: 'IDX_I' },
      days,
    );
  }

  async getHistoricalCandles(ref: InstrumentRef, days = 200): Promise<Array<{ close: number; high: number; low: number; volume: number }>> {
    const toDate = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    try {
      const res: any = await this.dhan.charts.historical({
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
    } catch (e: any) {
      // Deliberately propagates. Swallowing this and returning [] made a
      // dropped request indistinguishable from a stock with no price
      // history: TECHM was reported as "insufficient history" on every
      // screen while returning 271 clean candles when fetched on its own.
      // Callers retry and classify the failure; they cannot do either if the
      // error never reaches them.
      throw new Error(`Historical fetch failed for ${ref.symbol} (${ref.exchangeSegment}/${ref.securityId}): ${e.message}`);
    }
  }
}
