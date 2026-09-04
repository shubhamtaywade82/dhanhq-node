import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Clock, Send, RefreshCw, Loader2, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { LerpNumber } from '../components/ui/LerpNumber';
import { FlashValue } from '../components/ui/FlashValue';

// null means "not enough price history to say", which must read differently from 0%.
const fmtPct = (v: number | null | undefined) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const pnlTone = (v: number | null | undefined) =>
  v == null ? 'text-zinc-500' : v > 0 ? 'text-emerald-400' : 'text-rose-400';

interface Props {
  onSelectSymbol: (symbol: string) => void;
}

export function ResearchWatchlist({ onSelectSymbol }: Props) {
  const [status, setStatus] = useState<any>(null);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [statusRes, wlRes] = await Promise.all([
        api.researchSchedulerStatus(),
        api.researchWatchlist(),
      ]);
      setStatus(statusRes);
      setWatchlist(wlRes.watchlist || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  const handleRefreshWatchlist = async () => {
    setActionLoading('refresh');
    setFeedback(null);
    try {
      const res = await api.researchWatchlistRefresh('FNO_HEAVYWEIGHTS', 'QUALITY_COMPOUNDERS');
      setWatchlist(res.watchlist || []);
      setFeedback(`Watchlist refreshed: ${res.count} stocks active.`);
      loadData();
    } catch (e: any) {
      setFeedback(`Refresh failed: ${e.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleTriggerPhase = async (phase: string, label: string) => {
    setActionLoading(phase);
    setFeedback(null);
    try {
      const res = await api.researchSchedulerTrigger(phase);
      setFeedback(`${label} dispatched: ${typeof res.result === 'string' ? res.result.slice(0, 120) : 'Success'}`);
      loadData();
    } catch (e: any) {
      setFeedback(`Failed to trigger ${label}: ${e.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <StatusCard
          label="Market Phase"
          val={status?.marketPhase || 'CLOSED'}
          badge={status?.marketPhase === 'MARKET_HOURS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-surface-200 text-muted'}
        />
        <StatusCard label="Next Scheduled Job" val={status?.nextScheduledJob || 'Armed'} />
        <StatusCard
          label="Telegram Alerts"
          val={status?.telegramEnabled ? 'Connected' : 'Disabled'}
          badge={status?.telegramEnabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-surface-200 text-muted'}
        />
        <StatusCard label="Active Watchlist" val={`${watchlist.length} Stocks`} highlight />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-surface-100 border border-border rounded-lg">
        <div className="text-xs text-muted font-mono flex items-center gap-1.5">
          <Clock size={14} className="text-accent" />
          <span>Automated Lifecycle Schedule (Pre-Market 08:45 • Mid-Day 11:30 • EOD 15:50 IST)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefreshWatchlist}
            disabled={!!actionLoading}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-surface-200 hover:bg-surface-200/80 text-xs font-mono font-medium text-white border border-border cursor-pointer disabled:opacity-50"
          >
            {actionLoading === 'refresh' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            <span>Refresh Watchlist</span>
          </button>
          <button
            onClick={() => handleTriggerPhase('pre_market', 'Pre-Market Brief')}
            disabled={!!actionLoading}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-surface-200 hover:bg-surface-200/80 text-xs font-mono font-medium text-white border border-border cursor-pointer disabled:opacity-50"
          >
            {actionLoading === 'pre_market' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            <span>Test Pre-Market Brief</span>
          </button>
          <button
            onClick={() => handleTriggerPhase('post_market', 'EOD Dossier')}
            disabled={!!actionLoading}
            className="flex items-center gap-1 px-3.5 py-1.5 rounded bg-accent hover:bg-accent/90 text-xs font-mono font-bold text-black cursor-pointer disabled:opacity-50"
          >
            {actionLoading === 'post_market' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            <span>Test EOD Dossier</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-2.5 bg-accent/10 border border-accent/30 rounded text-xs font-mono text-accent flex items-center gap-2">
          <CheckCircle2 size={14} />
          <span>{feedback}</span>
        </div>
      )}

      <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-3">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-white font-bold">Active Persistent Watchlist ({watchlist.length})</span>
          <span className="text-muted">Monthly Rollover: Active</span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-muted text-xs font-mono flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin text-accent" />
            <span>Loading persistent watchlist...</span>
          </div>
        ) : watchlist.length === 0 ? (
          <div className="p-8 text-center text-muted text-xs font-mono">
            No active watchlist found. Click "Refresh Watchlist" to run monthly screening.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted font-mono text-[10px] uppercase">
                  <th className="py-2 px-2">Symbol</th>
                  <th className="py-2 px-2">Sector</th>
                  <th className="py-2 px-2">Score</th>
                  <th className="py-2 px-2">Horizon</th>
                  <th className="py-2 px-2">20d</th>
                  <th className="py-2 px-2">60d vs NIFTY</th>
                  <th className="py-2 px-2">From 52w High</th>
                  <th className="py-2 px-2">Last Analyzed</th>
                  <th className="py-2 px-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {watchlist.map((w: any) => (
                  <tr key={w.symbol} className="hover:bg-surface-200/40 transition-colors">
                    <td className="py-2 px-2 font-mono font-bold text-white">{w.symbol}</td>
                    <td className="py-2 px-2 text-[11px] text-zinc-400">{w.sector}</td>
                    <td className="py-2 px-2 font-mono font-bold text-accent">
                      <LerpNumber value={w.deterministicScore} decimals={0} />
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex flex-wrap gap-1">
                        {(w.horizons || []).length === 0
                          ? <span className="text-[10px] font-mono text-zinc-600">—</span>
                          : (w.horizons || []).map((h: string) => (
                            <span key={h} className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">
                              {h.replace('_TERM', '')}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td className={`py-2 px-2 font-mono ${pnlTone(w.metrics?.return20d)}`}>{fmtPct(w.metrics?.return20d)}</td>
                    <td className={`py-2 px-2 font-mono ${pnlTone(w.metrics?.relativeStrength60d)}`}>{fmtPct(w.metrics?.relativeStrength60d)}</td>
                    <td className="py-2 px-2 font-mono text-zinc-300">{fmtPct(w.metrics?.pctFrom52wHigh)}</td>
                    <td className="py-2 px-2 text-[10px] text-muted font-mono">
                      {w.lastAnalyzedAt ? new Date(w.lastAnalyzedAt).toLocaleTimeString() : 'Pending'}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <button
                        onClick={() => onSelectSymbol(w.symbol)}
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
        )}
      </div>
    </div>
  );
}

function StatusCard({ label, val, badge, highlight }: any) {
  return (
    <div className={`p-3 rounded-lg border ${highlight ? 'bg-accent/10 border-accent/30' : 'bg-surface-100 border-border'}`}>
      <div className="text-[10px] font-mono uppercase text-muted">{label}</div>
      <div className="flex items-center gap-2 mt-1">
        <span className={`text-xs font-bold font-mono ${highlight ? 'text-accent' : 'text-white'}`}>
          <FlashValue value={val}>{val}</FlashValue>
        </span>
        {badge && (
          <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${badge}`}>
            <FlashValue value={val}>{val}</FlashValue>
          </span>
        )}
      </div>
    </div>
  );
}
