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
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [userExecuting, setUserExecuting] = useState<boolean>(false);

  // Live agent status (personas, LLM mode) from the backend on mount.
  useEffect(() => {
    let alive = true;
    const loadStatus = async () => {
      try {
        const st = await api.agentStatus();
        if (!alive) return;
        setLlmMode(st.llm || 'deterministic');
        setState((prev) => ({ ...prev, agentRunning: !!st.running, agentStatus: st.personas || prev.agentStatus }));
      } catch { /* backend down */ }
    };
    loadStatus();
    return () => { alive = false; };
  }, [setState]);

  const runObjective = async (objective: string) => {
    try {
      setUserExecuting(true);
      const result = await api.runAgent(objective);
      setActiveRunId(result.runId);
      addSystemLog('INFO', `Agent run ${result.runId} dispatched to backend orchestrator`, 'agent');
      showToast(`Agent run ${result.runId} started (${llmMode} mode) — steps stream live below`, 'success');
    } catch (e: any) {
      showToast(`Agent run failed: ${e.message}`, 'error');
      addSystemLog('ERROR', `Agent run rejected: ${e.message}`, 'agent');
    } finally {
      setUserExecuting(false);
    }
  };

  const execute = () => {
    if (!input.trim() || userExecuting) return;
    setUserExecuting(true);
    addSystemLog('INFO', `Agent objective submitted: ${input}`, 'agent');
    const obj = input;
    setInput('');
    runObjective(obj);
  };

  // Filter events to prioritize the user's interactive session and exclude background autonomous scan noise
  const events = state.telemetryEvents.filter((e) => {
    if (state.eventFilter !== 'all' && e.type !== state.eventFilter) return false;
    if (activeRunId) return e.runId === activeRunId;
    return e.triggeredBy !== 'autonomous_scanner';
  });

  const isBackgroundScanning = state.agentRunning && !userExecuting;

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
          {isBackgroundScanning && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-200 border border-border text-muted">
              <StatusDot status="live" pulse />
              <span>Background scan active</span>
            </div>
          )}
          {activeRunId && (
            <Button
              variant="ghost"
              className="text-[10px] py-0.5 h-6 text-muted hover:text-white"
              onClick={() => setActiveRunId(null)}
            >
              Clear Session
            </Button>
          )}
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
              <Button variant="ghost" onClick={() => setInput('What is the lot size of options for BANKNIFTY currently')}>BANKNIFTY Lot Size</Button>
              <Button variant="ghost" onClick={() => setInput('What is the lot size of options for SENSEX currently')}>SENSEX Lot Size</Button>
              <Button variant="ghost" onClick={() => setInput('Search instrument RELIANCE')}>Search RELIANCE</Button>
              <Button variant="ghost" onClick={() => setInput('What are the upcoming option expiries for NIFTY?')}>NIFTY Expiries</Button>
              <Button variant="ghost" onClick={() => setInput('What is my available margin and open positions?')}>Margin & Positions</Button>
              <Button variant="ghost" onClick={() => setInput('Analyze NIFTY option chain and find highest probability trade')}>Analyze NIFTY Chain</Button>
            </div>
          </div>
        )}

        {events.map((ev) => {
          const a = AGENT_PERSONAS[ev.agent] || AGENT_PERSONAS.planner;
          const isAnswer = ev.summary?.startsWith('Answer:');
          return (
            <div
              key={ev.id}
              className={`card p-3 slide-in border-l-2 text-xs font-mono ${
                isAnswer ? 'border-l-emerald-400 bg-emerald-950/20 border-emerald-500/30 shadow-md shadow-emerald-950/20' : ''
              }`}
              style={{ borderLeftColor: isAnswer ? '#34d399' : a.color }}
            >
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-border text-[9.5px]">
                <div className="flex items-center gap-1.5">
                  <StatusDot status={isAnswer ? 'live' : 'live'} />
                  <span style={{ color: isAnswer ? '#34d399' : a.color }} className="font-bold">
                    {isAnswer ? 'Analyst Resolution' : a.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-muted">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold
                    ${isAnswer ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : ev.type === 'THINK' ? 'bg-sky/12 text-sky' : ev.type === 'ACT' ? 'bg-accent/12 text-accent' : ev.type === 'CRITIQUE' ? 'bg-pink/12 text-pink' : ev.type === 'ERROR' ? 'bg-danger/12 text-danger' : 'bg-gold/12 text-gold'}`}>
                    {isAnswer ? 'ANSWER' : ev.type}
                  </span>
                  <span>{ev.time}</span>
                  {ev.duration != null && <span>{ev.duration}ms</span>}
                </div>
              </div>
              <div className={`${isAnswer ? 'text-emerald-100 font-medium text-[12.5px] leading-relaxed' : 'text-white/80'} whitespace-pre-wrap`}>
                {ev.summary}
              </div>
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
        <Button onClick={execute} disabled={userExecuting}>
          <Play size={12} /> {userExecuting ? 'Running…' : 'Run Objective'}
        </Button>
      </Card>
    </div>
  );
}
