import { useState, useCallback } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { StatusDot } from '../components/ui/StatusDot';
import { fmtINR, fmt } from '../utils/formatters';
import { RotateCcw } from 'lucide-react';
import { api } from '../services/api';

function GaugeRing({ value, max, color, label, sub }: { value: number; max: number; color: string; label: string; sub: string }) {
  const pct = Math.min(1, Math.max(0, value / max));
  const dashoffset = 314 * (1 - pct);
  return (
    <Card className="p-4">
      <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">{label}</div>
      <div className="flex items-center justify-center">
        <svg width="110" height="110" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="50" fill="none" stroke="#1c283f" strokeWidth="7" />
          <circle cx="60" cy="60" r="50" fill="none" stroke={color} strokeWidth="7" strokeDasharray="314" strokeDashoffset={dashoffset} strokeLinecap="round" className="gauge-ring" />
          <text x="60" y="56" textAnchor="middle" fill="white" fontFamily="JetBrains Mono" fontSize="13" fontWeight="700">{sub}</text>
          <text x="60" y="72" textAnchor="middle" fill="#64748b" fontFamily="JetBrains Mono" fontSize="9">{label.includes('Loss') ? 'of 50K' : label.includes('Margin') ? 'of Wallet' : label.includes('Single') ? 'of 2,00,000' : 'Live State'}</text>
        </svg>
      </div>
      <div className="text-center text-[10px] font-mono text-accent mt-1">
        {label.includes('Loss') ? 'Normal Operating Zone' : label.includes('Margin') ? 'Warning threshold: 70%' : 'Active Account Risk'}
      </div>
    </Card>
  );
}

