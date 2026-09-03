import { AgentToolRegistry, Policy, type DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { eventBus } from './eventBus';
import type { MarketDataService } from './marketData';
import type { RiskEngine } from './riskEngine';
import { pushAgentEvent, listAgentEvents, createPaperStrategy, getActiveRules, getPaperWallet } from '../db';
import { INDEX_INSTRUMENTS } from './marketData';
import type { PaperExecutionEngine } from '../engines/paper';
import type { LiveExecutionEngine } from '../engines/live';
import { analyzeOptionChain, recordIvSample, getIvRank, selectStrikeByDelta } from './optionsAnalytics';
import {
  buildIronCondor, buildIronButterfly, buildCreditSpread, buildDebitSpread,
  buildStraddle, buildStrangle, buildOrbBuyingStrategy, buildOrb30mStrategy,
  buildVwapPullbackStrategy, evaluateStrategyBacktest, calculateCapitalAllocationLots, getLotSize,
  type ConstructedStrategy
} from './strategyConstructor';
import { analyzeOptionsBehavior } from '../routes/market';
import { nearestIndexExpiry } from './marketHours';

export type AgentKey = 'planner' | 'analyst' | 'strategy' | 'execution' | 'risk' | 'critic';

export interface AgentStep {
  id: string;
  runId: string;
  agent: AgentKey;
  type: 'THINK' | 'ACT' | 'OBSERVE' | 'CRITIQUE' | 'ERROR';
  time: string;
  summary?: string;
  tool?: string;
  response?: string;
  duration?: number;
  deterministic?: boolean;
}

export interface AgentRunStatus {
  running: boolean;
  runId: string | null;
  objective: string | null;
  startedAt: number | null;
  steps: number;
  toolCalls: number;
  llm: 'ollama' | 'deterministic';
  personas: Record<AgentKey, { status: 'idle' | 'active'; steps: number }>;
}

const ALL_PERSONAS: AgentKey[] = ['planner', 'analyst', 'strategy', 'execution', 'risk', 'critic'];
const idlePersonas = (): Record<AgentKey, { status: 'idle' | 'active'; steps: number }> => ({
  planner: { status: 'idle', steps: 0 }, analyst: { status: 'idle', steps: 0 },
  strategy: { status: 'idle', steps: 0 }, execution: { status: 'idle', steps: 0 },
  risk: { status: 'idle', steps: 0 }, critic: { status: 'idle', steps: 0 },
});

export class AgentOrchestrator {
  private client: DhanClient;
  private market: MarketDataService;
  private risk: RiskEngine;
  private paper: PaperExecutionEngine;
  private live: LiveExecutionEngine;
  private tools: AgentToolRegistry;
  private ollama: OllamaClient | null = null;
  private llmModel: string;
  private llmAvailable = false;
  private running = false;
  private currentRun: AgentRunStatus | null = null;
  private llmProbed = false;

  constructor(client: DhanClient, market: MarketDataService, risk: RiskEngine, paper: PaperExecutionEngine, live: LiveExecutionEngine) {
    this.client = client;
    this.market = market;
    this.risk = risk;
    this.paper = paper;
    this.live = live;
    this.llmModel = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
    this.tools = new AgentToolRegistry({ client, policy: Policy.fromEnv() });

    if (process.env.OLLAMA_ENABLED !== 'false') {
      this.ollama = new OllamaClient({
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
        timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 15000,
        retries: 0,
      });
      void this.probeLlm();
    }
  }

  private async probeLlm(): Promise<void> {
    if (!this.ollama || this.llmProbed) return;
    this.llmProbed = true;
    try {
      await this.ollama.version();
      this.llmAvailable = true;
      eventBus.log('INFO', `Agent LLM online: Ollama (${this.llmModel})`, 'agent');
    } catch {
      this.llmAvailable = false;
      eventBus.log('WARN', 'Ollama unreachable — agent will use deterministic mode', 'agent');
    }
  }

  status(): AgentRunStatus {
    return this.currentRun || {
      running: false, runId: null, objective: null, startedAt: null, steps: 0, toolCalls: 0,
      llm: this.llmAvailable ? 'ollama' : 'deterministic', personas: idlePersonas(),
    };
  }

  toolCatalog() {
    return this.tools.list().map((t: any) => ({
      name: t.name, desc: t.description, type: t.risk || 'read', params: Object.keys(t.inputSchema?.properties || {}), scope: t.scope,
    }));
  }

  async events(limit = 100) { return listAgentEvents(limit); }

  async refreshLlm(): Promise<boolean> {
    this.llmProbed = false;
    this.llmAvailable = false;
    await this.probeLlm();
    return this.llmAvailable;
  }

  async run(objective: string, triggeredBy = 'control_plane'): Promise<{ runId: string; status: string }> {
    if (this.running) throw new Error('An agent run is already in progress');
    if (this.risk.isKilled()) throw new Error('Kill switch engaged — agent runs disabled');
    await this.probeLlm();

    const runId = `run_${Date.now().toString(36)}`;
    this.running = true;
    this.currentRun = {
      running: true, runId, objective, startedAt: Date.now(), steps: 0, toolCalls: 0,
      llm: this.llmAvailable ? 'ollama' : 'deterministic', personas: idlePersonas(),
    };

    void this.executeRun(runId, objective, triggeredBy).finally(() => {
      this.running = false;
      setTimeout(() => { if (this.currentRun?.runId === runId) this.currentRun = null; }, 30_000);
    });

    return { runId, status: 'started' };
  }

  private step(runId: string, agent: AgentKey, type: AgentStep['type'], summary: string, extra?: Partial<AgentStep>): void {
    const ev: AgentStep = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      runId, agent, type,
      time: new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
      summary, duration: extra?.duration ?? 30 + Math.floor(Math.random() * 90), ...extra,
    };
    if (this.currentRun?.runId === runId) {
      this.currentRun.steps++;
      this.currentRun.personas[agent] = { status: 'active', steps: (this.currentRun.personas[agent]?.steps || 0) + 1 };
      if (extra?.tool) this.currentRun.toolCalls++;
    }
    eventBus.emit('telemetry', ev);
    void pushAgentEvent({ run_id: runId, agent, type, summary, tool: extra?.tool, response: extra?.response, duration_ms: ev.duration });
  }

  private async callTool(runId: string, agent: AgentKey, tool: string, args: any): Promise<any> {
    const t0 = Date.now();
    try {
      const result = await this.tools.execute(tool as any, args);
      this.step(runId, agent, 'ACT', `Tool ${tool} executed`, { tool, response: JSON.stringify(result).slice(0, 1200), duration: Date.now() - t0 });
      return result;
    } catch (e: any) {
      this.step(runId, agent, 'ERROR', `Tool ${tool} failed: ${e.message}`, { tool, duration: Date.now() - t0 });
      return null;
    }
  }

  private async reason(runId: string, agent: AgentKey, system: string, user: string, fallback: () => string): Promise<string> {
    const t0 = Date.now();
    if (this.ollama && this.llmAvailable) {
      try {
        const out = await this.ollama.chatText({
          model: this.llmModel,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          options: { temperature: 0.2 },
        });
        this.step(runId, agent, 'THINK', out.slice(0, 600), { duration: Date.now() - t0 });
        return out;
      } catch (e: any) {
        this.step(runId, agent, 'THINK', `LLM error (${e.message}) — fallback to deterministic`, { duration: Date.now() - t0, deterministic: true });
        this.llmAvailable = false;
      }
    }
    const text = fallback();
    this.step(runId, agent, 'THINK', text, { deterministic: true, duration: Date.now() - t0 });
    return text;
  }

  private async executeRun(runId: string, objective: string, triggeredBy: string): Promise<void> {
    eventBus.log('INFO', `Agent run ${runId} started (${triggeredBy}): "${objective.slice(0, 120)}"`, 'agent');
    this.step(runId, 'planner', 'THINK', `Objective received: "${objective}"`);

    try {
      // 1. PLANNER
      const rules = await getActiveRules().catch(() => []);
      const rulesText = rules.length > 0 ? `\n\nSELF-HEALED RULES (learned from recurring failures — must adhere):\n${rules.map((r) => `- ${r}`).join('\n')}` : '';
      await this.reason(runId, 'planner', `Decompose objective into concrete steps.${rulesText}`, objective,
        () => 'Plan: 1. Pull market quotes & chain 2. Analyze IV & PCR 3. Formulate strategy 4. Check risk 5. Execute 6. Critique');

      // 2. ANALYST & MULTI-INDEX WATCHLIST SCANNER
      const watchlist = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'MIDCPNIFTY'];
      const explicitTarget = watchlist.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(objective) && !objective.toLowerCase().includes('and') && !objective.toLowerCase().includes('across') && !objective.toLowerCase().includes('all'));
      const targets = explicitTarget ? [explicitTarget] : watchlist;

      // 2b. Capital allocation (30% of total available capital)
      let availableCapital = 1_000_000;
      try {
        const isLive = process.env.TRADING_MODE === 'live';
        if (isLive) {
          const funds = await (this.client as any).funds?.get?.();
          availableCapital = Number(funds?.availableCash || funds?.availMargin || 1_000_000);
        } else {
          const wallet = await getPaperWallet();
          availableCapital = Number(wallet.availableMargin || wallet.totalBalance || 1_000_000);
        }
      } catch { /* default 10L */ }

      const vixRes = await this.callTool(runId, 'analyst', 'dhan_ltp', { instruments: { IDX_I: [Number(INDEX_INSTRUMENTS.INDIAVIX.securityId)] } });
      const vix = extractLtp(vixRes, INDEX_INSTRUMENTS.INDIAVIX.securityId) || 14;

      interface Candidate {
        target: string;
        spot: number;
        analytics: any;
        strategy: ConstructedStrategy;
        bt: any;
        score: number;
      }
      const candidates: Candidate[] = [];

      for (const target of targets) {
        const inst = INDEX_INSTRUMENTS[target];
        if (!inst) continue;
        const expiry = nearestIndexExpiry(target);
        const [ltpRes, chainRes] = await Promise.all([
          this.callTool(runId, 'analyst', 'dhan_ltp', { instruments: { IDX_I: [Number(inst.securityId)] } }),
          this.callTool(runId, 'analyst', 'dhan_option_chain', { underlyingScrip: Number(inst.securityId), underlyingSeg: 'IDX_I', expiry }),
        ]);

        const spot = extractLtp(ltpRes, inst.securityId) || this.market.getLtp(inst.securityId) || 0;
        const rows = chainRes?.strikes || chainRes?.data || [];
        if (rows.length === 0) continue;

        const analytics = analyzeOptionChain(target, rows, spot, expiry, vix);
        recordIvSample(target, analytics.atmIv);
        const strat = this.synthesizeStrategy(objective, target, spot, rows, expiry, analytics, availableCapital, vix);
        if (!strat) continue;

        const bt = await this.backtestCandidate(target, inst.securityId, strat);
        const score = (bt.winRate || 50) * (bt.profitFactor || 1.2);
        candidates.push({ target, spot, analytics, strategy: strat, bt, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];

      await this.reason(runId, 'analyst', 'Summarize multi-index market conditions.', JSON.stringify(candidates.map((c) => ({ target: c.target, spot: c.spot, regime: c.analytics.regime, score: c.score }))),
        () => best ? `Analyst: Scanned ${candidates.length} watchlist indices. Top candidate: ${best.strategy.name} on ${best.target} (Score: ${best.score.toFixed(1)}, WinRate: ${best.bt.winRate}%, PF: ${best.bt.profitFactor})` : 'Analyst: No actionable setups across watchlist');

      const strategy = best?.strategy || null;
      const bt = best?.bt || { winRate: 0, totalDays: 0, totalPnlInr: 0, profitFactor: 0, passedValidation: false };
      this.step(runId, 'strategy', 'ACT', `Selected Strategy: ${strategy?.name || 'NONE'} (${strategy?.lots || 0} lots) | Backtest: ${bt.winRate}% win rate across ${bt.totalDays}d (PF: ${bt.profitFactor})`, {
        tool: 'strategy.backtest', response: JSON.stringify({ winRate: bt.winRate, pnl: bt.totalPnlInr, pf: bt.profitFactor, pass: bt.passedValidation }),
      });

      // 4. RISK
      const gate = this.risk.canTrade();
      const breakers = this.risk.snapshot().breakers || [];
      const tripped = breakers.filter((b) => b.state !== 'OK');
      // Single source of truth — evaluateStrategyBacktest already encodes the
      // real win-rate/profit-factor/max-drawdown thresholds. The two escape
      // hatches this used to have (totalDays===0 auto-passing, and a lower
      // 0.9 PF bar bypassing the real validation) both let "we don't know"
      // or "the real check said no" through as ALLOWED. Neither should.
      const isBacktestPassing = bt.passedValidation;
      this.step(runId, 'risk', 'ACT', `Risk gate: ${gate.allowed && isBacktestPassing ? 'ALLOWED' : `BLOCKED (${!gate.allowed ? gate.reason : 'statistical edge below threshold'})`}`, {
        tool: 'risk_engine.evaluate', response: JSON.stringify({ allowed: gate.allowed, tripped: tripped.length, backtestPass: isBacktestPassing }),
      });

      // 5. EXECUTION
      const executed = await this.executeStrategy(runId, objective, strategy, gate.allowed && tripped.length === 0 && isBacktestPassing);

      // 6. CRITIC
      await this.reason(runId, 'critic', 'Review trading run & backtest metrics.', JSON.stringify({ executed: executed.status, backtest: bt }),
        () => `Critic (deterministic): Execution ${executed.status}. Backtest win rate ${bt.winRate}% (PF: ${bt.profitFactor}). Risk limits respected.`);
    } catch (e: any) {
      this.step(runId, 'critic', 'ERROR', `Run failed: ${e.message}`);
      eventBus.log('ERROR', `Agent run ${runId} error: ${e.message}`, 'agent');
    } finally {
      for (const p of ALL_PERSONAS) this.currentRun && (this.currentRun.personas[p] = { status: 'idle', steps: 0 });
      if (this.currentRun?.runId === runId) this.currentRun.running = false;
      eventBus.emit('system', { type: 'agent_run_complete', runId });
    }
  }

  private synthesizeStrategy(
    objective: string,
    target: string,
    spot: number,
    rows: any[],
    expiry: string,
    analytics: any,
    capital = 1_000_000,
    vix = 14
  ): ConstructedStrategy | null {
    const obj = objective.toLowerCase();
    
    // Confluence-driven directional bias (PCR OI + PCR Vol + Max Pain pull)
    const pcrBias = analytics.pcrOi > 1.15 ? 'BULLISH' : analytics.pcrOi < 0.85 ? 'BEARISH' : 'NEUTRAL';
    const painBias = analytics.maxPain ? (spot < analytics.maxPain - 50 ? 'BULLISH' : spot > analytics.maxPain + 50 ? 'BEARISH' : 'NEUTRAL') : 'NEUTRAL';
    const direction: 'BULLISH' | 'BEARISH' = pcrBias !== 'NEUTRAL' ? pcrBias : (painBias !== 'NEUTRAL' ? painBias : 'BULLISH');

    // Conservative capital allocation (30% pool, ~1-1.5% max risk).
    // The BUY estimate used to default to a flat ₹150/share guess (0 passed
    // as unitCostOrMargin) regardless of symbol or strike — fine for a
    // cheap OTM NIFTY option, wildly wrong for a near-ATM 0.55Δ BANKNIFTY/
    // SENSEX one, which can run ₹500-900+. That undersized-premium guess
    // sized lots as if the trade were 5x cheaper than it actually was,
    // producing orders the account could never afford (rejected downstream
    // with "insufficient margin" instead of being sized correctly upfront).
    // Resolve the real strike the builder will actually pick and price lots
    // off its live premium instead.
    const buyOptType = direction === 'BULLISH' ? 'CALL' : 'PUT';
    const buyStrikeRow = selectStrikeByDelta(rows, 0.55, buyOptType, spot, expiry);
    const buyLeg = buyStrikeRow?.targetLeg;
    const buyPremium = Number(buyLeg?.ltp || buyLeg?.lastPrice || buyLeg?.last_price || 0);
    const buyUnitCost = buyPremium > 0 ? buyPremium * getLotSize(target) : 0;

    const buyLots = calculateCapitalAllocationLots(capital, target, 'BUY', buyUnitCost, 30);
    const spreadLots = calculateCapitalAllocationLots(capital, target, 'SPREAD', 0, 30);
    const condorLots = calculateCapitalAllocationLots(capital, target, 'CONDOR', 0, 30);
    const straddleLots = calculateCapitalAllocationLots(capital, target, 'STRADDLE', 0, 30);

    // IV-rank gate: selling premium when this index's own IV already sits in
    // the bottom quartile of its recent range means no cushion left — any
    // expansion is unbounded loss against a small credit. null = not enough
    // samples yet to know (process just started) — never gate on "unknown."
    const ivRank = getIvRank(target);
    const ivTooLowToSell = ivRank !== null && ivRank < 25;

    // Explicit user-prompt overrides
    if (obj.includes('butterfly')) return buildIronButterfly(target, spot, rows, expiry, condorLots);
    if (obj.includes('condor')) return buildIronCondor(target, spot, rows, expiry, condorLots);
    if (obj.includes('strangle')) return buildStrangle(target, spot, rows, expiry, straddleLots, obj.includes('buy') ? 'BUY' : 'SELL');
    if (obj.includes('straddle')) return buildStraddle(target, spot, rows, expiry, straddleLots, obj.includes('buy') ? 'BUY' : 'SELL');
    if (obj.includes('bull') || obj.includes('put spread')) return buildCreditSpread(target, 'BULLISH', spot, rows, expiry, spreadLots);
    if (obj.includes('bear') || obj.includes('call spread')) return buildCreditSpread(target, 'BEARISH', spot, rows, expiry, spreadLots);
    if (obj.includes('orb 30') || obj.includes('orb_30')) return buildOrb30mStrategy(target, spot, rows, expiry, buyLots, direction);
    if (obj.includes('orb') || obj.includes('breakout')) return buildOrbBuyingStrategy(target, spot, rows, expiry, buyLots, direction);
    if (obj.includes('vwap') || obj.includes('pullback')) return buildVwapPullbackStrategy(target, spot, rows, expiry, buyLots, direction);

    // ── Professional Institutional Regime Dispatcher ──
    // 1. Low IV / Rangebound / Theta Trap Regime: Maximize Theta Decay with defined risk wings
    if (analytics.regime === 'THETA_DECAY' || analytics.regime === 'RANGE_BOUND' || vix < 13.5) {
      // vix<13.5 is broad-market IV; this index's own IV rank can already be
      // crushed even when overall VIX looks moderate — double-low means no
      // edge left to sell. Skip rather than force a bad trade.
      if (ivTooLowToSell) return null;
      return buildIronButterfly(target, spot, rows, expiry, condorLots)
        || buildCreditSpread(target, direction, spot, rows, expiry, spreadLots)
        || buildIronCondor(target, spot, rows, expiry, condorLots);
    }

    // 2. High IV / Breakout / Gamma Blast Regime: Exploit Directional Momentum with defined risk
    if (analytics.regime === 'GAMMA_BLAST' || vix >= 15.5) {
      return buildOrbBuyingStrategy(target, spot, rows, expiry, buyLots, direction)
        || buildDebitSpread(target, direction, spot, rows, expiry, spreadLots);
    }

    // 3. Expiry Day Regime (0DTE Gamma Pin / Decay):
    if (analytics.regime === 'EXPIRY_GAMMA') {
      if (ivTooLowToSell) return null;
      return buildIronButterfly(target, spot, rows, expiry, condorLots)
        || buildCreditSpread(target, direction, spot, rows, expiry, spreadLots);
    }

    // 4. Trending Directional Drift Regime:
    if (direction === 'BULLISH') {
      return (!ivTooLowToSell && buildCreditSpread(target, 'BULLISH', spot, rows, expiry, spreadLots))
        || buildOrbBuyingStrategy(target, spot, rows, expiry, buyLots, 'BULLISH');
    } else {
      return (!ivTooLowToSell && buildCreditSpread(target, 'BEARISH', spot, rows, expiry, spreadLots))
        || buildOrbBuyingStrategy(target, spot, rows, expiry, buyLots, 'BEARISH');
    }
  }

  private async executeStrategy(runId: string, objective: string, strat: ConstructedStrategy | null, allowed: boolean): Promise<any> {
    const wantsTrade = /buy|sell|straddle|strangle|condor|spread|deploy|execute|trade|survey|scan|auto/i.test(objective);
    if (!wantsTrade || !strat || !allowed) {
      this.step(runId, 'execution', 'OBSERVE', `Skipped: ${!allowed ? 'risk blocked' : !strat ? 'no strategy' : 'no trade intent'}`);
      return { status: 'SKIPPED' };
    }

    this.market.addInstruments(strat.legs.map((l) => ({ securityId: l.securityId, exchangeSegment: l.exchangeSegment || 'NSE_FNO' })));
    const isLive = process.env.TRADING_MODE === 'live';
    const engine = isLive ? this.live : this.paper;
    const filledLegs: typeof strat.legs = [];
    for (const leg of strat.legs) {
      const res = await engine.placeOrder({
        correlation_id: `${strat.id}_${leg.optionType}_${leg.strike}`,
        intent_id: runId,
        params: {
          security_id: leg.securityId, symbol: leg.instrument, quantity: leg.qty,
          transaction_type: leg.side, order_type: 'MARKET', exchange_segment: leg.exchangeSegment || 'NSE_FNO',
          product_type: 'INTRADAY', price: leg.price,
        },
        risk_limits: {
          stop_loss: leg.stopLoss,
          target: leg.target,
          trailing_stop: leg.trailingStop,
        },
      });
      if (res && (res.status === 'TRADED' || res.orderId)) {
        filledLegs.push(leg);
      } else {
        // Stop rather than keep filling — more legs into a broken structure
        // is more exposure to unwind, not less.
        break;
      }
    }

    if (filledLegs.length > 0 && filledLegs.length < strat.legs.length) {
      // Partial fill on a multi-leg structure is worse than no fill — e.g. a
      // short leg filling without its hedge is naked, undefined risk. Unwind
      // whatever filled rather than leaving it to stand.
      for (const leg of filledLegs) {
        const unwindPrice = this.market.getFillablePrice(leg.securityId, { allowClosed: true }) ?? leg.price;
        await engine.placeOrder({
          correlation_id: `${strat.id}_${leg.optionType}_${leg.strike}_unwind`,
          intent_id: runId,
          params: {
            security_id: leg.securityId, symbol: leg.instrument, quantity: leg.qty,
            transaction_type: leg.side === 'BUY' ? 'SELL' : 'BUY', order_type: 'MARKET',
            exchange_segment: leg.exchangeSegment || 'NSE_FNO', product_type: 'INTRADAY', price: unwindPrice,
          },
        }).catch(() => {});
        this.market.monitor.untrack(leg.exchangeSegment || 'NSE_FNO', leg.securityId);
      }
      eventBus.log('ERROR', `Multi-leg deploy ${strat.name} partially filled (${filledLegs.length}/${strat.legs.length}) — unwound`, 'agent');
      this.step(runId, 'execution', 'ACT', `Strategy ${strat.name} partial fill unwound (${filledLegs.length}/${strat.legs.length})`);
      return { status: 'FAILED', reason: 'partial_fill_unwound' };
    }

    if (filledLegs.length === strat.legs.length && filledLegs.length > 0) {
      await createPaperStrategy({ id: strat.id, name: strat.name, symbol: strat.symbol, type: strat.type, lots: strat.lots, legs: strat.legs });
      this.step(runId, 'execution', 'ACT', `Strategy deployed: ${strat.name} (${filledLegs.length}/${strat.legs.length} legs filled)`);
      return { status: 'TRADED', strategyId: strat.id, legsFilled: filledLegs.length };
    }
    return { status: 'FAILED' };
  }

  private async backtestCandidate(target: string, secId: string, strat: ConstructedStrategy | null) {
    if (!strat) return { winRate: 0, totalDays: 0, totalPnlInr: 0, profitFactor: 0, passedValidation: false };
    try {
      const hist = await analyzeOptionsBehavior(this.client, { symbol: target, securityId: secId, daysCount: 5, interval: '1', expiryFlag: 'WEEK', expiryCode: 1 });
      return evaluateStrategyBacktest(target, strat.type, hist.days || [], { lots: strat.lots });
    } catch (e: any) {
      // Absence of evidence is not consent to trade. This used to return a
      // fabricated 100% win rate on ANY failure (rate limit, timeout, no
      // data for the window) — the exact opposite of what a failed backtest
      // should mean, and it fed the execution gate below directly.
      eventBus.log('WARN', `Backtest unavailable for ${target} (${e?.message || e}) — treating as no edge, blocking entry`, 'agent');
      return { winRate: 0, totalDays: 0, totalPnlInr: 0, profitFactor: 0, passedValidation: false };
    }
  }
}

function extractLtp(res: any, secId: string): number {
  if (!res) return 0;
  if (typeof res === 'number') return res;
  const data = res.data || res;
  const seg = data.IDX_I?.[secId] || data.NSE_FNO?.[secId] || data.NSE_EQ?.[secId] || data[secId];
  if (typeof seg === 'number') return seg;
  return Number(seg?.last_price ?? seg?.ltp ?? data.last_price ?? data.ltp ?? 0);
}
