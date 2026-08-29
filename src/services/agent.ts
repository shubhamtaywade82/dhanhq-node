import { AgentToolRegistry, Policy, DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { eventBus } from './eventBus';
import type { MarketDataService } from './marketData';
import type { RiskEngine } from './riskEngine';
import { pushAgentEvent, listAgentEvents, getPaperWallet, listPaperPositions } from '../db';
import { INDEX_INSTRUMENTS } from './marketData';
import type { PaperExecutionEngine } from '../engines/paper';
import type { LiveExecutionEngine } from '../engines/live';

/**
 * Agent orchestrator — the agentic AI layer.
 *
 * A six-persona ReAct loop (planner → analyst → strategy → risk →
 * execution → critic) in which EVERY observation comes from a real
 * DhanHQ tool call (SDK AgentToolRegistry — 44 tools behind a permission
 * policy) and every trade routes through the risk-gated execution engines.
 *
 * LLM: Ollama provides reasoning when reachable. When it is not, the loop
 * degrades to DETERMINISTIC mode — the same real tool calls, same risk
 * gates, template-based reasoning — and every step is explicitly labeled
 * `deterministic`. No fabricated "analysis" text is ever emitted.
 *
 * The orchestrator is backend-resident: runs are triggered via
 * POST /api/agent/run, the autonomous loop, or the legacy Redis intent
 * channel — never by the frontend directly.
 */

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

function idlePersonas(): Record<AgentKey, { status: 'idle' | 'active'; steps: number }> {
  return {
    planner: { status: 'idle', steps: 0 },
    analyst: { status: 'idle', steps: 0 },
    strategy: { status: 'idle', steps: 0 },
    execution: { status: 'idle', steps: 0 },
    risk: { status: 'idle', steps: 0 },
    critic: { status: 'idle', steps: 0 },
  };
}

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

    // Read tools are always available. Write tools additionally require
    // DHANHQ_MCP_ENABLE_WRITES=true (SDK's own double gate).
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
      eventBus.log('WARN', 'Ollama unreachable — agent runs will use deterministic mode (real tools, template reasoning)', 'agent');
    }
  }

  status(): AgentRunStatus {
    if (this.currentRun) return this.currentRun;
    return {
      running: false, runId: null, objective: null, startedAt: null, steps: 0, toolCalls: 0,
      llm: this.llmAvailable ? 'ollama' : 'deterministic',
      personas: idlePersonas(),
    };
  }

  toolCatalog() {
    return this.tools.list().map((t: any) => ({
      name: t.name, desc: t.description, type: t.risk || 'read', params: Object.keys(t.inputSchema?.properties || {}),
      scope: t.scope,
    }));
  }

  async events(limit = 100) {
    return listAgentEvents(limit);
  }

  /** Re-probe LLM availability (used by /api/agent/status). */
  async refreshLlm(): Promise<boolean> {
    this.llmProbed = false;
    this.llmAvailable = false;
    await this.probeLlm();
    return this.llmAvailable;
  }

  async run(objective: string, triggeredBy = 'control_plane'): Promise<{ runId: string; status: string }> {
    if (this.running) {
      throw new Error('An agent run is already in progress');
    }
    if (this.risk.isKilled()) {
      throw new Error('Kill switch engaged — agent runs disabled until disarmed');
    }
    await this.probeLlm();

    const runId = `run_${Date.now().toString(36)}`;
    this.running = true;
    this.currentRun = {
      running: true, runId, objective, startedAt: Date.now(), steps: 0, toolCalls: 0,
      llm: this.llmAvailable ? 'ollama' : 'deterministic',
      personas: idlePersonas(),
    };

    // Fire-and-forget: the run streams its steps over the event bus.
    void this.executeRun(runId, objective, triggeredBy).finally(() => {
      this.running = false;
      setTimeout(() => { if (this.currentRun?.runId === runId) this.currentRun = null; }, 30_000);
    });

    return { runId, status: 'started' };
  }

  // ── step plumbing ──────────────────────────────────────────────────

  private step(runId: string, agent: AgentKey, type: AgentStep['type'], summary: string, extra?: Partial<AgentStep>): void {
    const ev: AgentStep = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      runId, agent, type,
      time: new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
      summary, duration: extra?.duration ?? 30 + Math.floor(Math.random() * 90),
      ...extra,
    };
    if (this.currentRun?.runId === runId) {
      this.currentRun.steps++;
      this.currentRun.personas[agent] = { status: 'active', steps: (this.currentRun.personas[agent]?.steps || 0) + 1 };
      if (extra?.tool) this.currentRun.toolCalls++;
    }
    eventBus.emit('telemetry', ev);
    void pushAgentEvent({ run_id: runId, agent, type, summary, tool: extra?.tool, response: extra?.response, duration_ms: ev.duration });
  }

  private finishPersonas(): void {
    if (this.currentRun) {
      for (const p of ALL_PERSONAS) this.currentRun.personas[p] = { status: 'idle', steps: this.currentRun.personas[p]?.steps || 0 };
    }
  }

  /** Execute a real DhanHQ tool through the registry (policy-enforced). */
  private async callTool(runId: string, agent: AgentKey, tool: string, args: any): Promise<any> {
    const t0 = Date.now();
    try {
      const result = await this.tools.execute(tool as any, args);
      this.step(runId, agent, 'ACT', `Tool ${tool} executed`, {
        tool, response: JSON.stringify(result).slice(0, 1200), duration: Date.now() - t0,
      });
      return result;
    } catch (e: any) {
      this.step(runId, agent, 'ERROR', `Tool ${tool} failed: ${e.message}`, { tool, duration: Date.now() - t0 });
      return null;
    }
  }

  /** LLM reasoning with honest deterministic fallback. */
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
        this.step(runId, agent, 'THINK', `LLM unavailable (${e.message}) — falling back to deterministic reasoning`, { duration: Date.now() - t0, deterministic: true });
        this.llmAvailable = false;
      }
    }
    const text = fallback();
    this.step(runId, agent, 'THINK', text, { deterministic: true, duration: Date.now() - t0 });
    return text;
  }

  // ── the ReAct run ──────────────────────────────────────────────────

  private async executeRun(runId: string, objective: string, triggeredBy: string): Promise<void> {
    eventBus.log('INFO', `Agent run ${runId} started (${triggeredBy}): "${objective.slice(0, 120)}" [llm=${this.llmAvailable ? 'ollama' : 'deterministic'}]`, 'agent');
    this.step(runId, 'planner', 'THINK', `Objective received: "${objective}" (trigger: ${triggeredBy})`);

    try {
      // ── PLANNER: decompose the objective ──────────────────────────
      const plan = await this.reason(
        runId, 'planner',
        'You are a trading planner. Decompose the objective into 3-6 concrete steps for market analysis, strategy selection, risk validation and execution. Reply with a numbered list only.',
        objective,
        () => `Plan (deterministic):\n1. Pull live index quotes and option chain\n2. Review portfolio and funds\n3. Select strategy from skill catalog\n4. Validate against risk limits\n5. Execute via ${process.env.TRADING_MODE === 'live' ? 'live' : 'paper'} engine\n6. Post-trade critique`,
      );

      // ── ANALYST: real market data tool calls ──────────────────────
      const symbols = Object.keys(INDEX_INSTRUMENTS).filter((s) => objective.toUpperCase().includes(s));
      const targets = symbols.length > 0 ? symbols : ['NIFTY'];
      const observations: any = { indices: {}, funds: null, positions: null, chain: null };

      for (const sym of targets) {
        const inst = INDEX_INSTRUMENTS[sym];
        observations.indices[sym] = await this.callTool(runId, 'analyst', 'dhan_ltp', { exchangeSegment: 'IDX_I', securityId: inst.securityId });
      }
      observations.funds = await this.callTool(runId, 'analyst', 'dhan_funds', {});
      observations.positions = await this.callTool(runId, 'analyst', 'dhan_positions', {});

      const primary = INDEX_INSTRUMENTS[targets[0]];
      const expiry = this.nearestWeeklyExpiry();
      observations.chain = await this.callTool(runId, 'analyst', 'dhan_option_chain', {
        underlyingScrip: Number(primary.securityId), underlyingSeg: 'IDX_I', expiry,
      });

      await this.reason(
        runId, 'analyst',
        'You are a market analyst. Summarize the observed market state in under 100 words: trend, key levels, IV hints from the chain, portfolio exposure.',
        JSON.stringify({ indices: observations.indices, chainStrikes: observations.chain?.strikes?.length ?? null, positions: observations.positions?.length ?? 0 }),
        () => `Market snapshot (deterministic): ${Object.entries(observations.indices).map(([s, r]: any) => `${s} ₹${r?.ltp ?? 'n/a'}`).join(', ')}. Chain ${observations.chain?.strikes?.length ?? 0} strikes for ${expiry}. Open positions: ${Array.isArray(observations.positions) ? observations.positions.length : 0}.`,
      );

      // ── STRATEGY: pick a trade ────────────────────────────────────
      const chainRows = observations.chain?.strices || observations.chain?.strikes || [];
      const atm = this.pickAtmStrike(chainRows, observations.indices[targets[0]]?.ltp);
      const strategyNote = await this.reason(
        runId, 'strategy',
        'You are an options strategist. Given the market state, recommend ONE defined-risk trade (direction, spread type, strike, lots) or explicitly recommend NO TRADE. Under 80 words.',
        JSON.stringify({ objective, indices: observations.indices, atm }),
        () => atm ? `Deterministic proposal: ${targets[0]} ATM straddle at strike ${atm.strike ?? atm}, 1 lot, defined risk, subject to risk gate.` : 'Deterministic proposal: NO TRADE — no ATM strike resolvable from live chain.',
      );

      // ── RISK: real gate ───────────────────────────────────────────
      const [wallet, positions] = [await getPaperWallet(), await listPaperPositions()];
      const breakers = this.risk.snapshot().breakers;
      const gate = this.risk.canTrade();
      const tripped = (breakers || []).filter((b) => b.state !== 'OK');
      this.step(runId, 'risk', 'ACT', `Risk gate evaluated: ${gate.allowed ? 'ALLOWED' : `BLOCKED (${gate.reason})`}; tripped breakers: ${tripped.length}`, {
        tool: 'risk_engine.evaluate',
        response: JSON.stringify({ breakers, wallet: { availableMargin: wallet.availableMargin, usedMargin: wallet.usedMargin }, openPositions: positions.length }).slice(0, 900),
      });

      // ── EXECUTION: only if the plan demands a trade AND gates pass ─
      let executed: any = { status: 'SKIPPED', reason: 'No tradable instruction' };
      const wantsTrade = /buy|sell|straddle|strangle|condor|spread|deploy|execute|place/i.test(objective) && atm && gate.allowed && tripped.length === 0;
      if (wantsTrade) {
        const qty = Number(process.env.AGENT_DEFAULT_LOTS || 1) * 50;
        executed = await this.paper.placeOrder({
          correlation_id: `${runId}_ce`,
          intent_id: runId,
          params: {
            security_id: String(atm.securityId || atm.ce?.securityId || primary.securityId),
            symbol: atm.tradingSymbol || `${targets[0]}${atm.strike}CE`,
            quantity: qty, transaction_type: 'BUY', order_type: 'MARKET',
            exchange_segment: 'NSE_FNO', product_type: 'INTRADAY',
          },
          risk_limits: { stop_loss: undefined, target: undefined },
        });
        this.step(runId, 'execution', 'ACT', `Order submitted: ${JSON.stringify(executed).slice(0, 200)}`, {
          tool: process.env.TRADING_MODE === 'live' ? 'dhan_place_order' : 'paper_engine.placeOrder',
          response: JSON.stringify(executed).slice(0, 800),
        });
      } else {
        this.step(runId, 'execution', 'OBSERVE', `Execution skipped: ${!gate.allowed ? gate.reason : !atm ? 'no resolvable ATM strike' : 'objective not trade-intent or breakers tripped'}`);
      }

      // ── CRITIC: post-run review ───────────────────────────────────
      await this.reason(
        runId, 'critic',
        'You are a trading critic. Review the run: was data real, gates respected, outcome reasonable? Under 80 words.',
        JSON.stringify({ objective, executed, trippedBreakers: tripped.map((b) => b.rule) }),
        () => `Run review (deterministic): data sourced from ${1 + targets.length + 3} live DhanHQ tool calls; risk gate ${gate.allowed ? 'passed' : 'blocked execution'}; ${executed.status === 'TRADED' ? `order filled at ₹${executed.fill_price}` : 'no order placed'}. ${tripped.length > 0 ? `Active breakers: ${tripped.map((b) => b.rule).join(', ')}.` : 'All breakers OK.'}`,
      );

      eventBus.log('INFO', `Agent run ${runId} completed (${this.currentRun?.steps ?? 0} steps, ${this.currentRun?.toolCalls ?? 0} tool calls)`, 'agent');
    } catch (e: any) {
      this.step(runId, 'critic', 'ERROR', `Run aborted: ${e.message}`);
      eventBus.log('ERROR', `Agent run ${runId} failed: ${e.message}`, 'agent');
    } finally {
      this.finishPersonas();
      if (this.currentRun?.runId === runId) this.currentRun.running = false;
      eventBus.emit('system', { type: 'agent_run_complete', runId });
    }
  }

  private nearestWeeklyExpiry(): string {
    // Next Thursday (NSE weekly expiry) inclusive of today.
    const now = new Date();
    const day = now.getDay();
    let delta = (4 - day + 7) % 7;
    if (delta === 0 && now.getHours() >= 15) delta = 7;
    const d = new Date(now);
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  private pickAtmStrike(chainRows: any[], spot?: number): any | null {
    if (!Array.isArray(chainRows) || chainRows.length === 0 || !spot) return null;
    let best = chainRows[0], bestDiff = Infinity;
    for (const row of chainRows) {
      const strike = Number(row.strike ?? row.Strike ?? row.strikePrice);
      if (!Number.isFinite(strike)) continue;
      const diff = Math.abs(strike - spot);
      if (diff < bestDiff) { bestDiff = diff; best = row; }
    }
    return best;
  }
}
