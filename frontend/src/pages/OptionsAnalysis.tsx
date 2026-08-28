import { useState, useEffect, useCallback } from 'react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { Badge } from '../components/ui/Badge';
import { fmt, fmtINR, pnlClass } from '../utils/formatters';
import { api } from '../services/api';
import { useApp } from '../store/AppContext';
import { Zap, ShieldAlert, TrendingUp, Clock, RefreshCw } from 'lucide-react';

export function OptionsAnalysis() {
  const { showToast } = useApp();
  const [symbol, setSymbol] = useState('NIFTY');
  const [days, setDays] = useState(5);
  const [interval, setIntervalVal] = useState('1');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.optionsAnalysis({ symbol, days, interval, expiryFlag: 'WEEK' });
      setData(res);
      setSelectedDayIndex(0);
      showToast(`Analysis completed for ${symbol} (${days} trading days)`, 'success');
    } catch (e: any) {
      showToast(`Analysis failed: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [symbol, days, interval, showToast]);

  useEffect(() => {
    runAnalysis();
  }, [runAnalysis]);

  const summary = data?.summary || {};
  const activeDay = data?.days?.[selectedDayIndex] || data?.days?.[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Underlying vs Options Behavior</div>
          <div className="text-xs text-muted mt-0.5">DhanHQ 1m Granular OHLCV & Rolling ATM Options Dynamics</div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="text-xs">
            <option value="NIFTY">NIFTY 50 (13)</option>
            <option value="BANKNIFTY">BANK NIFTY (25)</option>
            <option value="FINNIFTY">FIN NIFTY (27)</option>
          </Select>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs">
            <option value={3}>Last 3 Days</option>
            <option value={5}>Last 5 Days</option>
            <option value={10}>Last 10 Days</option>
          </Select>
          <Select value={interval} onChange={(e) => setIntervalVal(e.target.value)} className="text-xs">
            <option value="1">1m Granular</option>
            <option value="5">5m Candle</option>
            <option value="15">15m Candle</option>
          </Select>
          <Button onClick={runAnalysis} disabled={loading}>
            <RefreshCw size={12} className={`mr-1 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Analyzing...' : 'Run Analysis'}
          </Button>
        </div>
      </div>

      <MetricsRow summary={summary} symbol={symbol} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <DaySelectorCard days={data?.days || []} selectedIndex={selectedDayIndex} onSelect={setSelectedDayIndex} />
        <div className="lg:col-span-3">
          <StrikeTableCard day={activeDay} symbol={symbol} />
        </div>
      </div>

      <StrategyInsightsGrid breakEvenPts={summary.breakEvenMovePts || 110} />
    </div>
  );
}

function MetricsRow({ summary, symbol }: { summary: any; symbol: string }) {
  const winRate = summary.winRate ?? 0;
  const avgPnl = summary.avgNetPnl ?? 0;
  const lotSize = symbol === 'BANKNIFTY' ? 15 : 25;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Straddle Win Rate</div>
        <div className={`text-xl font-bold font-mono ${winRate >= 50 ? 'text-accent' : 'text-danger'}`}>{winRate}%</div>
        <div className="text-[10px] font-mono text-muted mt-1">{summary.winDays ?? 0} Win / {(summary.totalDays ?? 0) - (summary.winDays ?? 0)} Loss</div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Avg ATM Net P&L</div>
        <div className={`text-xl font-bold font-mono ${pnlClass(avgPnl)}`}>{avgPnl >= 0 ? `+${fmt(avgPnl)}` : fmt(avgPnl)} pts</div>
        <div className="text-[10px] font-mono text-muted mt-1">{fmtINR(avgPnl * lotSize)} / lot</div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Best ROI Strike</div>
        <div className="text-xl font-bold font-mono text-sky">{summary.bestStrike || 'ATM'}</div>
        <div className="text-[10px] font-mono text-accent mt-1">Avg ROI: +{summary.avgBestStrikeRoi || 0}%</div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Break-Even Move</div>
        <div className="text-xl font-bold font-mono text-gold">~{summary.breakEvenMovePts || 110} pts</div>
        <div className="text-[10px] font-mono text-muted mt-1">Min spot displacement</div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Market Regimes</div>
        <div className="text-sm font-bold font-mono text-white mt-1">
          <span className="text-accent">{summary.gammaBlastCount || 0} Blast</span> · <span className="text-danger">{summary.thetaTrapCount || 0} Trap</span>
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">Dynamic ATM tracked</div>
      </Card>
    </div>
  );
}