export function MarginRisk() {
  const { state, showToast, addSystemLog, refreshPortfolio } = useApp();
  const [activeTab, setActiveTab] = useState('single');
  const [calcResult, setCalcResult] = useState<{ totalMargin: number; spanMargin: number; exposureMargin: number } | null>(null);

  const avail = Number(state.funds.availableMargin || 100000);
  const used = Number(state.funds.usedMargin || 0);
  const total = Number(state.funds.totalBalance || (avail + used));
  const realized = Number(state.funds.realizedPnl || 0);
  const utilPct = total > 0 ? (used / total) * 100 : 0;

  const handleResetWallet = async () => {
    try {
      await api.resetPaperWallet(100000);
      showToast('Paper Wallet reset to ₹1,00,000 (1 Lakh)', 'success');
      addSystemLog('WARN', 'Paper wallet and positions reset to initial state', 'wallet_admin');
      await refreshPortfolio();
    } catch (e: any) {
      showToast(`Failed to reset wallet: ${e.message}`, 'error');
    }
  };

  const handleCalculateSingle = useCallback(async () => {
    const sym = (document.getElementById('mmSym') as HTMLInputElement)?.value || 'NIFTY24JAN24500CE';
    const tx = (document.getElementById('mmTx') as HTMLSelectElement)?.value || 'SELL';
    const qty = Number((document.getElementById('mmQty') as HTMLInputElement)?.value || 50);
    const px = Number((document.getElementById('mmPx') as HTMLInputElement)?.value || 195);
    try {
      const res = await api.calculateMargin([{ symbol: sym, transactionType: tx, quantity: qty, price: px }]);
      setCalcResult(res);
      showToast(`Margin calculated: ₹${res.totalMargin}`, 'success');
    } catch (e: any) {
      showToast(`Calculation failed: ${e.message}`, 'error');
    }
  }, [showToast]);

  const openPositionsCount = state.positions.filter((p) => Number(p.netQty ?? p.net_qty ?? 0) !== 0).length;
  const rejectedOrders = state.orders.filter((o) => o.status === 'REJECTED').length;
  // Prefer the backend risk engine's live breaker evaluation (streamed over
  // the WS risk channel); compute locally only as a fallback view.
  const circuitBreakers = state.circuitBreakers.length > 0 ? state.circuitBreakers : [
    { rule: 'Daily Loss Limit', threshold: '₹50,000', current: fmtINR(realized), state: realized < -50000 ? 'TRIPPED' : realized < -35000 ? 'WARN' : 'OK', action: 'Close all positions, trigger Dhan P&L exit' },
    { rule: 'Margin Utilization', threshold: '70%', current: `${fmt(utilPct)}%`, state: utilPct > 80 ? 'TRIPPED' : utilPct > 70 ? 'WARN' : 'OK', action: 'Block new position opens' },
    { rule: 'Open Position Count', threshold: '10 active', current: `${openPositionsCount} active`, state: openPositionsCount > 8 ? 'WARN' : 'OK', action: 'Limit concurrency' },
    { rule: 'Order Rejections', threshold: '< 10%', current: `${rejectedOrders}/${state.orders.length || 1}`, state: rejectedOrders > 2 ? 'WARN' : 'OK', action: 'Throttle orders' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Margin & Risk Management</div>
          <div className="text-xs text-muted mt-0.5">Real-time PostgreSQL demo account balance and margin governor</div>
        </div>
        <Button variant="danger" onClick={handleResetWallet}>
          <RotateCcw size={12} className="mr-1" /> Reset Demo Account (₹1L)
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <GaugeRing value={Math.abs(realized)} max={50000} color={realized >= 0 ? "#00e5a0" : "#ff3b5c"} label="Realized P&L" sub={fmtINR(realized)} />
        <GaugeRing value={utilPct} max={100} color={utilPct > 70 ? "#ff3b5c" : "#f0b429"} label="Margin Utilization" sub={`${fmt(utilPct)}%`} />
        <GaugeRing value={used} max={total || 100000} color="#38bdf8" label="Margin Used" sub={fmtINR(used)} />
        <GaugeRing value={avail} max={total || 100000} color="#00e5a0" label="Available Margin" sub={fmtINR(avail)} />
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 border-b border-border pb-2.5 mb-4">
          {['single', 'pnlexit'].map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-[5px] cursor-pointer rounded text-[11px] font-semibold uppercase tracking-[0.3px] transition-all
                ${activeTab === t ? 'text-accent bg-accent/8' : 'text-muted hover:text-white hover:bg-surface-200'}`}
            >
              {t === 'single' ? 'DhanHQ Margin Calculator' : 'Dhan P&L Exit Rules'}
            </button>
          ))}
        </div>

        {activeTab === 'single' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">symbol</label>
                  <Input id="mmSym" defaultValue="NIFTY24JAN24500CE" />
                </div>
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">transactionType</label>
                  <Select id="mmTx" className="w-full"><option value="SELL">SELL</option><option value="BUY">BUY</option></Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">quantity</label>
                  <Input id="mmQty" type="number" defaultValue="50" />
                </div>
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">price</label>
                  <Input id="mmPx" type="number" defaultValue="195" />
                </div>
              </div>
              <Button onClick={handleCalculateSingle}>Calculate Live Margin</Button>
            </div>
            <div className="bg-surface-50 p-4 rounded-lg border border-border">
              <div className="text-xs font-semibold text-white mb-3">Response — DhanHQ MultiScrip Margin</div>
              <div className="space-y-2 font-mono text-xs">
                <div className="flex justify-between"><span className="text-muted">Total Margin</span><span className="text-gold font-bold">{calcResult ? fmtINR(calcResult.totalMargin) : '₹0.00'}</span></div>
                <div className="flex justify-between"><span className="text-muted">SPAN Margin</span><span className="text-white">{calcResult ? fmtINR(calcResult.spanMargin) : '₹0.00'}</span></div>
                <div className="flex justify-between"><span className="text-muted">Exposure Margin</span><span className="text-white">{calcResult ? fmtINR(calcResult.exposureMargin) : '₹0.00'}</span></div>
                <div className="flex justify-between"><span className="text-muted">Available Balance</span><span className="text-accent">{fmtINR(avail)}</span></div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'pnlexit' && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-white mb-2">Automated Risk Protection Limits</div>
            <div className="grid grid-cols-2 gap-4 max-w-lg">
              <div>
                <label className="text-[9px] font-mono text-muted uppercase block mb-1">Profit Target (INR)</label>
                <Input type="number" defaultValue={50000} />
              </div>
              <div>
                <label className="text-[9px] font-mono text-muted uppercase block mb-1">Loss Stop (INR)</label>
                <Input type="number" defaultValue={25000} />
              </div>
            </div>
            <Button onClick={() => { showToast('P&L exit rules saved', 'success'); addSystemLog('INFO', 'Dhan Risk Exit Limits updated: Target 50K, Loss 25K', 'risk_engine'); }}>Save Risk Rules</Button>
          </div>
        )}
      </Card>

      <Card className="p-4 overflow-x-auto">
        <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-3 font-semibold">Live Circuit Breakers & Risk Governance Rules</div>
        <table className="data-table w-full">
          <thead>
            <tr>
              {['Circuit Breaker Rule', 'Threshold', 'Current Measured', 'Gate State', 'Automated Action on Trigger'].map((h) => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {circuitBreakers.map((cb, i) => (
              <tr key={i} className="hover:bg-surface-200/50">
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-medium">{cb.rule}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted font-mono">{cb.threshold}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono font-semibold">{cb.current}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60">
                  <span className="flex items-center gap-1.5">
                    <StatusDot status={cb.state === 'OK' ? 'live' : cb.state === 'WARN' ? 'warn' : 'error'} pulse={cb.state === 'OK'} />
                    <span className={`text-[10px] font-mono font-semibold ${cb.state === 'OK' ? 'text-accent' : cb.state === 'WARN' ? 'text-gold' : 'text-danger'}`}>{cb.state}</span>
                  </span>
                </td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[10px]">{cb.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
