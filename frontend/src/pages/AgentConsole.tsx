import { useRef, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { StatusDot } from '../components/ui/StatusDot';
import { Terminal, Play, Network } from 'lucide-react';
import type { TelemetryEvent } from '../store/types';

const AGENT_PERSONAS: Record<string, { name: string; color: string }> = {
  planner: { name: 'Planner Agent', color: '#38bdf8' },
  analyst: { name: 'Market Analyst', color: '#00d4aa' },
  strategy: { name: 'Strategy Agent', color: '#f0b429' },
  execution: { name: 'Execution Agent', color: '#a855f7' },
  risk: { name: 'Risk Agent', color: '#ff3b5c' },
  critic: { name: 'Critic Agent', color: '#f472b6' },
};

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function AgentConsole() {
  const { state, setState, showToast, addSystemLog } = useApp();
  const [input, setInput] = useState('');
  const traceRef = useRef<HTMLDivElement>(null);

  const addStep = (agentKey: string, type: string, summary: string, tool?: string, response?: string) => {
    const ev: TelemetryEvent = {
      id: `ev_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      agent: agentKey,
      type,
      time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      summary,
      tool,
      response,
      duration: Math.round(15 + Math.random() * 45),
    };
    setState(prev => ({
      ...prev,
      telemetryEvents: [...prev.telemetryEvents, ev],
      agentTokens: prev.agentTokens + (tool ? 350 : 180),
      agentDhanCalls: prev.agentDhanCalls + (tool ? 1 : 0),
    }));
  };

  const runScenario = async (objective: string) => {
    const lower = objective.toLowerCase();
    const steps = lower.includes('deploy') || lower.includes('condor')
      ? deploySteps
      : lower.includes('risk') || lower.includes('gamma')
        ? riskSteps
        : lower.includes('close') || lower.includes('stop')
          ? closeSteps
          : analyzeSteps;

    for (const step of steps) {
      await new Promise(r => setTimeout(r, 400));
      addStep(step.agent, step.type, step.summary, step.tool, step.response);
    }
    setState(prev => ({ ...prev, agentRunning: false }));
    showToast('Agent task execution completed', 'success');
  };

  const execute = () => {
    if (!input.trim() || state.agentRunning) return;
    setState(prev => ({ ...prev, agentRunning: true, agentStepNum: 0, agentStartTime: Date.now() }));
    addSystemLog('INFO', `Agent objective submitted: ${input}`, 'agent');
    const obj = input;
    setInput('');
    runScenario(obj);
  };

  const events = state.eventFilter === 'all'
    ? state.telemetryEvents
    : state.telemetryEvents.filter(e => e.type === state.eventFilter);

  return (
    <div className="flex flex-col h-[calc(100vh-100px)] space-y-3">
      <Card className="p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-purple/10 border border-purple/20 flex items-center justify-center">
            <Network size={12} className="text-purple" />
          </div>
          <div>
            <div className="text-xs font-bold text-white">Multi-Agent ReAct Execution Engine</div>
            <div className="text-[9.5px] font-mono text-muted">Ollama (Cognition) + DhanHQ SDK (Tools) + Rails (State)</div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-[10px] font-mono">
          {Object.entries(AGENT_PERSONAS).map(([k, a]) => (
            <div key={k} className="flex items-center gap-1.5">
              <StatusDot status="idle" />
              <span style={{ color: a.color }}>{a.name.split(' ')[0]}</span>
            </div>
          ))}
        </div>
      </Card>

      <div ref={traceRef} className="flex-1 card p-4 overflow-y-auto space-y-3 font-mono text-xs">
        {events.length === 0 && !state.agentRunning && (
          <div className="text-center py-8 space-y-3 max-w-xl mx-auto">
            <div className="w-12 h-12 rounded-xl bg-surface-200 border border-border flex items-center justify-center mx-auto text-purple text-xl">
              <Network size={20} />
            </div>
            <div className="text-sm font-semibold text-white">Autonomous Options Trading Agents</div>
            <div className="text-xs text-muted">Submit a natural language prompt below. The multi-agent loop will decompose, research, and execute trades safely.</div>
            <div className="flex justify-center gap-2 flex-wrap text-[10.5px]">
              <Button variant="ghost" onClick={() => { setInput('Analyze NIFTY option chain and find highest probability trade'); }}>Analyze NIFTY Chain</Button>
              <Button variant="ghost" onClick={() => { setInput('Deploy BANKNIFTY Iron Condor 2 lots with hedge verification'); }}>Deploy Iron Condor</Button>
              <Button variant="ghost" onClick={() => { setInput('Audit portfolio Greek risk exposure and short gamma'); }}>Audit Greeks Risk</Button>
            </div>
          </div>
        )}

        {events.map((ev) => {
          const a = AGENT_PERSONAS[ev.agent] || AGENT_PERSONAS.planner;
          return (
            <div key={ev.id} className="card p-3 slide-in border-l-2 text-xs font-mono" style={{ borderLeftColor: a.color }}>
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-border text-[9.5px]">
                <div className="flex items-center gap-1.5">
                  <StatusDot status="live" />
                  <span style={{ color: a.color }} className="font-bold">{a.name}</span>
                </div>
                <div className="flex items-center gap-2 text-muted">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold
                    ${ev.type === 'THINK' ? 'bg-sky/12 text-sky' : ev.type === 'ACT' ? 'bg-accent/12 text-accent' : ev.type === 'CRITIQUE' ? 'bg-pink/12 text-pink' : 'bg-gold/12 text-gold'}`}>
                    {ev.type}
                  </span>
                  <span>{ev.time}</span>
                  {ev.duration && <span>{ev.duration}ms</span>}
                </div>
              </div>
              <div className="text-white/80 whitespace-pre-wrap">{ev.summary}</div>
              {ev.tool && <div className="code-blk mt-1.5 text-sky">{escapeHtml(ev.tool)}</div>}
              {ev.response && <div className="code-blk mt-1 text-muted">{escapeHtml(ev.response)}</div>}
            </div>
          );
        })}
      </div>

      <Card className="p-3 flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted"><Terminal size={12} /></span>
          <Input
            className="pl-8 text-xs"
            placeholder="Enter objective for the agent system..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') execute(); }}
          />
        </div>
        <Button onClick={execute} disabled={state.agentRunning}>
          <Play size={12} /> Run Objective
        </Button>
      </Card>
    </div>
  );
}

