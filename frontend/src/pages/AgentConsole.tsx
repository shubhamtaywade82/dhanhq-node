import { useState, useEffect } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { StatusDot } from '../components/ui/StatusDot';
import { Terminal, Play, Network } from 'lucide-react';
import { api } from '../services/api';

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

/**
 * Agent console — a control plane for the BACKEND agent orchestrator.
 *
 * Objectives are POSTed to /api/control/agent/run; the run executes on
 * the backend (Ollama reasoning + 44 real DhanHQ tools) and its ReAct
 * steps stream back over the WS telemetry channel. No client-side
 * fallbacks, no fabricated agent output.
 */
export function AgentConsole() {
  const { state, setState, showToast, addSystemLog } = useApp();
  const [input, setInput] = useState('');
  const [llmMode, setLlmMode] = useState<string>('…');

  // Live agent status (personas, LLM mode) from the backend.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const st = await api.agentStatus();
        if (!alive) return;
        setLlmMode(st.llm || 'deterministic');
        setState((prev) => ({ ...prev, agentRunning: !!st.running, agentStatus: st.personas || prev.agentStatus }));
      } catch { /* backend down — UI shows disconnected */ }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [setState]);

  const runObjective = async (objective: string) => {
    try {
      const result = await api.runAgent(objective);
      addSystemLog('INFO', `Agent run ${result.runId} dispatched to backend orchestrator`, 'agent');
      showToast(`Agent run ${result.runId} started (${llmMode} mode) — steps stream live below`, 'success');
      // Steps arrive over the WS telemetry channel and land in
      // state.telemetryEvents via AppContext.
    } catch (e: any) {
      showToast(`Agent run failed: ${e.message}`, 'error');
      addSystemLog('ERROR', `Agent run rejected: ${e.message}`, 'agent');
    } finally {
      setState((prev) => ({ ...prev, agentRunning: false }));
    }
  };

  const execute = () => {
    if (!input.trim() || state.agentRunning) return;
    setState((prev) => ({ ...prev, agentRunning: true, agentStartTime: Date.now(), telemetryEvents: [] }));
    addSystemLog('INFO', `Agent objective submitted: ${input}`, 'agent');
    const obj = input;
    setInput('');
    runObjective(obj);
  };

  const events = state.eventFilter === 'all'
    ? state.telemetryEvents
    : state.telemetryEvents.filter((e) => e.type === state.eventFilter);

  return (
    <div className="flex flex-col h-[calc(100vh-100px)] space-y-3">
      <Card className="p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-purple/10 border border-purple/20 flex items-center justify-center">
            <Network size={12} className="text-purple" />
          </div>
          <div>
            <div className="text-xs font-bold text-white">Multi-Agent ReAct Execution Engine</div>
            <div className="text-[9.5px] font-mono text-muted">
              {llmMode === 'ollama' ? 'Ollama (reasoning)' : 'Deterministic (real tools, template reasoning)'} + DhanHQ SDK Tools + PostgreSQL State
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-[10px] font-mono">
          {Object.entries(AGENT_PERSONAS).map(([k, a]) => {
            const s = state.agentStatus[k] || { status: 'idle', steps: 0 };
            return (
              <div key={k} className="flex items-center gap-1.5">
                <StatusDot status={s.status === 'active' ? 'live' : 'idle'} pulse={s.status === 'active'} />
                <span style={{ color: a.color }}>{a.name.split(' ')[0]}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="flex-1 card p-4 overflow-y-auto space-y-3 font-mono text-xs">
        {events.length === 0 && !state.agentRunning && (
          <div className="text-center py-8 space-y-3 max-w-xl mx-auto">
            <div className="w-12 h-12 rounded-xl bg-surface-200 border border-border flex items-center justify-center mx-auto text-purple text-xl">
              <Network size={20} />
            </div>
            <div className="text-sm font-semibold text-white">Autonomous Options Trading Agents</div>
            <div className="text-xs text-muted">
              Submit a trading objective. The backend orchestrator runs the ReAct loop
              (planner → analyst → strategy → risk → execution → critic) against live
              DhanHQ market data; every step streams here in real time.
            </div>
            <div className="flex justify-center gap-2 flex-wrap text-[10.5px]">
              <Button variant="ghost" onClick={() => setInput('Analyze NIFTY option chain and find highest probability trade')}>Analyze NIFTY Chain</Button>
              <Button variant="ghost" onClick={() => setInput('Audit portfolio Greek risk exposure and short gamma')}>Audit Greeks Risk</Button>
              <Button variant="ghost" onClick={() => setInput('Review market bias and recommend a defined-risk trade')}>Market Bias Review</Button>
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
                    ${ev.type === 'THINK' ? 'bg-sky/12 text-sky' : ev.type === 'ACT' ? 'bg-accent/12 text-accent' : ev.type === 'CRITIQUE' ? 'bg-pink/12 text-pink' : ev.type === 'ERROR' ? 'bg-danger/12 text-danger' : 'bg-gold/12 text-gold'}`}>
                    {ev.type}
                  </span>
                  <span>{ev.time}</span>
                  {ev.duration != null && <span>{ev.duration}ms</span>}
                </div>
              </div>
              <div className="text-white/80 whitespace-pre-wrap">{ev.summary}</div>
              {ev.tool && <div className="code-blk mt-1.5 text-sky">{escapeHtml(ev.tool)}</div>}
              {ev.response && <div className="code-blk mt-1 text-muted whitespace-pre-wrap break-all">{escapeHtml(ev.response)}</div>}
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
          <Play size={12} /> {state.agentRunning ? 'Running…' : 'Run Objective'}
        </Button>
      </Card>
    </div>
  );
}
