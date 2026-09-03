import { type InstrumentRef } from './types';

/**
 * Predefined Indian equity stock universes with DhanHQ security IDs and sectors.
 * Enables deterministic multi-symbol screener scans across NSE segments.
 */

export const UNIVERSE_STOCKS: Record<string, { securityId: string; name: string; sector: string }> = {
  RELIANCE: { securityId: '2885', name: 'Reliance Industries Ltd', sector: 'Energy & Retail' },
  TCS: { securityId: '11536', name: 'Tata Consultancy Services', sector: 'Information Technology' },
  INFY: { securityId: '1594', name: 'Infosys Ltd', sector: 'Information Technology' },
  HDFCBANK: { securityId: '1333', name: 'HDFC Bank Ltd', sector: 'Banking & Financials' },
  ICICIBANK: { securityId: '4963', name: 'ICICI Bank Ltd', sector: 'Banking & Financials' },
  KOTAKBANK: { securityId: '1922', name: 'Kotak Mahindra Bank Ltd', sector: 'Banking & Financials' },
  AXISBANK: { securityId: '5900', name: 'Axis Bank Ltd', sector: 'Banking & Financials' },
  SBIN: { securityId: '3045', name: 'State Bank of India', sector: 'Banking & Financials' },
  BHARTIARTL: { securityId: '317', name: 'Bharti Airtel Ltd', sector: 'Telecommunications' },
  LT: { securityId: '11483', name: 'Larsen & Toubro Ltd', sector: 'Infrastructure' },
  TATAMOTORS: { securityId: '3456', name: 'Tata Motors Ltd', sector: 'Automobile' },
  MARUTI: { securityId: '10999', name: 'Maruti Suzuki India Ltd', sector: 'Automobile' },
  ITC: { securityId: '1660', name: 'ITC Ltd', sector: 'FMCG' },
  HINDUNILVR: { securityId: '1394', name: 'Hindustan Unilever Ltd', sector: 'FMCG' },
  TITAN: { securityId: '3506', name: 'Titan Company Ltd', sector: 'Consumer Discretionary' },
  ASIANPAINT: { securityId: '236', name: 'Asian Paints Ltd', sector: 'Consumer Goods' },
  BAJFINANCE: { securityId: '317', name: 'Bajaj Finance Ltd', sector: 'Financial Services' },
  BAJAJFINSV: { securityId: '16675', name: 'Bajaj Finserv Ltd', sector: 'Financial Services' },
  SUNPHARMA: { securityId: '3351', name: 'Sun Pharmaceutical Ltd', sector: 'Pharmaceuticals' },
  DRREDDY: { securityId: '881', name: 'Dr. Reddys Laboratories Ltd', sector: 'Pharmaceuticals' },
  WIPRO: { securityId: '3787', name: 'Wipro Ltd', sector: 'Information Technology' },
  HCLTECH: { securityId: '7229', name: 'HCL Technologies Ltd', sector: 'Information Technology' },
  TECHM: { securityId: '13538', name: 'Tech Mahindra Ltd', sector: 'Information Technology' },
  ULTRACEMCO: { securityId: '11532', name: 'UltraTech Cement Ltd', sector: 'Materials' },
  TATASTEEL: { securityId: '3499', name: 'Tata Steel Ltd', sector: 'Metals & Mining' },
  JSWSTEEL: { securityId: '11723', name: 'JSW Steel Ltd', sector: 'Metals & Mining' },
  NTPC: { securityId: '11630', name: 'NTPC Ltd', sector: 'Utilities' },
  POWERGRID: { securityId: '14977', name: 'Power Grid Corp Ltd', sector: 'Utilities' },
  ONGC: { securityId: '2475', name: 'Oil & Natural Gas Corp Ltd', sector: 'Energy' },
  COALINDIA: { securityId: '20374', name: 'Coal India Ltd', sector: 'Energy & Mining' },
};

export interface UniverseDef {
  id: string;
  name: string;
  description: string;
  symbols: string[];
}

export const UNIVERSES: Record<string, UniverseDef> = {
  NIFTY_50: {
    id: 'NIFTY_50',
    name: 'NIFTY 50 Core Leaders',
    description: 'Premier large-cap Indian enterprises across all market sectors',
    symbols: Object.keys(UNIVERSE_STOCKS),
  },
  FNO_HEAVYWEIGHTS: {
    id: 'FNO_HEAVYWEIGHTS',
    name: 'F&O High Liquidity Basket',
    description: 'Top liquid derivatives underlyings for multi-leg option execution',
    symbols: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'TATAMOTORS', 'SBIN', 'LT', 'ITC', 'MARUTI'],
  },
  BANKING_FINANCE: {
    id: 'BANKING_FINANCE',
    name: 'Banking & Financials',
    description: 'Tier-1 private, public lenders, and non-banking financial companies',
    symbols: ['HDFCBANK', 'ICICIBANK', 'KOTAKBANK', 'AXISBANK', 'SBIN', 'BAJFINANCE', 'BAJAJFINSV'],
  },
  IT_TECH: {
    id: 'IT_TECH',
    name: 'IT & Technology Services',
    description: 'Export-oriented Indian IT software services and digital leaders',
    symbols: ['TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM'],
  },
};

/**
 * Resolves instrument references for a specified universe ID.
 */
export function getUniverseSymbols(universeId: string): InstrumentRef[] {
  const def = UNIVERSES[universeId.toUpperCase()] || UNIVERSES.FNO_HEAVYWEIGHTS;
  return def.symbols.map((sym) => {
    const meta = UNIVERSE_STOCKS[sym] || { securityId: '0', name: `${sym} Ltd`, sector: 'Equity' };
    return {
      symbol: sym,
      securityId: meta.securityId,
      exchangeSegment: 'NSE_EQ',
      name: meta.name,
      sector: meta.sector,
    };
  });
}

/**
 * Returns summary of all available stock universes.
 */
export function listUniverses() {
  return Object.values(UNIVERSES).map((u) => ({
    id: u.id,
    name: u.name,
    description: u.description,
    count: u.symbols.length,
  }));
}
