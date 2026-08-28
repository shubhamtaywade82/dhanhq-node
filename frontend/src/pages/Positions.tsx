import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { fmt, fmtINR, pnlClass, sideClass } from '../utils/formatters';
import { RotateCcw, Power } from 'lucide-react';

export function Positions() {
  const { state, showToast, openModal, closeModal, addSystemLog, setState } = useApp();

  const allLegs = state.strategies.filter(s => s.status !== 'STOPPED').flatMap(s =>
    s.legs.map(l => ({
      strategy: s.name,
      instrument: l.instrument,
      side: l.side,
      qty: l.qty,
      bAvg: l.bAvg,
      sAvg: l.sAvg,
      ltp: l.ltp,
      pnl: (l.ltp - (l.bAvg || l.sAvg || l.ltp)) * l.qty * (l.side === 'SELL' ? -1 : 1),
      delta: (l.delta * (l.side === 'SELL' ? -1 : 1) * l.qty / 100).toFixed(2),
      theta: (l.theta * (l.side === 'SELL' ? -1 : 1) * l.qty / 100).toFixed(0),
    }))
  );

  const reconcile = () => {
    showToast('PositionReconcileWorker enqueued to Sidekiq...', 'success');
    addSystemLog('INFO', 'PositionReconcileWorker comparing local PostgreSQL positions vs GET /v2/positions', 'sidekiq');
    setTimeout(() => {
      addSystemLog('INFO', 'Reconciliation complete: Local=8 legs, Dhan=8 legs, delta=0. MATCH VERIFIED.', 'reconciliation');
      showToast('Reconciliation PASS: Local state matches broker exactly', 'success');
    }, 1200);
  };

  const closeAll = () => {
    openModal(
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-3 text-danger text-xl">
          <Power size={20} />
        </div>
        <div className="text-base font-bold text-danger mb-1">Close All Positions (Emergency Flush)</div>
        <div className="text-xs text-muted mb-4">This will immediately send market orders to close ALL open legs across all strategies.</div>
        <div className="flex gap-2 justify-center">
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            setState(prev => ({
              ...prev,
              strategies: prev.strategies.map(s => s.status !== 'STOPPED' ? { ...s, status: 'STOPPED' as const, pnl: 0 } : s),
            }));
            closeModal();
            addSystemLog('ERROR', 'ALL POSITIONS CLOSED via CloseAllPositionsWorker', 'risk_engine');
            showToast('All open positions flushed and closed', 'error');
          }}>Close All Now</Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Active Positions & MTM</div>
          <div className="text-xs text-muted mt-0.5">ActiveRecord optimistic locking with real-time Greek sensitivities</div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={reconcile}><RotateCcw size={12} className="mr-1" /> Reconcile with Broker</Button>
          <Button variant="danger" onClick={closeAll}><Power size={12} className="mr-1" /> Close All Positions</Button>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              {['Strategy', 'Instrument', 'Side', 'Qty', 'Buy Avg', 'Sell Avg', 'LTP', 'Unrealized P&L', 'Delta', 'Theta', 'Product', 'Actions'].map(h => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {allLegs.map((p, i) => (
              <tr key={i} className="hover:bg-surface-200/50">
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[10px]">{p.strategy}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">{p.instrument}</td>
                <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold ${sideClass(p.side)}`}>{p.side}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{p.qty}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{p.bAvg ? fmt(p.bAvg) : '-'}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{p.sAvg ? fmt(p.sAvg) : '-'}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">{fmt(p.ltp)}</td>
                <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold ${pnlClass(p.pnl)}`}>{fmtINR(p.pnl)}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-sky">{p.delta}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-accent">{p.theta}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">MARGIN</td>
                <td className="px-2.5 py-[7px] border-b border-border/60">
                  <Button variant="ghost" className="text-[9px] px-2 py-0.5" onClick={() => showToast(`Close order sent for ${p.instrument}`, 'warning')}>Close</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
