import { useEffect, useState, useCallback } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { StatusDot } from '../components/ui/StatusDot';
import { Plug, Shield, Brain, Code, Power, TrendingUp } from 'lucide-react';
import { api } from '../services/api';

/**
 * Configuration & governance — REAL system state from the backend.
 *
 * - Stack metadata: live version info from /api/control/state
 * - Risk limits: read + persisted via the risk engine (backend-enforced)
 * - Broker connection test: actual DhanHQ profile call
 * - Autonomy: start/stop the backend autonomous loop
 */
export function Config() {
  const { showToast, addSystemLog, refreshControlState, state } = useApp();
  const [meta, setMeta] = useState<any>(null);
  const [limits, setLimits] = useState<any>({ dailyLossLimit: 50000, maxMarginUtilPct: 70, perStrategyLossLimit: 20000, maxConsecutiveLosses: 5 });
  const [ollama, setOllama] = useState<{ status: string; error?: string } | null>(null);
  const [brokerStatus, setBrokerStatus] = useState<string>('');
  const [autonomyOn, setAutonomyOn] = useState<boolean | null>(null);
  const [longOptionPolicyOn, setLongOptionPolicyOn] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const ctrl = await api.controlState();
      setMeta(ctrl);
      setAutonomyOn(!!ctrl.autonomy?.enabled);
      setLongOptionPolicyOn(!!ctrl.autonomy?.longOptionPolicyEnabled);
      const lim = ctrl.risk?.limits || {};
      setLimits((prev: any) => ({ ...prev, ...lim }));
    } catch (e: any) {
      setBrokerStatus(`Backend unreachable: ${e.message}`);
    }
    try {
      setOllama(await api.ollamaHealth());
    } catch { setOllama({ status: 'unreachable' }); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testBroker = async () => {
    setBrokerStatus('Testing…');
    try {
      const profile = await api.profile();
      const name = (profile as any)?.name || (profile as any)?.dhanClientId || 'authenticated';
      setBrokerStatus(`PASS — DhanHQ authenticated (${name})`);
      showToast(`Broker connection OK (${name})`, 'success');
      addSystemLog('INFO', 'Broker connection verified against DhanHQ profile API', 'broker');
    } catch (e: any) {
      setBrokerStatus(`FAIL — ${e.message}`);
      showToast('Broker connection failed — check credentials', 'error');
      addSystemLog('ERROR', `Broker connection failed: ${e.message}`, 'broker');
    }
  };

  const saveRisk = async () => {
    try {
      const saved = await api.setRiskLimits({
        dailyLossLimit: Number(limits.dailyLossLimit),
        maxMarginUtilPct: Number(limits.maxMarginUtilPct),
        perStrategyLossLimit: Number(limits.perStrategyLossLimit),
        maxConsecutiveLosses: Number(limits.maxConsecutiveLosses),
      });
      showToast('Risk limits saved — enforced by the backend risk engine', 'success');
      addSystemLog('INFO', `Risk limits updated: ${JSON.stringify(saved)}`, 'risk_engine');
      await refreshControlState();
    } catch (e: any) {
      showToast(`Save failed: ${e.message}`, 'error');
    }
  };

  const toggleAutonomy = async (on: boolean) => {
    try {
      await api.setAutonomy(on);
      setAutonomyOn(on);
      showToast(`Autonomy engine ${on ? 'resumed' : 'paused'}`, on ? 'success' : 'warning');
      addSystemLog('WARN', `Autonomy engine ${on ? 'resumed' : 'paused'} from control plane`, 'autonomy');
      await refreshControlState();
    } catch (e: any) {
      showToast(`Failed: ${e.message}`, 'error');
    }
  };

  const toggleLongOptionPolicy = async (on: boolean) => {
    try {
      await api.setLongOptionPolicy(on);
      setLongOptionPolicyOn(on);
      showToast(`Long-option peak-profit policy ${on ? 'enabled' : 'disabled'}`, on ? 'success' : 'warning');
      addSystemLog('WARN', `Long-option peak-profit policy ${on ? 'enabled' : 'disabled'} from control plane`, 'long_option_policy');
      await refreshControlState();
    } catch (e: any) {
      showToast(`Failed: ${e.message}`, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">System Configuration & Governance</div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><Plug size={14} className="text-accent" /> Broker & DhanHQ Connection</div>
          <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
            <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">Trading Mode</span><span className="text-white font-bold">{meta?.mode || '…'}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">Persistence</span><span className="text-white">{meta ? (meta.risk ? 'postgres' : '—') : '…'}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">Market Source</span><span className="text-accent">{meta?.market?.source || '…'}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">Tracked Instruments</span><span className="text-white">{meta?.market?.trackedInstruments ?? '—'}</span></div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={testBroker}>Test Broker Connection</Button>
            {brokerStatus && <span className={`text-[10px] font-mono ${brokerStatus.startsWith('PASS') ? 'text-accent' : brokerStatus.startsWith('Testing') ? 'text-muted' : 'text-danger'}`}>{brokerStatus}</span>}
          </div>
          <div className="text-[9.5px] font-mono text-muted">
            Credentials are held by the backend only (env / TOTP / token authority) — never in this UI.
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><Power size={14} className={autonomyOn ? 'text-accent' : 'text-danger'} /> Autonomy Engine</div>
          <div className="flex items-center justify-between p-2.5 rounded bg-surface-50 border border-border">
            <div className="flex items-center gap-2">
              <StatusDot status={autonomyOn ? 'live' : 'idle'} pulse={!!autonomyOn} />
              <span className="text-xs font-mono text-white">{autonomyOn ? 'RUNNING' : 'PAUSED'}</span>
            </div>
            <div className="text-[9.5px] font-mono text-muted">
              {meta?.autonomy ? `cycles: ${meta.autonomy.cycles} · eod: ${meta.autonomy.eodDone ? 'done' : 'pending'}` : ''}
            </div>
            <Button variant={autonomyOn ? 'ghost' : 'primary'} className="text-[11px] py-1" onClick={() => toggleAutonomy(!autonomyOn)}>
              {autonomyOn ? 'Pause' : 'Resume'}
            </Button>
          </div>
          <div className="text-[9.5px] font-mono text-muted">
            The autonomous loop (mark-to-market, exit signals, strategy guardrails, EOD square-off) runs on the backend
            whether or not this UI is open. This switch only gates it.
          </div>
          <div className="text-[9.5px] font-mono text-muted">
            Kill switch: {state.killed ? <span className="text-danger font-bold">ENGAGED — trading halted</span> : <span className="text-accent">disarmed</span>}
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><TrendingUp size={14} className={longOptionPolicyOn ? 'text-accent' : 'text-danger'} /> Long-Option Peak-Profit Policy</div>
          <div className="flex items-center justify-between p-2.5 rounded bg-surface-50 border border-border">
            <div className="flex items-center gap-2">
              <StatusDot status={longOptionPolicyOn ? 'live' : 'idle'} pulse={!!longOptionPolicyOn} />
              <span className="text-xs font-mono text-white">{longOptionPolicyOn ? 'ACTIVE' : 'DISABLED'}</span>
            </div>
            <Button variant={longOptionPolicyOn ? 'ghost' : 'primary'} className="text-[11px] py-1" onClick={() => toggleLongOptionPolicy(!longOptionPolicyOn)}>
              {longOptionPolicyOn ? 'Disable' : 'Enable'}
            </Button>
          </div>
          <div className="text-[9.5px] font-mono text-muted">
            Runs every tick against every open long-option paper position: ratchets a profit floor as peak P&amp;L rises,
            takes a breakeven partial at +0.5R, and force-flattens by EOD — the goal is capturing gains, not giving them
            back. Per-position peak/floor detail is on the Positions page.
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><Shield size={14} className="text-gold" /> Risk Engine Limits (backend-enforced)</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">daily_loss_limit (INR)</label>
              <Input type="number" value={limits.dailyLossLimit} onChange={(e) => setLimits((p: any) => ({ ...p, dailyLossLimit: e.target.value }))} />
            </div>
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">max_margin_pct (%)</label>
              <Input type="number" value={limits.maxMarginUtilPct} onChange={(e) => setLimits((p: any) => ({ ...p, maxMarginUtilPct: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">per_strategy_limit (INR)</label>
              <Input type="number" value={limits.perStrategyLossLimit} onChange={(e) => setLimits((p: any) => ({ ...p, perStrategyLossLimit: e.target.value }))} />
            </div>
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">max_consecutive_losses</label>
              <Input type="number" value={limits.maxConsecutiveLosses} onChange={(e) => setLimits((p: any) => ({ ...p, maxConsecutiveLosses: e.target.value }))} />
            </div>
          </div>
          <Button onClick={saveRisk}>Save Risk Config</Button>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><Brain size={14} className="text-purple" /> Agent LLM & Guardrails</div>
          <div className="space-y-1.5 text-[11px] font-mono">
            <div className="flex justify-between border-b border-border/50 pb-1.5">
              <span className="text-muted">Ollama</span>
              <span className={ollama?.status === 'ok' ? 'text-accent' : 'text-gold'}>{ollama?.status === 'ok' ? 'ONLINE' : 'UNREACHABLE (deterministic mode)'}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 pb-1.5">
              <span className="text-muted">Agent Mode</span>
              <span className="text-white">{meta?.agent?.llm === 'ollama' ? 'LLM reasoning + real tools' : 'deterministic + real tools'}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 pb-1.5">
              <span className="text-muted">Tool Policy</span>
              <span className="text-white">SDK Policy.fromEnv() — writes double-gated</span>
            </div>
          </div>
          {ollama?.status !== 'ok' && (
            <div className="text-[9.5px] font-mono text-muted">
              Start Ollama (<code>ollama serve</code>) to enable LLM reasoning. Agent runs still execute with real DhanHQ
              tools in deterministic mode — never fabricated output.
            </div>
          )}
        </Card>

        <Card className="p-4 space-y-2.5 font-mono text-xs lg:col-span-2">
          <div className="text-xs font-semibold text-white mb-2 flex items-center gap-2"><Code size={14} className="text-sky" /> Stack Version Metadata (live)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1.5">
            <div className="flex justify-between border-b border-border/40 pb-1"><span className="text-muted">Node.js</span><span className="text-white">{meta?.version?.node || '—'}</span></div>
            <div className="flex justify-between border-b border-border/40 pb-1"><span className="text-muted">dhanhq-sdk</span><span className="text-accent">{meta?.version?.sdk || '—'}</span></div>
            <div className="flex justify-between border-b border-border/40 pb-1"><span className="text-muted">Sidecar App</span><span className="text-white">{meta?.version?.app || '—'}</span></div>
            <div className="flex justify-between border-b border-border/40 pb-1"><span className="text-muted">Persistence</span><span className="text-white">{meta ? 'postgres / memory' : '—'}</span></div>
          </div>
          <div className="text-[9.5px] text-muted pt-1">
            Note: this is the Node.js execution sidecar (Express + ws + dhanhq-sdk). Rails/Sidekiq metadata was removed — it never ran here.
          </div>
        </Card>
      </div>
    </div>
  );
}
