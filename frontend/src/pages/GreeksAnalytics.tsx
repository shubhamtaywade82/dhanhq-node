import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';

export function GreeksAnalytics() {
  const { state } = useApp();
  const [activeTab, setActiveTab] = useState('breakdown');
  const chartRef = useRef<HTMLCanvasElement>(null);

  const greekCards = [
    { label: 'Net Delta', value: '+0.03', sub: 'Neutral', color: 'text-sky' },
    { label: 'Net Gamma', value: '-2.14', sub: 'Short Gamma', color: 'text-danger' },
    { label: 'Net Theta', value: '+845/d', sub: 'Decay Income', color: 'text-accent' },
    { label: 'Net Vega', value: '-18.7', sub: 'Short Vol', color: 'text-danger' },
    { label: 'Vanna', value: '-0.42', sub: 'dDelta/dVol', color: 'text-purple' },
    { label: 'Charm', value: '+0.18', sub: 'dDelta/dTime', color: 'text-gold' },
    { label: 'Volga', value: '+0.09', sub: 'dVega/dVol', color: 'text-sky' },
  ];

  const tabs = [
    { id: 'breakdown', label: 'Greeks Breakdown' },
    { id: 'surface', label: 'IV Surface (Heatmap)' },
    { id: 'term', label: 'Term Structure' },
    { id: 'skew', label: 'Volatility Smile & Skew' },
    { id: 'expired', label: '5-Year Expired Rolling IV' },
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
            <div className={`text-[9px] font-mono ${g.sub.includes('Short') ? 'text-danger' : 'text-muted'}`}>{g.sub}</div>
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
          <div>
            <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">Implied Volatility Surface</div>
            <div className="text-xs text-muted py-8 text-center">IV Surface heatmap renders with real Dhan option chain data</div>
          </div>
        )}
        {activeTab === 'term' && (
          <div>
            <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">Expiry Term Structure (W1 to M3)</div>
            <div className="text-xs text-muted py-8 text-center">Term structure chart renders with real IV data</div>
          </div>
        )}
        {activeTab === 'skew' && (
          <div>
            <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">CE vs PE Skew Comparison</div>
            <div className="text-xs text-muted py-8 text-center">Skew comparison renders with real IV data</div>
          </div>
        )}
        {activeTab === 'expired' && (
          <div>
            <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">Historical ATM IV Rolling Curve</div>
            <div className="text-xs text-muted py-8 text-center">Rolling IV chart renders with Dhan /v2/charts/rollingoption data</div>
          </div>
        )}
      </Card>
    </div>
  );
}

function drawGreekBarChart(canvas: HTMLCanvasElement, strategies: { name: string; legs: { delta: number; gamma: number; theta: number; vega: number; side: string; qty: number }[]; status: string }[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  canvas.width = rect.width - 24;
  canvas.height = 190;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const data = strategies.filter(s => s.status !== 'STOPPED').map(s => ({
    name: s.name.replace('NIFTY ', 'N.').replace('BANKNIFTY ', 'BN.'),
    d: s.legs.reduce((t, l) => t + l.delta * (l.side === 'SELL' ? -1 : 1) * l.qty / 100, 0),
    g: s.legs.reduce((t, l) => t + l.gamma * (l.side === 'SELL' ? -1 : 1) * l.qty / 100, 0),
    th: s.legs.reduce((t, l) => t + l.theta * (l.side === 'SELL' ? -1 : 1) * l.qty / 100, 0),
    v: s.legs.reduce((t, l) => t + l.vega * (l.side === 'SELL' ? -1 : 1) * l.qty / 100, 0),
  }));

  const metrics = [
    { k: 'd' as const, label: 'Delta', color: '#38bdf8' },
    { k: 'g' as const, label: 'Gamma', color: '#ff3b5c' },
    { k: 'th' as const, label: 'Theta', color: '#00e5a0' },
    { k: 'v' as const, label: 'Vega', color: '#f0b429' },
  ];

  const groupW = 90;
  const gap = 24;
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
      const maxAbs = Math.max(...data.map(dd => Math.abs(dd[m.k])), 0.01);
      const bWidth = Math.max(2, (Math.abs(val) / maxAbs) * (groupW / 2 - 6));
      ctx.fillStyle = m.color + '33';
      if (val >= 0) {
        ctx.fillRect(x + groupW / 2, yBase, bWidth, barH);
      } else {
        ctx.fillRect(x + groupW / 2 - bWidth, yBase, bWidth, barH);
      }
      ctx.fillStyle = m.color;
      ctx.font = '8.5px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText(`${val >= 0 ? '+' : ''}${val > 10 ? val.toFixed(0) : val.toFixed(2)}`, x + groupW / 2, yBase + barH / 2 + 3);
    });
  });

  data.forEach((d, di) => {
    const x = startX + di * (groupW + gap) + groupW / 2;
    ctx.font = '9px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(d.name, x, h - 6);
  });
}
