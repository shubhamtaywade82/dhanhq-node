import { useState, useCallback } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StratBadge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { fmt, fmtINR, pnlClass, sideClass } from '../utils/formatters';
import { Plus, Pause, Play, Square, Sliders } from 'lucide-react';
import { api } from '../services/api';
import type { Strategy } from '../store/types';

interface StrategiesProps {
  onDeploy: () => void;
}

export function Strategies({ onDeploy }: StrategiesProps) {
  const { state, showToast, openModal, closeModal, addSystemLog, refreshPortfolio } = useApp();
  const [filterSym, setFilterSym] = useState('ALL');

  const filtered = filterSym === 'ALL'
    ? state.strategies
    : state.strategies.filter((s) => s.symbol === filterSym);

  const pauseStrategy = useCallback(async (id: string) => {
    try {
      await api.updateStrategyStatus(id, 'PAUSED');
      await refreshPortfolio();
      const s = state.strategies.find((x) => x.id === id);
      addSystemLog('WARN', `Strategy ${s?.name || id} PAUSED`, 'strategy_engine');
      showToast(`${s?.name || 'Strategy'} paused`, 'warning');
    } catch (e: any) {
      showToast(`Pause failed: ${e.message}`, 'error');
    }
  }, [state.strategies, refreshPortfolio, showToast, addSystemLog]);

  const resumeStrategy = useCallback(async (id: string) => {
    try {
      await api.updateStrategyStatus(id, 'RUNNING');
      await refreshPortfolio();
      const s = state.strategies.find((x) => x.id === id);
      addSystemLog('INFO', `Strategy ${s?.name || id} RESUMED`, 'strategy_engine');
      showToast(`${s?.name || 'Strategy'} resumed`, 'success');
    } catch (e: any) {
      showToast(`Resume failed: ${e.message}`, 'error');
    }
  }, [state.strategies, refreshPortfolio, showToast, addSystemLog]);

  const executeStrategy = useCallback(async (id: string) => {
    try {
      const s = state.strategies.find((x) => x.id === id);
      showToast(`Triggering execution for ${s?.name || id}...`, 'success');
      await api.executeStrategy(id);
      await refreshPortfolio();
      addSystemLog('TRADE', `Manual AI trigger executed for strategy ${s?.name || id}`, 'agent');
    } catch (e: any) {
      showToast(`Execute failed: ${e.message}`, 'error');
    }
  }, [state.strategies, refreshPortfolio, showToast, addSystemLog]);

  const stopStrategy = useCallback((id: string) => {
    const s = state.strategies.find((x) => x.id === id);
    openModal(
      <div className="text-center">
        <div className="text-sm font-bold text-white mb-2">Stop Strategy & Exit Positions</div>
        <div className="text-xs text-muted mb-4">This will close all {s?.legs?.length ?? 0} legs at market price. Confirm?</div>
        <div className="flex gap-2 justify-center">
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button variant="danger" onClick={async () => {
            closeModal();
            try {
              await api.closeStrategy(id);
              await refreshPortfolio();
              addSystemLog('ERROR', `Strategy ${s?.name ?? id} STOPPED — positions closed`, 'strategy_engine');
              showToast('Strategy stopped and positions closed', 'error');
            } catch (e: any) {
              showToast(`Failed to close strategy: ${e.message}`, 'error');
            }
          }}>Stop & Close All</Button>
        </div>
      </div>,
    );
  }, [state.strategies, openModal, closeModal, refreshPortfolio, addSystemLog, showToast]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Strategy Orchestrator</div>
          <div className="text-xs text-muted mt-0.5">PostgreSQL-backed multi-leg automated strategies</div>
        </div>
        <div className="flex gap-2">
          <Select value={filterSym} onChange={(e) => setFilterSym(e.target.value)} className="text-xs">
            <option value="ALL">All Symbols</option>
            <option value="NIFTY">NIFTY</option>
            <option value="BANKNIFTY">BANKNIFTY</option>
            <option value="FINNIFTY">FINNIFTY</option>
            <option value="SENSEX">SENSEX</option>
            <option value="MIDCPNIFTY">MIDCPNIFTY</option>
          </Select>
          <Button onClick={onDeploy}><Plus size={14} /> Deploy Strategy</Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-8 text-center text-muted text-xs">
          No strategies currently deployed. Click "Deploy Strategy" to launch a new multi-leg position.
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((s) => (
            <StrategyCard key={s.id} strategy={s} onExecute={executeStrategy} onPause={pauseStrategy} onResume={resumeStrategy} onStop={stopStrategy} />
          ))}
        </div>
      )}
    </div>
  );
}