const analyzeSteps = [
  { agent: 'planner', type: 'THINK', summary: 'Decomposing task objective into subtask DAG:\n1. Fetch NIFTY spot + ATM options LTP via Dhan API\n2. Query option chain with Greeks, IV, OI\n3. Run Ollama LLM sentiment & strategy scoring\n4. Execute pre-trade margin hedge calculation\n5. Submit to Critic Agent for safety validation' },
  { agent: 'analyst', type: 'ACT', summary: 'Fetching NIFTY spot and ATM options LTPs from marketfeed.', tool: 'dhan.get_ltp({ "NSE_FNO": [49081, 49082] })' },
  { agent: 'analyst', type: 'OBSERVE', summary: 'Spot: 24,248.50. 24250CE @ 198.20, 24250PE @ 165.80.', response: '{ "spot": 24248.50, "49081": { "ltp": 198.20 }, "49082": { "ltp": 165.80 } }' },
  { agent: 'analyst', type: 'ACT', summary: 'Retrieving option chain with Greeks and OI.', tool: 'dhan.get_option_chain({ "UnderlyingScrip": 13, "Expiry": "2025-01-30" })' },
  { agent: 'analyst', type: 'OBSERVE', summary: '17 strikes. ATM IV 13.8%, PCR 1.12, max pain 24,200.', response: '{ "ATM_IV_CE": 13.8, "PCR": 1.12, "maxPain": 24200 }' },
  { agent: 'strategy', type: 'ACT', summary: 'Scoring candidate strategies via Ollama LLM.', tool: 'ollama.generate_strategy({ "ivr": 42.3, "pcr": 1.12 })' },
  { agent: 'strategy', type: 'OBSERVE', summary: 'LLM recommends Bull Put Spread (Score 0.84).', response: '{ "sentiment": "moderately_bullish", "confidence": 0.72, "top_strategy": "BULL_PUT_SPREAD" }' },
  { agent: 'risk', type: 'ACT', summary: 'Calculating combined margin with hedge benefit.', tool: 'dhan.calc_multi_margin({ "scripList": [...] })' },
  { agent: 'risk', type: 'OBSERVE', summary: 'Margin: 18,540 INR. Hedge benefit: 35.8%.', response: '{ "totalMargin": 18540, "hedgeBenefit": 10360 }' },
  { agent: 'critic', type: 'CRITIQUE', summary: '✅ PLAN VALIDATED:\n• IV Rank (42.3) > 30 — PASS\n• Margin (18.5K) < 5.0L — PASS\n• Utilization: 52.6% < 70% — PASS\n• T-2 expiry: No delivery risk — PASS\n\nVerdict: APPROVED FOR DEPLOYMENT' },
];

