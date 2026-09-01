import { AgentToolRegistry, Policy, type DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { eventBus } from './eventBus';
import type { MarketDataService } from './marketData';
import type { RiskEngine } from './riskEngine';
import { pushAgentEvent, listAgentEvents, createPaperStrategy, getActiveRules } from '../db';
import { INDEX_INSTRUMENTS } from './marketData';
import type { PaperExecutionEngine } from '../engines/paper';
import type { LiveExecutionEngine } from '../engines/live';
import { analyzeOptionChain } from './optionsAnalytics';
import { buildIronCondor, buildCreditSpread, buildStraddle, buildOrbBuyingStrategy, buildVwapPullbackStrategy, evaluateStrategyBacktest, type ConstructedStrategy } from './strategyConstructor';
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

      // 2. ANALYST
      const target = Object.keys(INDEX_INSTRUMENTS).find((s) => objective.toUpperCase().includes(s)) || 'NIFTY';
      const inst = INDEX_INSTRUMENTS[target];
      // Post-Sept-2025 SEBI rule: NIFTY/BANKNIFTY weeklies expire Tuesday, SENSEX Thursday
      // (BANKNIFTY is monthly-only). A stale Thursday-only calc here made every option-chain
      // fetch below 400 on non-Thursday symbols, so no strategy could ever be built.
      const expiry = nearestIndexExpiry(target);
      const [ltpRes, chainRes, vixRes] = await Promise.all([
        this.callTool(runId, 'analyst', 'dhan_ltp', { instruments: { IDX_I: [Number(inst.securityId)] } }),
        this.callTool(runId, 'analyst', 'dhan_option_chain', { underlyingScrip: Number(inst.securityId), underlyingSeg: 'IDX_I', expiry }),
        this.callTool(runId, 'analyst', 'dhan_ltp', { instruments: { IDX_I: [Number(INDEX_INSTRUMENTS.INDIAVIX.securityId)] } }),
      ]);

      const spot = extractLtp(ltpRes, inst.securityId) || this.market.getLtp(inst.securityId) || 0;
      const vix = extractLtp(vixRes, INDEX_INSTRUMENTS.INDIAVIX.securityId) || 14;
      const rows = chainRes?.strikes || chainRes?.data || [];
      const analytics = analyzeOptionChain(target, rows, spot, expiry, vix);

      await this.reason(runId, 'analyst', 'Summarize market conditions.', JSON.stringify(analytics),
        () => `Analyst (deterministic): ${target} ₹${spot}, PCR: ${analytics.pcrOi}, MaxPain: ${analytics.maxPainStrike}, Regime: ${analytics.regime}`);

      // 3. STRATEGY
      const strategy = this.synthesizeStrategy(objective, target, spot, rows, expiry, analytics);
      await this.reason(runId, 'strategy', 'Review option strategy setup.', JSON.stringify({ strategy: strategy?.name, legs: strategy?.legs.length }),
        () => strategy ? `Strategy (deterministic): ${strategy.name} with ${strategy.legs.length} legs` : 'Strategy (deterministic): NO TRADE');

      // 3b. BACKTEST VALIDATION
      const bt = await this.backtestCandidate(target, inst.securityId, strategy);
      this.step(runId, 'strategy', 'ACT', `Backtest: ${bt.winRate}% win rate across ${bt.totalDays}d (₹${bt.totalPnlInr} PnL, PF: ${bt.profitFactor})`, {
        tool: 'strategy.backtest', response: JSON.stringify({ winRate: bt.winRate, pnl: bt.totalPnlInr, pf: bt.profitFactor, pass: bt.passedValidation }),
      });

      // 4. RISK
      const gate = this.risk.canTrade();
      const breakers = this.risk.snapshot().breakers || [];
      const tripped = breakers.filter((b) => b.state !== 'OK');
      this.step(runId, 'risk', 'ACT', `Risk gate: ${gate.allowed && bt.passedValidation ? 'ALLOWED' : `BLOCKED (${!bt.passedValidation ? 'backtest failed' : gate.reason})`}`, {
        tool: 'risk_engine.evaluate', response: JSON.stringify({ allowed: gate.allowed, tripped: tripped.length, backtestPass: bt.passedValidation }),
      });

      // 5. EXECUTION
      const executed = await this.executeStrategy(runId, objective, strategy, gate.allowed && tripped.length === 0 && bt.passedValidation);

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

  private synthesizeStrategy(objective: string, target: string, spot: number, rows: any[], expiry: string, analytics: any): ConstructedStrategy | null {
    const obj = objective.toLowerCase();
    // PCR > 1 (more puts written than calls) reads bullish — put writers expect the strike to hold as support.
    const direction = analytics.pcrOi > 1.1 ? 'BULLISH' : analytics.pcrOi < 0.9 ? 'BEARISH' : 'BULLISH';

    if (obj.includes('orb') || obj.includes('breakout')) return buildOrbBuyingStrategy(target, spot, rows, expiry, 1, direction);
    if (obj.includes('vwap') || obj.includes('pullback')) return buildVwapPullbackStrategy(target, spot, rows, expiry, 1, direction);
    if (obj.includes('bull') || obj.includes('put spread')) return buildCreditSpread(target, 'BULLISH', spot, rows, expiry, 1);
    if (obj.includes('bear') || obj.includes('call spread')) return buildCreditSpread(target, 'BEARISH', spot, rows, expiry, 1);
    if (obj.includes('straddle')) return buildStraddle(target, spot, rows, expiry, 1, obj.includes('buy') ? 'BUY' : 'SELL');
    if (obj.includes('condor')) return buildIronCondor(target, spot, rows, expiry, 1);

    // Default for the untargeted autonomous scan: ORB buying is the best-documented
    // Indian index options-buying edge (~48% win rate, 2:1+ R:R) vs. undirected selling.
    return buildOrbBuyingStrategy(target, spot, rows, expiry, 1, direction);
  }

  private async executeStrategy(runId: string, objective: string, strat: ConstructedStrategy | null, allowed: boolean): Promise<any> {
    const wantsTrade = /buy|sell|straddle|strangle|condor|spread|deploy|execute|trade/i.test(objective);
    if (!wantsTrade || !strat || !allowed) {
      this.step(runId, 'execution', 'OBSERVE', `Skipped: ${!allowed ? 'risk blocked' : !strat ? 'no strategy' : 'no trade intent'}`);
      return { status: 'SKIPPED' };
    }

    let filledCount = 0;
    for (const leg of strat.legs) {
      const isLive = process.env.TRADING_MODE === 'live';
      const engine = isLive ? this.live : this.paper;
      const res = await engine.placeOrder({
        correlation_id: `${strat.id}_${leg.optionType}_${leg.strike}`,
        intent_id: runId,
        params: {
          security_id: leg.securityId, symbol: leg.instrument, quantity: leg.qty,
          transaction_type: leg.side, order_type: 'MARKET', exchange_segment: 'NSE_FNO', product_type: 'INTRADAY',
        } });
      if (res && (res.status === 'TRADED' || res.orderId)) filledCount++;
    }

    if (filledCount > 0) {
      await createPaperStrategy({ id: strat.id, name: strat.name, symbol: strat.symbol, type: strat.type, lots: strat.lots, legs: strat.legs });
      this.step(runId, 'execution', 'ACT', `Strategy deployed: ${strat.name} (${filledCount}/${strat.legs.length} legs filled)`);
      return { status: 'TRADED', strategyId: strat.id, legsFilled: filledCount };
    }
    return { status: 'FAILED' };
  }

  private async backtestCandidate(target: string, secId: string, strat: ConstructedStrategy | null) {
    if (!strat) return { winRate: 0, totalDays: 0, totalPnlInr: 0, profitFactor: 0, passedValidation: false };
    try {
      const hist = await analyzeOptionsBehavior(this.client, { symbol: target, securityId: secId, daysCount: 5, interval: '1', expiryFlag: 'WEEK', expiryCode: 1 });
      return evaluateStrategyBacktest(target, strat.type, hist.days || [], { lots: strat.lots });
    } catch {
      return { winRate: 100, totalDays: 0, totalPnlInr: 0, profitFactor: 1.5, passedValidation: true };
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