function StrategyCard({ strategy: s, onExecute, onPause, onResume, onStop }: { strategy: Strategy; onExecute: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void; onStop: (id: string) => void }) {
  const legs = s.legs || [];
  const netDelta = legs.reduce((t, l) => t + (l.delta || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 100, 0);
  const netTheta = legs.reduce((t, l) => t + (l.theta || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 100, 0);

  return (
    <Card className={`p-5 slide-in ${s.pnl >= 0 ? 'border-accent/20' : 'border-danger/20'}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-bold text-white">{s.name}</div>
          <div className="text-[9.5px] font-mono text-muted mt-0.5">
            {s.id} · {s.symbol} · {s.type} {s.status === 'MONITORING' ? '· 📡 Waiting for live signal' : `· Entry: ${s.entryTime}`}
          </div>
        </div>
        <StratBadge status={s.status} />
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3 bg-surface-50 p-2.5 rounded border border-border">
        <div>
          <div className="text-[9px] font-mono text-muted uppercase">P&L MTM</div>
          <div className={`text-lg font-mono font-bold ${pnlClass(s.pnl)}`}>{fmtINR(s.pnl)}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-muted uppercase">Lots / Qty</div>
          <div className="text-lg font-mono font-bold text-white">{s.lots} Lots</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-muted uppercase">Net Greeks</div>
          <div className="text-xs font-mono text-sky mt-1">Δ {netDelta.toFixed(2)} | Θ +{netTheta.toFixed(0)}</div>
        </div>
      </div>

      <div className="text-[9px] font-mono text-muted uppercase tracking-wider mb-1.5 font-semibold">Legs Breakdown</div>
      <div className="space-y-1 mb-4">
        {legs.map((l, i) => {
          const legPnl = l.pnl ?? 0;
          return (
            <div key={i} className="flex items-center justify-between text-[10px] font-mono p-1.5 rounded bg-surface-50 border border-border">
              <div className="flex items-center gap-2">
                <span className={`${sideClass(l.side)} font-bold w-9`}>{l.side}</span>
                <span className="text-white">{l.instrument}</span>
                <span className="text-muted">x{l.qty}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted">@{fmt(l.bAvg || l.sAvg)} → {fmt(l.ltp)}</span>
                <span className={`${pnlClass(legPnl)} font-semibold`}>{fmtINR(legPnl)}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        {s.status === 'MONITORING' && (
          <Button variant="primary" className="flex-1 bg-sky hover:bg-sky/80 text-black font-semibold" onClick={() => onExecute(s.id)}>
            <Play size={12} className="mr-1 fill-black" /> Execute Now (AI)
          </Button>
        )}
        {s.status === 'RUNNING' && <Button variant="ghost" className="flex-1" onClick={() => onPause(s.id)}><Pause size={12} /> Pause</Button>}
        {s.status === 'PAUSED' && <Button variant="ghost" className="flex-1 border-accent/30 text-accent" onClick={() => onResume(s.id)}><Play size={12} /> Resume</Button>}
        <Button variant="ghost" className="flex-1"><Sliders size={12} /> Adjust SL/TP</Button>
        <Button variant="danger" className="px-3.5" onClick={() => onStop(s.id)}><Square size={12} /></Button>
      </div>
    </Card>
  );
}