const deploySteps = [
  { agent: 'planner', type: 'THINK', summary: 'Deploying BANKNIFTY Iron Condor (2 lots):\n1. Query BANKNIFTY spot\n2. Select strikes\n3. Check margin hedge discount\n4. Place 4 legs atomically\n5. Verify fill status' },
  { agent: 'analyst', type: 'ACT', summary: 'Querying spot for strike selection.', tool: 'dhan.get_ltp({ "NSE_FNO": [51345] })' },
  { agent: 'analyst', type: 'OBSERVE', summary: 'BANKNIFTY Spot: 51,842.15 (ATM: 51,800).', response: '{ "51345": { "ltp": 51842.15 } }' },
  { agent: 'execution', type: 'ACT', summary: 'Placing 4 legs with correlationId.', tool: 'dhan.place_order(4_legs_basket)' },
  { agent: 'execution', type: 'OBSERVE', summary: 'All 4 legs TRADED. Latency 164ms.', response: '{ "ORD-101": "TRADED", "ORD-102": "TRADED" }' },
  { agent: 'critic', type: 'CRITIQUE', summary: '✅ Post-execution verified:\n• 4/4 legs confirmed — PASS\n• Margin locked: 45,200 INR — PASS' },
];

const riskSteps = [
  { agent: 'planner', type: 'THINK', summary: 'Auditing portfolio Greeks and stress-testing scenarios.' },
  { agent: 'risk', type: 'ACT', summary: 'Aggregating open positions.', tool: 'dhan.get_positions()' },
  { agent: 'risk', type: 'OBSERVE', summary: '11 active legs. Net delta +0.03, gamma -2.14.', response: '{ "netDelta": 0.03, "netGamma": -2.14, "netTheta": 845 }' },
  { agent: 'critic', type: 'CRITIQUE', summary: '✅ Risk Audit Accepted. Hedge alert armed for NIFTY ±200 pts.' },
];

const closeSteps = [
  { agent: 'planner', type: 'THINK', summary: 'Selective closure of paused Bull Put Spread.' },
  { agent: 'execution', type: 'ACT', summary: 'Sending market orders to close 2 legs.', tool: 'dhan.place_order({ "tx": "BUY", "sec": "49085" })' },
  { agent: 'execution', type: 'OBSERVE', summary: 'Both legs closed. Realized P&L: -3,800 INR.', response: '{ "status": "CLOSED" }' },
  { agent: 'critic', type: 'CRITIQUE', summary: '✅ Strategy closed. Remaining: 2 active.' },
];
