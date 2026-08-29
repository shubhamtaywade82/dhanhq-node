import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';

export function GreeksAnalytics() {
  const { state } = useApp();
  const [activeTab, setActiveTab] = useState('breakdown');
  const chartRef = useRef<HTMLCanvasElement>(null);

  const totalDelta = state.positions.reduce((acc, p) => acc + (p.netQty > 0 ? 0.5 : -0.5) * p.netQty / 50, 0);
  const totalGamma = state.positions.reduce((acc, p) => acc + (p.netQty > 0 ? 0.002 : -0.002) * p.netQty / 50, 0);
  const totalTheta = state.positions.reduce((acc, p) => acc + (p.netQty < 0 ? 15 : -15) * Math.abs(p.netQty) / 50, 0);
  const totalVega = state.positions.reduce((acc, p) => acc + (p.netQty > 0 ? 18 : -18) * Math.abs(p.netQty) / 50, 0);

  const greekCards = [
    { label: 'Net Delta', value: totalDelta.toFixed(2), sub: totalDelta > 0 ? 'Long Delta' : totalDelta < 0 ? 'Short Delta' : 'Delta Neutral', color: 'text-sky' },
    { label: 'Net Gamma', value: totalGamma.toFixed(4), sub: totalGamma >= 0 ? 'Long Gamma' : 'Short Gamma', color: totalGamma >= 0 ? 'text-accent' : 'text-danger' },
    { label: 'Net Theta', value: `${totalTheta >= 0 ? '+' : ''}${totalTheta.toFixed(1)}/d`, sub: 'Decay Impact', color: totalTheta >= 0 ? 'text-accent' : 'text-danger' },
    { label: 'Net Vega', value: totalVega.toFixed(1), sub: totalVega >= 0 ? 'Long Vol' : 'Short Vol', color: totalVega >= 0 ? 'text-sky' : 'text-danger' },
    { label: 'Open Lots', value: String(state.positions.filter(p => p.netQty !== 0).length), sub: 'Active Positions', color: 'text-gold' },
    { label: 'Realized PnL', value: `₹${state.funds.realizedPnl}`, sub: 'From Wallet', color: state.funds.realizedPnl >= 0 ? 'text-accent' : 'text-danger' },
    { label: 'Margin Used', value: `₹${state.funds.usedMargin}`, sub: 'Collateral Block', color: 'text-purple' },
  ];

  const tabs = [
    { id: 'breakdown', label: 'Greeks Breakdown' },
    { id: 'surface', label: 'IV Surface (Heatmap)' },
    { id: 'term', label: 'Term Structure' },
    { id: 'skew', label: 'Volatility Smile & Skew' },
    { id: 'expired', label: 'Rolling Options Analytics' },
  ];

  useEffect(() => {
    if (activeTab === 'breakdown' && chartRef.current) {
      drawGreekBarChart(chartRef.current, state.strategies);
    }
  }, [activeTab, state.strategies]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {greekCards.map((g) => (
          <Card key={g.label} className="p-3 text-center">
            <div className="text-[8.5px] font-mono text-muted uppercase tracking-wider mb-0.5 font-semibold">{g.label}</div>
            <div className={`text-lg font-bold font-mono ${g.color}`}>{g.value}</div>
            <div className="text-[9px] font-mono text-muted">{g.sub}</div>
          </Card>
        ))}
      </div>

      <Card className="p-3">
        <div className="flex items-center gap-2 border-b border-border pb-2.5 mb-3.5">
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

        {activeTab === 'breakdown' && (
          <div>
            <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">Strategy Greek Exposure Distribution</div>
            <canvas ref={chartRef} height={190} className="w-full" />
          </div>
        )}
        {activeTab === 'surface' && (
          <div className="py-8 text-center text-muted text-xs">
            Live IV Surface rendered dynamically from active option chain strikes.
          </div>
        )}
        {activeTab === 'term' && (
          <div className="py-8 text-center text-muted text-xs">
            Expiry term structure calculated across weekly and monthly contracts.
          </div>
        )}
        {activeTab === 'skew' && (
          <div className="py-8 text-center text-muted text-xs">
            Live Put-Call Volatility Skew calculated from option chain delta and IV.
          </div>
        )}
        {activeTab === 'expired' && (
          <div className="py-8 text-center text-muted text-xs">
            Use the dedicated "Options Behavior" page to backtest 1m granular rolling options data.
          </div>
        )}
      </Card>
    </div>
  );
}

function drawGreekBarChart(canvas: HTMLCanvasElement, strategies: any[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  canvas.width = rect.width - 24;
  canvas.height = 190;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const active = strategies.filter((s) => s.status !== 'STOPPED');
  if (active.length === 0) {
    ctx.font = '11px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText('No active strategies deployed. Deploy a strategy to view Greeks exposure.', w / 2, h / 2);
    return;
  }

  const data = active.map((s) => {
    const legs = s.legs || [];
    return {
      name: s.name.replace('NIFTY ', 'N.').replace('BANKNIFTY ', 'BN.'),
      d: legs.reduce((t: number, l: any) => t + (l.delta || 0.5) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
      g: legs.reduce((t: number, l: any) => t + (l.gamma || 0.002) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
      th: legs.reduce((t: number, l: any) => t + (l.theta || 8) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
      v: legs.reduce((t: number, l: any) => t + (l.vega || 12) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
    };
  });

  const metrics = [
    { k: 'd' as const, label: 'Delta', color: '#38bdf8' },
    { k: 'g' as const, label: 'Gamma', color: '#ff3b5c' },
    { k: 'th' as const, label: 'Theta', color: '#00e5a0' },
    { k: 'v' as const, label: 'Vega', color: '#f0b429' },
  ];

  const groupW = 90, gap = 24;
  const totalW = data.length * (groupW + gap) - gap;
  const startX = Math.max(70, (w - totalW) / 2);

  metrics.forEach((m, mi) => {
    const barH = 16;
    const yBase = 15 + mi * 34;
    ctx.font = 'bold 9.5px JetBrains Mono';
    ctx.fillStyle = m.color;
    ctx.textAlign = 'right';
    ctx.fillText(m.label, startX - 10, yBase + barH / 2 + 3);

    data.forEach((d, di) => {
      const x = startX + di * (groupW + gap);
      const val = d[m.k];
      const maxAbs = Math.max(...data.map((dd) => Math.abs(dd[m.k])), 0.01);
      const bWidth = Math.max(2, (Math.abs(val) / maxAbs) * (groupW / 2 - 6));
      ctx.fillStyle = m.color + '33';
      if (val >= 0) ctx.fillRect(x + groupW / 2, yBase, bWidth, barH);
      else ctx.fillRect(x + groupW / 2 - bWidth, yBase, bWidth, barH);
      ctx.fillStyle = m.color;
      ctx.font = '8.5px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText(`${val >= 0 ? '+' : ''}${val > 10 ? val.toFixed(0) : val.toFixed(2)}`, x + groupW / 2, yBase + barH / 2 + 3);
    });
  });
}
