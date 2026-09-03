import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { OllamaClient } from '@nemesis-oss/ollama-sdk';
import type { MarketDataService } from '../marketData';
import { eventBus } from '../eventBus';
import { moduleLogger } from '../../lib/logger';
import { EvidenceLedger } from './evidenceLedger';
import { DefaultFundamentalProvider, MarketDataProvider, resolveInstrumentRef, type FundamentalDataProvider } from './dataProviders';
import { BusinessMoatSkill } from './skills/businessMoatSkill';
import { FinancialValuationSkill } from './skills/financialValuationSkill';
import { GrowthManagementSkill } from './skills/growthManagementSkill';
import { TechnicalRiskSkill } from './skills/technicalRiskSkill';
import { BullBearDebateSkill } from './skills/bullBearDebateSkill';
import { VerdictSkill } from './skills/verdictSkill';
import { OptionsIntelligenceSkill } from './skills/optionsIntelligenceSkill';
import { ResearchTradeBridge } from './tradeBridge';
import { StockScreener } from './screener';
import type { ResearchOptions, ResearchRun, ResearchTradeSignal, ScreenerPresetName, ScreenerResult } from './types';
import { saveResearchRun, getResearchRun, listResearchRuns, saveResearchEvidence, getResearchEvidenceByRun } from '../../db';

const log = moduleLogger('research_orchestrator');

/**
 * Institutional Equity Research Orchestrator.
 * Strictly read-only: coordinates analysis without trade execution permissions.
 */
export class ResearchOrchestrator {
  private marketProvider: MarketDataProvider;
  private fundamentalProvider: FundamentalDataProvider;
  private businessSkill = new BusinessMoatSkill();
  private financialSkill = new FinancialValuationSkill();
  private growthSkill = new GrowthManagementSkill();
  private technicalSkill = new TechnicalRiskSkill();
  private optionsSkill = new OptionsIntelligenceSkill();
  private tradeBridge = new ResearchTradeBridge();
  private screener = new StockScreener();
  private debateSkill: BullBearDebateSkill;
  private verdictSkill = new VerdictSkill();
  private inMemoryRuns = new Map<string, ResearchRun>();
  private latestSignals = new Map<string, ResearchTradeSignal>();

  constructor(
    private client: DhanClient,
    private market: MarketDataService,
    fundamentalProvider?: FundamentalDataProvider,
    private ollama?: OllamaClient | null,
  ) {
    this.marketProvider = new MarketDataProvider(client, market);
    this.fundamentalProvider = fundamentalProvider || new DefaultFundamentalProvider();
    this.debateSkill = new BullBearDebateSkill(ollama);
  }