function DaySelectorCard({ days, selectedIndex, onSelect }: { days: any[]; selectedIndex: number; onSelect: (idx: number) => void }) {
  return (
    <Card className="p-3">
      <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">Trading Days</div>
      <div className="space-y-1.5">
        {days.map((d, i) => {
          const isSelected = i === selectedIndex;
          const isBlast = d.regime === 'GAMMA_BLAST';
          const isTrap = d.regime === 'THETA_TRAP';
          return (
            <div
              key={d.date}
              onClick={() => onSelect(i)}
              className={`p-2.5 rounded-lg cursor-pointer transition-all border ${
                isSelected ? 'bg-accent/10 border-accent/40' : 'bg-surface-50 border-border hover:bg-surface-200/50'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-white">{d.date} <span className="text-muted font-normal text-[10px]">({d.dayOfWeek})</span></span>
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-semibold ${isBlast ? 'bg-accent/20 text-accent' : isTrap ? 'bg-danger/20 text-danger' : 'bg-gold/20 text-gold'}`}>
                  {isBlast ? '🚀 BLAST' : isTrap ? '⏳ THETA' : '⚖️ RANGE'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="text-muted">Spot: {fmt(d.spot.change)} pts</span>
                <span className={pnlClass(d.atmStraddlePnl)}>{d.atmStraddlePnl >= 0 ? `+${fmt(d.atmStraddlePnl)}` : fmt(d.atmStraddlePnl)} pts</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function StrikeTableCard({ day }: { day: any; symbol: string }) {
  if (!day) return <Card className="p-6 text-center text-muted text-xs">Select a day to view strike breakdown.</Card>;
  const spot = day.spot || {};

  return (
    <Card className="p-4 overflow-x-auto space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
        <div>
          <span className="text-sm font-bold text-white mr-2">{day.date} ({day.dayOfWeek})</span>
          <span className="text-xs font-mono text-muted">
            Spot Open: <strong className="text-white">{fmt(spot.open)}</strong> → Close: <strong className="text-white">{fmt(spot.close)}</strong> | Move: <strong className={spot.change >= 0 ? 'text-accent' : 'text-danger'}>{spot.change >= 0 ? '+' : ''}{fmt(spot.change)} pts ({fmt(spot.pct)}%)</strong>
          </span>
        </div>
        <div className="text-xs font-mono">
          Parallel ATM: <span className={`font-bold ${pnlClass(day.atmStraddlePnl)}`}>{day.atmStraddlePnl >= 0 ? '+' : ''}{fmt(day.atmStraddlePnl)} pts ({day.atmStraddleRoi}%)</span>
        </div>
      </div>

      <table className="data-table w-full">
        <thead>
          <tr>
            {['Strike', 'Call Open', 'Call Close', 'Call P&L', 'Put Open', 'Put Close', 'Put P&L', 'Straddle Net', 'Net ROI', '1:30 PM Exit', 'Status'].map((h) => (
              <th key={h} className="text-left px-2 py-1.5 text-muted font-medium border-b border-border text-[9px] uppercase tracking-[0.5px]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(day.strikes || []).map((s: any) => {
            const isAtm = s.strike === 'ATM';
            return (
              <tr key={s.strike} className={`hover:bg-surface-200/50 ${isAtm ? 'bg-accent/5 font-semibold' : ''}`}>
                <td className="px-2 py-1.5 border-b border-border/60 text-white font-mono text-[10px]">{s.strike} {isAtm && '⭐'}</td>
                <td className="px-2 py-1.5 border-b border-border/60 text-muted font-mono text-[10px]">{fmt(s.call.open)}</td>
                <td className="px-2 py-1.5 border-b border-border/60 text-white font-mono text-[10px]">{fmt(s.call.close)}</td>
                <td className={`px-2 py-1.5 border-b border-border/60 font-mono text-[10px] ${pnlClass(s.call.pnl)}`}>{s.call.pnl >= 0 ? '+' : ''}{fmt(s.call.pnl)}</td>
                <td className="px-2 py-1.5 border-b border-border/60 text-muted font-mono text-[10px]">{fmt(s.put.open)}</td>
                <td className="px-2 py-1.5 border-b border-border/60 text-white font-mono text-[10px]">{fmt(s.put.close)}</td>
                <td className={`px-2 py-1.5 border-b border-border/60 font-mono text-[10px] ${pnlClass(s.put.pnl)}`}>{s.put.pnl >= 0 ? '+' : ''}{fmt(s.put.pnl)}</td>
                <td className={`px-2 py-1.5 border-b border-border/60 font-mono text-[10px] font-bold ${pnlClass(s.straddle.netPnl)}`}>
                  {s.straddle.netPnl >= 0 ? '+' : ''}{fmt(s.straddle.netPnl)} pts
                </td>
                <td className={`px-2 py-1.5 border-b border-border/60 font-mono text-[10px] font-bold ${pnlClass(s.straddle.netRoi)}`}>
                  {s.straddle.netRoi >= 0 ? '+' : ''}{fmt(s.straddle.netRoi)}%
                </td>
                <td className={`px-2 py-1.5 border-b border-border/60 font-mono text-[9.5px] ${pnlClass(s.exit130?.netPnl || 0)}`}>
                  {(s.exit130?.netPnl || 0) >= 0 ? '+' : ''}{fmt(s.exit130?.netPnl || 0)} pts
                </td>
                <td className="px-2 py-1.5 border-b border-border/60">
                  <Badge status={s.straddle.status === 'PROFIT' ? 'TRADED' : 'REJECTED'} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function StrategyInsightsGrid({ breakEvenPts }: { breakEvenPts: number }) {
  const insights = [
    {
      title: '1. The "Theta Decay" Trap (Sideways Days)',
      icon: <ShieldAlert size={14} className="text-danger" />,
      desc: `When spot moves < 0.3% (< ${Math.round(breakEvenPts * 0.6)} pts), both ATM Call and Put lose premium from 9:15 AM to 3:30 PM due to time decay. Avoid long straddles when previous day ATR or VIX is dropping.`,
    },
    {
      title: '2. The "Gamma Blast" (Directional Days)',
      icon: <Zap size={14} className="text-accent" />,
      desc: `When spot moves > 0.6% (> ${breakEvenPts} pts), the winning option leg surges +80% to +140%, easily overcoming the ~40% loss of the opposite leg. Net straddle P&L is highly positive.`,
    },
    {
      title: '3. Intraday Exit Timing (1:30 PM Rule)',
      icon: <Clock size={14} className="text-gold" />,
      desc: 'Options buying strategies frequently peak in profitability between 11:00 AM and 1:30 PM. Holding until 3:30 PM on stalling sessions exposes gains to severe late-afternoon theta erosion.',
    },
    {
      title: '4. Strike Selection & ROI Efficiency (OTM vs ATM)',
      icon: <TrendingUp size={14} className="text-sky" />,
      desc: 'ATM+1 and ATM+2 strikes have lower initial premium. On trending days, their percentage return (ROI%) frequently outperforms ATM because capital at risk is lower.',
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {insights.map((item) => (
        <Card key={item.title} className="p-3.5 bg-surface-50 border border-border">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-white mb-1.5">
            {item.icon}
            <span>{item.title}</span>
          </div>
          <p className="text-[10px] text-muted leading-relaxed">{item.desc}</p>
        </Card>
      ))}
    </div>
  );
}
