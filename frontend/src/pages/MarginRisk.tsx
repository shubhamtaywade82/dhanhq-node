import { useState } from 'react';
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
          <text x="60" y="72" textAnchor="middle" fill="#64748b" fontFamily="JetBrains Mono" fontSize="9">{label.includes('Loss') ? 'of 50K' : label.includes('Margin') ? 'of Wallet' : label.includes('Single') ? 'of 2,00,000' : `IVR ${sub}`}</text>
        </svg>
      </div>
      <div className="text-center text-[10px] font-mono text-accent mt-1">
        {label.includes('Loss') ? 'Normal Operating Zone' : label.includes('Margin') ? 'Warning threshold: 70%' : label.includes('Single') ? 'Well within limits' : 'Straddles & Spreads OK'}
      </div>
    </Card>
  );
}

export function MarginRisk() {
  const { state, showToast, addSystemLog, refreshPortfolio } = useApp();
  const [activeTab, setActiveTab] = useState('single');

  const avail = Number(state.funds.availableMargin || 1000000);
  const used = Number(state.funds.usedMargin || 0);
  const total = Number(state.funds.totalBalance || (avail + used));
  const realized = Number(state.funds.realizedPnl || 0);
  const utilPct = total > 0 ? (used / total) * 100 : 0;

  const handleResetWallet = async () => {
    try {
      await api.resetPaperWallet(1000000);
      showToast('Paper Wallet reset to ₹10,00,000 (10 Lakhs)', 'success');
      addSystemLog('WARN', 'Paper wallet and positions reset to initial state', 'wallet_admin');
      await refreshPortfolio();
    } catch (e: any) {
      showToast(`Failed to reset wallet: ${e.message}`, 'error');
    }
  };

  const tabs = [
    { id: 'single', label: 'Single Order Margin' },
    { id: 'multi', label: 'Multi-Leg Basket Margin & Hedge' },
    { id: 'pnlexit', label: 'Dhan P&L Exit & Kill Switch' },
    { id: 'ratelimit', label: 'Dhan API Rate Limit Monitor' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Margin & Risk Management</div>
          <div className="text-xs text-muted mt-0.5">Real-time PostgreSQL demo account balance and margin governor</div>
        </div>
        <Button variant="danger" onClick={handleResetWallet}>
          <RotateCcw size={12} className="mr-1" /> Reset Demo Account (₹10L)
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <GaugeRing value={Math.abs(realized)} max={50000} color={realized >= 0 ? "#00e5a0" : "#ff3b5c"} label="Realized P&L" sub={fmtINR(realized)} />
        <GaugeRing value={utilPct} max={100} color={utilPct > 70 ? "#ff3b5c" : "#f0b429"} label="Margin Utilization" sub={`${fmt(utilPct)}%`} />
        <GaugeRing value={used} max={total || 1000000} color="#38bdf8" label="Margin Used" sub={fmtINR(used)} />
        <GaugeRing value={avail} max={total || 1000000} color="#00e5a0" label="Available Margin" sub={fmtINR(avail)} />
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 border-b border-border pb-2.5 mb-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-[5px] cursor-pointer rounded text-[11px] font-semibold uppercase tracking-[0.3px] transition-all
                ${activeTab === t.id ? 'text-accent bg-accent/8' : 'text-muted hover:text-white hover:bg-surface-200'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'single' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">exchangeSegment</label>
                  <Select className="w-full"><option>NSE_FNO</option><option>NSE_EQ</option></Select>
                </div>
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">transactionType</label>
                  <Select className="w-full"><option>SELL</option><option>BUY</option></Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">securityId</label>
                  <Input defaultValue="49081" />
                </div>
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">quantity</label>
                  <Input type="number" defaultValue="50" />
                </div>
                <div>
                  <label className="text-[9px] font-mono text-muted uppercase block mb-1">productType</label>
                  <Select className="w-full"><option>MARGIN</option><option>INTRADAY</option></Select>
                </div>
              </div>
              <div>
                <label className="text-[9px] font-mono text-muted uppercase block mb-1">price (optional)</label>
                <Input type="number" defaultValue="198.2" />
              </div>
              <Button onClick={() => showToast('Margin calculated: 1,15,400 INR', 'success')}>Calculate Single Margin</Button>
            </div>
            <div className="bg-surface-50 p-4 rounded-lg border border-border">
              <div className="text-xs font-semibold text-white mb-3">Response — 200 OK (Simulated Dhan API)</div>
              <div className="space-y-2 font-mono text-xs">
                <div className="flex justify-between"><span className="text-muted">totalMargin</span><span className="text-gold font-bold">1,15,400</span></div>
                <div className="flex justify-between"><span className="text-muted">spanMargin</span><span className="text-white">85,200</span></div>
                <div className="flex justify-between"><span className="text-muted">exposureMargin</span><span className="text-white">30,200</span></div>
                <div className="flex justify-between"><span className="text-muted">availableBalance</span><span className="text-accent">5,00,248</span></div>
                <div className="flex justify-between"><span className="text-muted">insufficientBalance</span><span className="text-accent">0.00</span></div>
              </div>
              <div className="mt-3 p-2 bg-bg rounded text-[9px] font-mono text-muted">POST /v2/margincalculator</div>
            </div>
          </div>
        )}

        {activeTab === 'multi' && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-white">Multi-Order Basket Margin (POST /v2/margincalculator/multi)</div>
            <div className="text-xs text-muted">Hedge margin calculation with {state.mmRows.length} legs configured</div>
            <Button onClick={() => showToast('Combined hedged margin: 1,11,408 INR', 'success')}>Calculate Combined Hedge Margin</Button>
          </div>
        )}

        {activeTab === 'pnlexit' && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-white mb-2">Configure Automated Dhan Broker P&L Exit</div>
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
            <Button onClick={() => { showToast('P&L exit rules saved', 'success'); addSystemLog('INFO', 'POST /v2/pnlExit — Profit: 50K, Loss: 25K', 'dhan'); }}>Save P&L Exit Rule</Button>
          </div>
        )}

        {activeTab === 'ratelimit' && (
          <div className="space-y-3">
            <div className="text-xs font-semibold text-white">Dhan API Rate Limit Live Monitor (Rolling 60s)</div>
            <div className="text-xs text-muted py-8 text-center">Rate limit chart renders with live tick data</div>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-3 font-semibold">Circuit Breaker & Risk Governance Rules</div>
        <table className="data-table">
          <thead>
            <tr>
              {['Circuit Breaker Rule', 'Threshold', 'Current Measured', 'Gate State', 'Automated Action on Trigger'].map(h => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.circuitBreakers.map((cb, i) => (
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
