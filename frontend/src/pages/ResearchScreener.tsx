import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Filter, Play, Sparkles, Loader2, CheckCircle2, XCircle, ArrowUpRight } from 'lucide-react';
import { ResearchActivityLog } from '../components/research/ResearchActivityLog';

interface ScreenerProps {
  onSelectSymbol: (symbol: string) => void;
}

// null means "not enough price history to say", which must read differently from 0%.
const fmtPct = (v: number | null | undefined) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const pnlTone = (v: number | null | undefined) =>
  v == null ? 'text-zinc-500' : v > 0 ? 'text-emerald-400' : 'text-rose-400';

export function ResearchScreener({ onSelectSymbol }: ScreenerProps) {
  const [universes, setUniverses] = useState<any[]>([]);
  const [universe, setUniverse] = useState('FNO_HEAVYWEIGHTS');
  const [preset, setPreset] = useState('MOMENTUM_BREAKOUT');
  const [exchange, setExchange] = useState('NSE');
  const [loading, setLoading] = useState(false);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.researchUniverses(exchange).then((d) => setUniverses(d.universes || [])).catch(() => {});
  }, [exchange]);

  const handleScreen = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.researchScreen(universe, preset, exchange);
      setResult(data);
    } catch (e: any) {
      setError(e.message || 'Screening failed');
    } finally {
      setLoading(false);
    }
  };

  const handleFunnel = async () => {
    setFunnelLoading(true);
    setError(null);
    try {
      const data = await api.researchScreenAndAnalyze(universe, preset, 3, exchange);
      setResult(data.screener);
      if (data.analyzedRuns?.length > 0) {
        onSelectSymbol(data.analyzedRuns[0].symbol);
      }
    } catch (e: any) {
      setError(e.message || 'Funnel analysis failed');
    } finally {
      setFunnelLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-white uppercase font-mono">
            <Filter size={16} className="text-accent" />
            <span>Two-Stage Quantitative Screener</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleScreen}
              disabled={loading || funnelLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-200 hover:bg-surface-200/80 text-white font-medium text-xs rounded border border-border transition-all cursor-pointer disabled:opacity-50"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              <span>{loading ? 'Screening...' : 'Fast Screen (Deterministic)'}</span>
            </button>
            <button
              onClick={handleFunnel}
              disabled={loading || funnelLoading}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-accent hover:bg-accent/90 text-black font-semibold text-xs rounded transition-all cursor-pointer disabled:opacity-50"
            >
              {funnelLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              <span>{funnelLoading ? 'AI Analyzing...' : 'Deep Dive Top 3 (Agentic AI)'}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          <div>
            <label className="text-[10px] font-mono uppercase text-muted">Exchange</label>
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value)}
              className="w-full mt-1 bg-bg border border-border rounded px-2.5 py-1.5 text-xs text-white outline-none font-mono"
            >
              <option value="NSE">NSE</option>
              <option value="BSE">BSE</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase text-muted">Stock Universe</label>
            <select
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
              className="w-full mt-1 bg-bg border border-border rounded px-2.5 py-1.5 text-xs text-white outline-none font-mono"
            >
              {universes.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.count} stocks)</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase text-muted">Quantitative Filter Preset</label>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              className="w-full mt-1 bg-bg border border-border rounded px-2.5 py-1.5 text-xs text-white outline-none font-mono"
            >
              <option value="MOMENTUM_BREAKOUT">Momentum / Swing (at the highs, positive 20d)</option>
              <option value="OPTIONS_BULLISH">Short Term (above 50DMA, beating NIFTY over 60d)</option>
              <option value="QUALITY_COMPOUNDERS">Long-Term Leaders (rising 200DMA, 1y outperformance)</option>
              <option value="VALUE_MARGIN_OF_SAFETY">Pullback in Uptrend (above 200DMA, ≥8% off high)</option>
            </select>
          </div>
        </div>
      </div>

      {error && <div className="p-3 bg-danger/10 border border-danger/30 rounded text-danger text-xs font-mono">{error}</div>}

      <ResearchActivityLog running={loading || funnelLoading} />

      {result && (
        <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-3">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-white font-bold">
              Screen Results: {result.totalPassed}/{result.totalScreened} Passed
              {result.skipped ? <span className="text-muted font-normal"> · {result.skipped} skipped (insufficient history)</span> : null}
            </span>
            <span className="text-muted">Top Picks: <strong className="text-accent">{result.topPicks?.join(', ') || 'None'}</strong></span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted font-mono text-[10px] uppercase">
                  <th className="py-2 px-2">Symbol</th>
                  <th className="py-2 px-2">Sector</th>
                  <th className="py-2 px-2">CMP</th>
                  <th className="py-2 px-2">Score</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2">Horizon</th>
                  <th className="py-2 px-2">20d</th>
                  <th className="py-2 px-2">60d vs NIFTY</th>
                  <th className="py-2 px-2">From 52w High</th>
                  <th className="py-2 px-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {(result.candidates || []).map((c: any) => (
                  <tr key={c.symbol} className="hover:bg-surface-200/40 transition-colors">
                    <td className="py-2 px-2 font-mono font-bold text-white">{c.symbol}</td>
                    <td className="py-2 px-2 text-[11px] text-zinc-400">{c.sector}</td>
                    <td className="py-2 px-2 font-mono text-zinc-200">₹{c.cmp}</td>
                    <td className="py-2 px-2 font-mono font-bold text-accent">{c.deterministicScore}</td>
                    <td className="py-2 px-2">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded ${c.passed ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'}`}>
                        {c.passed ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                        {c.passed ? 'PASS' : 'FAIL'}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex flex-wrap gap-1">
                        {(c.horizons || []).length === 0
                          ? <span className="text-[10px] font-mono text-zinc-600">—</span>
                          : (c.horizons || []).map((h: string) => (
                            <span key={h} className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">
                              {h.replace('_TERM', '')}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td className={`py-2 px-2 font-mono ${pnlTone(c.metrics?.return20d)}`}>{fmtPct(c.metrics?.return20d)}</td>
                    <td className={`py-2 px-2 font-mono ${pnlTone(c.metrics?.relativeStrength60d)}`}>{fmtPct(c.metrics?.relativeStrength60d)}</td>
                    <td className="py-2 px-2 font-mono text-zinc-300">{fmtPct(c.metrics?.pctFrom52wHigh)}</td>
                    <td className="py-2 px-2 text-right">
                      <button
                        onClick={() => onSelectSymbol(c.symbol)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-surface-200 hover:bg-accent hover:text-black text-white font-semibold text-[10px] font-mono border border-border transition-all cursor-pointer"
                      >
                        <span>Deep Dive</span>
                        <ArrowUpRight size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
