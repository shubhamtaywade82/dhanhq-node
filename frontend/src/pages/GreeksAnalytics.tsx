import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { api } from '../services/api';

/**
 * Greeks & volatility analytics.
 *
 * Portfolio Greeks are aggregated from the BACKEND's Black-Scholes
 * computation (/api/market/greeks — live option chain + spot). When the
 * backend cannot compute (no live chain data) the cards show an explicit
 * "unavailable" state instead of fabricated numbers.
 */
export function GreeksAnalytics() {
  const { state } = useApp();
  const [activeTab, setActiveTab] = useState('breakdown');
  const chartRef = useRef<HTMLCanvasElement>(null);
  const [greeks, setGreeks] = useState<{ symbol: string; spot: number; expiry: string; strikes: Array<{ strike: number; ce: any; pe: any }> } | null>(null);
  const [greeksError, setGreeksError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const g = await api.greeks('NIFTY');
        if (!alive) return;
        setGreeks(g);
        setGreeksError(null);
      } catch (e: any) {
        if (alive) setGreeksError(e.message);
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  // Portfolio-level Greeks: prefer live chain greeks; fall back to the
  // strategy leg deltas the backend recorded at deploy time. No constants.
  const legGreeks = state.strategies.flatMap((s) => (s.legs || []).map((l: any) => ({ ...l, side: l.side })));
  const hasLegGreeks = legGreeks.some((l) => typeof l.delta === 'number');

  const totalDelta = legGreeks.reduce((acc, l) => acc + (Number(l.delta) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0);
  const totalGamma = legGreeks.reduce((acc, l) => acc + (Number(l.gamma) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0);
  const totalTheta = legGreeks.reduce((acc, l) => acc + (Number(l.theta) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0);
  const totalVega = legGreeks.reduce((acc, l) => acc + (Number(l.vega) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0);

  // ATM chain greeks from live data (first non-null CE/PE pair near spot).
  const atmRow = greeks?.strikes?.find((s) => s.ce && s.pe) || null;

  const greekCards = [
    { label: 'Net Delta', value: hasLegGreeks ? totalDelta.toFixed(2) : (atmRow ? (atmRow.ce.delta + atmRow.pe.delta).toFixed(2) : '—'), sub: hasLegGreeks || atmRow ? (totalDelta > 0 ? 'Long Delta' : totalDelta < 0 ? 'Short Delta' : 'Delta Neutral') : 'Live chain unavailable', color: 'text-sky' },
    { label: 'Net Gamma', value: hasLegGreeks ? totalGamma.toFixed(4) : (atmRow ? (atmRow.ce.gamma + atmRow.pe.gamma).toFixed(4) : '—'), sub: (totalGamma >= 0 ? 'Long Gamma' : 'Short Gamma'), color: totalGamma >= 0 ? 'text-accent' : 'text-danger' },
    { label: 'Net Theta', value: hasLegGreeks ? `${totalTheta >= 0 ? '+' : ''}${totalTheta.toFixed(1)}/d` : (atmRow ? `${(atmRow.ce.theta + atmRow.pe.theta).toFixed(1)}/d` : '—'), sub: 'Decay Impact', color: totalTheta >= 0 ? 'text-accent' : 'text-danger' },
    { label: 'Net Vega', value: hasLegGreeks ? totalVega.toFixed(1) : (atmRow ? (atmRow.ce.vega + atmRow.pe.vega).toFixed(1) : '—'), sub: (totalVega >= 0 ? 'Long Vol' : 'Short Vol'), color: totalVega >= 0 ? 'text-sky' : 'text-danger' },
    { label: 'Open Lots', value: String(state.positions.filter((p: any) => p.netQty !== 0).length), sub: 'Active Positions', color: 'text-gold' },
    { label: 'Realized PnL', value: `₹${state.funds.realizedPnl ?? 0}`, sub: 'From Wallet', color: Number(state.funds.realizedPnl) >= 0 ? 'text-accent' : 'text-danger' },
    { label: 'Margin Used', value: `₹${state.funds.usedMargin ?? 0}`, sub: 'Collateral Block', color: 'text-purple' },
  ];

  const tabs = [
    { id: 'breakdown', label: 'Greeks Breakdown' },
    { id: 'chain', label: 'Live Chain Greeks (B-S)' },
    { id: 'expired', label: 'Rolling Options Analytics' },
  ];

  useEffect(() => {
    if (activeTab === 'breakdown' && chartRef.current) {
      drawGreekBarChart(chartRef.current, state.strategies, greeks);
    }
  }, [activeTab, state.strategies, greeks]);

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

      {greeksError && (
        <Card className="p-3 border-gold/20">
          <div className="text-[10px] font-mono text-gold">
            Live chain Greeks unavailable: {greeksError}. Portfolio cards fall back to leg Greeks recorded at deploy time.
          </div>
        </Card>
      )}

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
          {greeks && <span className="ml-auto text-[9px] font-mono text-muted">spot ₹{greeks.spot} · exp {greeks.expiry} · Black-Scholes</span>}
        </div>

        {activeTab === 'breakdown' && (
          <div>
            <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">Strategy Greek Exposure Distribution</div>
            <canvas ref={chartRef} height={190} className="w-full" />
          </div>
        )}
        {activeTab === 'chain' && (
          <div className="overflow-x-auto">
            {!greeks || greeks.strikes.length === 0 ? (
              <div className="py-8 text-center text-muted text-xs">
                Live option chain Greeks unavailable — the backend needs valid DhanHQ credentials and market data.
              </div>
            ) : (
              <table className="data-table w-full">
                <thead>
                  <tr>
                    {['Strike', 'CE Δ', 'CE Γ', 'CE Θ', 'CE ν', 'CE IV', 'PE Δ', 'PE Γ', 'PE Θ', 'PE ν', 'PE IV'].map((h) => (
                      <th key={h} className="text-left px-2.5 py-1.5 text-muted font-medium border-b border-border text-[9px] uppercase tracking-[0.5px]">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {greeks.strikes.map((s) => (
                    <tr key={s.strike} className={`hover:bg-surface-200/50 ${Math.abs(s.strike - greeks.spot) < 50 ? 'bg-surface-50' : ''}`}>
                      <td className="px-2.5 py-1.5 border-b border-border/60 text-white font-mono text-xs font-bold">{s.strike}</td>
                      {[s.ce, s.pe].map((leg, li) => (
                        leg ? (
                          <td key={li} colSpan={5} className="px-0 py-0 border-b border-border/60">
                            <div className="flex text-[10px] font-mono">
                              <span className="px-2.5 py-1.5 w-1/5 text-sky">{leg.delta.toFixed(3)}</span>
                              <span className="px-2.5 py-1.5 w-1/5 text-danger">{leg.gamma.toFixed(4)}</span>
                              <span className="px-2.5 py-1.5 w-1/5 text-accent">{leg.theta.toFixed(1)}</span>
                              <span className="px-2.5 py-1.5 w-1/5 text-gold">{leg.vega.toFixed(2)}</span>
                              <span className="px-2.5 py-1.5 w-1/5 text-muted">{leg.iv?.toFixed?.(1) ?? '—'}</span>
                            </div>
                          </td>
                        ) : (
                          <td key={li} colSpan={5} className="px-2.5 py-1.5 border-b border-border/60 text-muted text-[10px] font-mono">—</td>
                        )
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
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

function drawGreekBarChart(canvas: HTMLCanvasElement, strategies: any[], greeks: { strikes: Array<{ strike: number; ce: any; pe: any }>; spot: number } | null) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  canvas.width = rect.width - 24;
  canvas.height = 190;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const active = strategies.filter((s) => s.status !== 'STOPPED');

  // If no strategies are deployed but live chain greeks exist, draw the
  // ATM ±N strike delta profile instead of an empty canvas.
  const hasLiveGreeks = greeks && greeks.strikes?.some((s) => s.ce || s.pe);

  if (active.length === 0 && !hasLiveGreeks) {
    ctx.font = '11px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText('No strategies deployed and no live chain — deploy a strategy or connect DhanHQ credentials.', w / 2, h / 2);
    return;
  }

  let data: Array<{ name: string; d: number; g: number; th: number; v: number }>;

  if (active.length > 0) {
    data = active.map((s) => {
      const legs = s.legs || [];
      return {
        name: s.name.replace('NIFTY ', 'N.').replace('BANKNIFTY ', 'BN.'),
        d: legs.reduce((t: number, l: any) => t + (Number(l.delta) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
        g: legs.reduce((t: number, l: any) => t + (Number(l.gamma) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
        th: legs.reduce((t: number, l: any) => t + (Number(l.theta) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
        v: legs.reduce((t: number, l: any) => t + (Number(l.vega) || 0) * (l.side === 'SELL' ? -1 : 1) * l.qty / 50, 0),
      };
    });
  } else {
    // Live chain delta ladder around spot (real Black-Scholes values).
    const spot = greeks!.spot;
    const near = greeks!.strikes
      .filter((s) => Math.abs(s.strike - spot) < 300 && (s.ce || s.pe))
      .slice(0, 7);
    data = near.map((s) => ({
      name: String(s.strike),
      d: (s.ce?.delta ?? 0) + (s.pe?.delta ?? 0),
      g: (s.ce?.gamma ?? 0) + (s.pe?.gamma ?? 0),
      th: (s.ce?.theta ?? 0) + (s.pe?.theta ?? 0),
      v: (s.ce?.vega ?? 0) + (s.pe?.vega ?? 0),
    }));
  }

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