  async analyze(symbol: string, options?: ResearchOptions): Promise<ResearchRun> {
    const runId = `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const instrument = resolveInstrumentRef(symbol);
    const ledger = new EvidenceLedger();

    log.info({ runId, symbol: instrument.symbol }, 'Initiating institutional equity research');
    this.emitTelemetry(runId, 'START', `Starting equity research run for ${instrument.symbol}`);

    const run: ResearchRun = {
      runId,
      symbol: instrument.symbol,
      exchange: options?.exchange || 'NSE',
      status: 'RUNNING',
      startedAt: Date.now(),
      evidenceCount: 0,
    };
    this.inMemoryRuns.set(runId, run);

    try {
      // 1. Data Retrieval
      const [quote, candles, statements, peers] = await Promise.all([
        this.marketProvider.getQuote(instrument),
        this.marketProvider.getHistoricalCandles(instrument, 200),
        this.fundamentalProvider.getStatements(instrument.symbol),
        this.fundamentalProvider.getPeerMultiples(instrument.symbol),
      ]);

      // 2. Domain Skill Execution
      this.emitTelemetry(runId, 'ANALYSIS', 'Executing business & moat evaluation');
      run.businessMoat = this.businessSkill.analyze(instrument.symbol, ledger);

      this.emitTelemetry(runId, 'ANALYSIS', 'Executing financial valuation & DCF model');
      run.financialValuation = this.financialSkill.analyze(statements, peers, quote.ltp, ledger);

      this.emitTelemetry(runId, 'ANALYSIS', 'Auditing governance & management track record');
      run.growthManagement = this.growthSkill.analyze(statements, ledger);

      this.emitTelemetry(runId, 'ANALYSIS', 'Analyzing options chain & derivatives positioning');
      run.optionsIntelligence = this.optionsSkill.analyze({ underlying: instrument.symbol, spot: quote.ltp }, ledger);

      this.emitTelemetry(runId, 'ANALYSIS', 'Calculating technical indicators & risk register');
      run.technicalRisk = this.technicalSkill.analyze(instrument.symbol, candles, {
        pcrOi: run.optionsIntelligence.pcrOi,
        maxPain: run.optionsIntelligence.maxPainStrike,
        callOiWall: run.optionsIntelligence.callOiWall,
        putOiWall: run.optionsIntelligence.putOiWall,
      }, ledger);

      // 3. Adversarial Bull vs Bear Red-Team Debate
      this.emitTelemetry(runId, 'DEBATE', 'Running adversarial Bull vs Bear debate judge');
      run.debate = await this.debateSkill.conductDebate(
        instrument.symbol, run.businessMoat, run.financialValuation, run.growthManagement, ledger,
      );

      // 4. Final Verdict Synthesis
      this.emitTelemetry(runId, 'VERDICT', 'Synthesizing final institutional investment verdict');
      run.verdict = this.verdictSkill.synthesize(instrument.symbol, {
        business: run.businessMoat,
        financials: run.financialValuation,
        growth: run.growthManagement,
        technical: run.technicalRisk,
        debate: run.debate,
      });

      // 5. Research-to-Trading Signal Bridge
      run.tradeSignal = this.tradeBridge.generateSignal(instrument.symbol, run.verdict, run.optionsIntelligence);
      this.latestSignals.set(instrument.symbol.toUpperCase(), run.tradeSignal);

      run.status = 'COMPLETED';
      run.completedAt = Date.now();
      run.evidenceCount = ledger.count();

      // 5. Durable persistence
      await this.persistRun(run, ledger);

      this.emitTelemetry(runId, 'COMPLETE', `Research complete: ${run.verdict.stance} (${run.verdict.summary})`);
      log.info({ runId, symbol: instrument.symbol, stance: run.verdict.stance }, 'Research completed successfully');
      return run;
    } catch (e: any) {
      run.status = 'FAILED';
      run.error = e.message;
      run.completedAt = Date.now();
      this.emitTelemetry(runId, 'ERROR', `Research failed: ${e.message}`);
      log.error({ runId, err: e.message }, 'Research run failed');
      return run;
    }
  }

  async getRun(runId: string): Promise<ResearchRun | null> {
    const mem = this.inMemoryRuns.get(runId);
    if (mem) return mem;
    const dbRun = await getResearchRun(runId).catch(() => null);
    return dbRun;
  }

  async listRuns(limit = 20): Promise<any[]> {
    const dbRuns = await listResearchRuns(limit).catch(() => []);
    if (dbRuns.length > 0) return dbRuns;
    return Array.from(this.inMemoryRuns.values()).slice(-limit).reverse();
  }

  async getEvidence(runId: string): Promise<any[]> {
    return getResearchEvidenceByRun(runId).catch(() => []);
  }

  getSignal(symbol: string): ResearchTradeSignal | null {
    return this.latestSignals.get(symbol.toUpperCase()) || null;
  }

  async screen(universeId: string, preset: ScreenerPresetName = 'QUALITY_COMPOUNDERS'): Promise<ScreenerResult> {
    this.emitTelemetry('screen', 'SCREENER', `Screening ${universeId} with ${preset}`);
    return this.screener.screen(universeId, preset, this.marketProvider, this.fundamentalProvider);
  }

  async screenAndAnalyze(
    universeId: string,
    preset: ScreenerPresetName = 'QUALITY_COMPOUNDERS',
    topN = 3,
  ): Promise<{ screener: ScreenerResult; analyzedRuns: ResearchRun[] }> {
    const screener = await this.screen(universeId, preset);
    const topCandidates = screener.candidates.filter((c) => c.passed).slice(0, topN);
    this.emitTelemetry('funnel', 'AGENTIC_DEEP_DIVE', `Deep analyzing ${topCandidates.length} passed candidates`);

    const analyzedRuns: ResearchRun[] = [];
    for (const cand of topCandidates) {
      analyzedRuns.push(await this.analyze(cand.symbol));
    }
    return { screener, analyzedRuns };
  }

  private emitTelemetry(runId: string, step: string, message: string): void {
    eventBus.emit('telemetry', {
      id: `ev_${Date.now()}`,
      runId,
      agent: 'analyst',
      type: 'THINK',
      time: new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
      summary: `[RESEARCH:${step}] ${message}`,
    });
  }

  private async persistRun(run: ResearchRun, ledger: EvidenceLedger): Promise<void> {
    const evidenceItems = ledger.list().map((e) => ({ ...e, runId: run.runId }));
    await Promise.all([
      saveResearchRun({
        id: run.runId,
        symbol: run.symbol,
        exchange: run.exchange,
        status: run.status,
        quality_score: run.verdict?.qualityScore,
        valuation_score: run.verdict?.valuationScore,
        verdict: run.verdict?.stance,
        data: run,
      }).catch((e) => log.warn({ err: e.message }, 'Failed to persist research run')),
      saveResearchEvidence(evidenceItems).catch((e) => log.warn({ err: e.message }, 'Failed to persist research evidence')),
    ]);
  }
}
