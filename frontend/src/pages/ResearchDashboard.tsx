import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { ResearchActivityLog } from '../components/research/ResearchActivityLog';
import { RefreshCw, Loader2, ArrowUpRight, TrendingUp, Clock, Calendar, Info } from 'lucide-react';

/**
 * Landing view for research: what the engine currently likes, grouped by how
 * long the setup is good for, so the first screen answers "what should I look
 * at today" instead of requiring you to go run something first.
 *
 * Everything shown here is price/volume derived. The deep-dive verdicts
 * (stance, DCF, fair value) are deliberately NOT surfaced as recommendations:
 * no fundamentals feed is wired to this system, so those are modelled from
 * synthetic statements and would be dressed-up guesses at this scale.
 */

const HORIZONS = [
  { key: 'SWING', label: 'Swing', hint: 'Days to ~2 weeks — above 20DMA, pushing at the highs', Icon: TrendingUp },
  { key: 'SHORT_TERM', label: 'Short Term', hint: 'Weeks to a quarter — above 50DMA, beating NIFTY over 60d', Icon: Clock },
  { key: 'LONG_TERM', label: 'Long Term', hint: 'Months — above a rising 200DMA, beating NIFTY over a year', Icon: Calendar },
] as const;

const fmtPct = (v: number | null | undefined) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const tone = (v: number | null | undefined) =>
  v == null ? 'text-zinc-500' : v > 0 ? 'text-emerald-400' : 'text-rose-400';

interface Props {
  onSelectSymbol: (symbol: string) => void;
  onOpenScreener: () => void;
}

export function ResearchDashboard({ onSelectSymbol, onOpenScreener }: Props) {
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [scheduler, setScheduler] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [wl, sched] = await Promise.all([
      api.researchWatchlist().catch(() => ({ watchlist: [] as any[] })),
      api.researchSchedulerStatus().catch(() => null),
    ]);
    setWatchlist(wl.watchlist || []);
    setScheduler(sched);
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await api.researchWatchlistRefresh();
      await load();
    } catch (e: any) {
      setError(e.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const byHorizon = (key: string) =>
    watchlist
      .filter((w) => (w.horizons || []).includes(key))
      .sort((a, b) => b.deterministicScore - a.deterministicScore);

  // Rows that match no horizon are still real watchlist entries. Dropping
  // them silently made the header ("30 stocks") contradict three empty
  // columns, which reads as a broken page rather than as "nothing set up
  // right now".
  const unclassified = watchlist.filter((w) => (w.horizons || []).length === 0);
  const classifiedCount = watchlist.length - unclassified.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-white">Research Dashboard</h2>
          <p className="text-[11px] text-muted">
            {classifiedCount} of {watchlist.length} watchlist stock{watchlist.length === 1 ? '' : 's'} with a current setup
            {scheduler?.marketPhase ? ` · ${scheduler.marketPhase.replace('_', ' ').toLowerCase()}` : ''}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent hover:brightness-110 disabled:opacity-50 text-black font-bold text-xs cursor-pointer transition-all"
        >
          {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          <span>{refreshing ? 'Screening…' : 'Refresh Picks'}</span>
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs font-mono">
          {error}
        </div>
      )}

      {/* Shown always, not only while running: the last run's steps are how you
          check what produced the current picks. */}
      <ResearchActivityLog running={refreshing} />

      <div className="flex items-start gap-2 px-3 py-2 rounded border border-border bg-surface-100 text-[11px] text-muted">
        <Info size={13} className="mt-0.5 shrink-0 text-sky-400" />
        <span>
          Ranked on price and volume only — relative strength vs NIFTY, trend alignment and liquidity.
          No fundamentals feed is connected, so no valuation or DCF claim is made here.
        </span>
      </div>

      {unclassified.length > 0 && (
        <div className="px-3 py-2 rounded border border-border bg-surface-100 text-[11px]">
          <span className="text-amber-400 font-semibold">{unclassified.length} watchlist stock{unclassified.length === 1 ? '' : 's'} match no horizon right now</span>
          <span className="text-muted"> — held but not currently set up, or screened before horizons were tracked. Refresh to re-evaluate: </span>
          <span className="font-mono text-zinc-400">{unclassified.slice(0, 12).map((w) => w.symbol).join(', ')}{unclassified.length > 12 ? '…' : ''}</span>
        </div>
      )}

      {watchlist.length === 0 ? (
        <div className="text-center py-10 bg-surface-100 border border-border rounded-lg">
          <p className="text-sm text-white font-semibold">No picks yet</p>
          <p className="text-[11px] text-muted mt-1 mb-3">
            Run a refresh above, or choose a universe and preset in the screener.
          </p>
          <button
            onClick={onOpenScreener}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-200 hover:bg-accent hover:text-black text-white font-semibold text-xs border border-border cursor-pointer transition-all"
          >
            <span>Open Screener</span>
            <ArrowUpRight size={12} />
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {HORIZONS.map(({ key, label, hint, Icon }) => {
            const picks = byHorizon(key);
            return (
              <div key={key} className="bg-surface-100 border border-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 border-b border-border/60">
                  <div className="flex items-center gap-1.5">
                    <Icon size={13} className="text-accent" />
                    <span className="text-xs font-bold text-white">{label}</span>
                    <span className="ml-auto text-[10px] font-mono text-muted">{picks.length}</span>
                  </div>
                  <p className="text-[10px] text-muted mt-0.5">{hint}</p>
                </div>
                <div className="divide-y divide-border/30">
                  {picks.length === 0 ? (
                    <p className="px-3 py-4 text-[11px] text-muted text-center">Nothing qualifying right now.</p>
                  ) : (
                    picks.slice(0, 8).map((w) => (
                      <button
                        key={w.symbol}
                        onClick={() => onSelectSymbol(w.symbol)}
                        className="w-full px-3 py-2 text-left hover:bg-surface-200/40 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-bold text-white text-xs">{w.symbol}</span>
                          <span className="font-mono font-bold text-accent text-xs">{w.deterministicScore}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[10px] font-mono">
                          <span className={tone(w.metrics?.return20d)}>20d {fmtPct(w.metrics?.return20d)}</span>
                          <span className={tone(w.metrics?.relativeStrength60d)}>
                            vs NIFTY {fmtPct(w.metrics?.relativeStrength60d)}
                          </span>
                          <span className="text-zinc-500">{fmtPct(w.metrics?.pctFrom52wHigh)} off high</span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
