/**
 * Core domain types and interfaces for the Stock Research Engine.
 * Follows strict typed schema contracts for auditability and reasoning.
 */

export interface InstrumentRef {
  symbol: string;
  securityId: string;
  exchangeSegment: 'NSE_EQ' | 'NSE_FNO' | 'BSE_EQ' | 'IDX_I';
  name?: string;
  sector?: string;
}

export interface EvidenceItem {
  id: string;
  category: 'business' | 'financial' | 'moat' | 'management' | 'growth' | 'valuation' | 'technical' | 'risk';
  claim: string;
  metric?: string;
  value?: number;
  unit?: string;
  period?: string;
  source: string;
  confidence: number;
  timestamp: number;
}

export interface MoatScores {
  brand: number;
  distribution: number;
  switchingCosts: number;
  costAdvantage: number;
  technology: number;
  networkEffects: number;
  pricingPower: number;
  aggregateScore: number;
}

export interface BusinessMoatResult {
  businessModel: string;
  revenueDrivers: string[];
  segments: Array<{ name: string; sharePct: number }>;
  moat: MoatScores;
  moatTrajectory: 'EXPANDING' | 'STABLE' | 'DETERIORATING';
  summary: string;
}

export interface FinancialValuationResult {
  cfoVsPatRatio: number;
  fcfConversionPct: number;
  roicPct: number;
  rocePct: number;
  roePct: number;
  debtToEquity: number;
  interestCoverage: number;
  earningsQualityPass: boolean;
  dcf: {
    bearFairValue: number;
    baseFairValue: number;
    bullFairValue: number;
    currentPrice: number;
    marginOfSafetyPct: number;
    impliedGrowthRatePct: number;
  };
  peerMultiples: {
    pe: number;
    sectorPe: number;
    pb: number;
    evEbitda: number;
  };
  valuationScore: number;
}

export interface GrowthManagementResult {
  industryTamCagrPct: number;
  companyRevenueCagr3y: number;
  expansionLevers: string[];
  promoterHoldingPct: number;
  promoterPledgingPct: number;
  governanceScore: number;
  capitalAllocationRating: 'EXCELLENT' | 'GOOD' | 'AVERAGE' | 'POOR';
  guidanceExecutionGapPct: number;
  redFlags: string[];
}

export interface TechnicalRiskResult {
  trend: {
    rsi14: number;
    adx14: number;
    supertrend: 'BULLISH' | 'BEARISH';
    sma50Above200: boolean;
  };
  derivatives?: {
    pcrOi: number;
    maxPainStrike?: number;
    callOiWall?: number;
    putOiWall?: number;
  };
  riskRegister: Array<{
    risk: string;
    category: string;
    probability: 'HIGH' | 'MEDIUM' | 'LOW';
    impact: 'HIGH' | 'MEDIUM' | 'LOW';
    mitigation: string;
  }>;
  overallRiskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
}

export interface BullBearDebate {
  bullThesis: string[];
  bullCatalysts: string[];
  bearThesis: string[];
  bearRedFlags: string[];
  judgeVerdict: string;
  thesisBreakers: string[];
}

export type VerdictStance = 'BUY' | 'HOLD' | 'AVOID';

export interface InvestmentVerdict {
  stance: VerdictStance;
  qualityScore: number;
  valuationScore: number;
  compositeScore: number;
  fairValue: {
    bear: number;
    base: number;
    bull: number;
  };
  marginOfSafetyPct: number;
  expectedCagr: {
    horizon1yPct: number;
    horizon3yPct: number;
    horizon5yPct: number;
  };
  keyCatalysts: string[];
  keyRisks: string[];
  thesisBreakers: string[];
  confidence: number;
  summary: string;
}

export interface OptionsIntelligenceResult {
  underlying: string;
  spot: number;
  atmIv: number;
  ivRank: number | null;
  pcrOi: number;
  pcrVolume: number;
  maxPainStrike: number;
  callOiWall: number;
  putOiWall: number;
  expectedMove: number;
  preferredStructure: 'BULL_CALL_SPREAD' | 'BEAR_PUT_SPREAD' | 'IRON_CONDOR' | 'IRON_BUTTERFLY' | 'NEUTRAL';
  summary: string;
}

export interface ResearchTradeSignal {
  symbol: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  conviction: number;
  horizon: 'INTRADAY' | 'SWING' | 'POSITIONAL';
  fairValue: { bear: number; base: number; bull: number };
  marginOfSafetyPct: number;
  entryConditions: string[];
  invalidationTriggers: string[];
  suggestedStructures: string[];
  generatedAt: number;
}

export interface ResearchRun {
  runId: string;
  symbol: string;
  exchange: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: number;
  completedAt?: number;
  businessMoat?: BusinessMoatResult;
  financialValuation?: FinancialValuationResult;
  growthManagement?: GrowthManagementResult;
  technicalRisk?: TechnicalRiskResult;
  optionsIntelligence?: OptionsIntelligenceResult;
  debate?: BullBearDebate;
  verdict?: InvestmentVerdict;
  tradeSignal?: ResearchTradeSignal;
  evidenceCount: number;
  error?: string;
}

export interface ResearchOptions {
  exchange?: 'NSE' | 'BSE';
  forceRefresh?: boolean;
}

export type ScreenerPresetName =
  | 'QUALITY_COMPOUNDERS'
  | 'VALUE_MARGIN_OF_SAFETY'
  | 'MOMENTUM_BREAKOUT'
  | 'OPTIONS_BULLISH';

export interface ScreenerCandidate {
  symbol: string;
  name: string;
  sector: string;
  securityId: string;
  cmp: number;
  deterministicScore: number;
  passed: boolean;
  passedRules: string[];
  failedRules: string[];
  metrics: {
    rsi14: number;
    supertrend: 'BULLISH' | 'BEARISH';
    cfoVsPat: number;
    roicPct: number;
    debtToEquity: number;
    dcfMarginOfSafetyPct: number;
    pcrOi?: number;
  };
}

export interface ScreenerResult {
  universe: string;
  preset: ScreenerPresetName;
  totalScreened: number;
  totalPassed: number;
  candidates: ScreenerCandidate[];
  topPicks: string[];
  screenedAt: number;
}

export interface WatchlistItem {
  symbol: string;
  name: string;
  sector: string;
  universe: string;
  deterministicScore: number;
  status: 'ACTIVE' | 'ARCHIVED';
  metrics: {
    rsi14: number;
    supertrend: 'BULLISH' | 'BEARISH';
    cfoVsPat: number;
    roicPct: number;
    debtToEquity: number;
    dcfMarginOfSafetyPct: number;
  };
  addedAt: number;
  expiresAt: number;
  lastAnalyzedAt?: number;
}

export type MarketPhase = 'PRE_MARKET' | 'MARKET_HOURS' | 'POST_MARKET' | 'CLOSED';

export interface SchedulerStatus {
  enabled: boolean;
  marketPhase: MarketPhase;
  nextScheduledJob: string;
  nextJobTimeIst: string;
  telegramEnabled: boolean;
  activeWatchlistCount: number;
  lastRunTimes: {
    monthlyScreen?: number;
    preMarketBrief?: number;
    marketHoursAlert?: number;
    postMarketDossier?: number;
  };
}

