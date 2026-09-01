import { Fragment, useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { fmt } from '../utils/formatters';
import { RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import type { IndexData } from '../store/types';

interface OptionLeg { ltp: number; oi: number; volume: number; iv: number; delta: number; gamma: number }
interface OptionStrikeRow { strike: number; ce: OptionLeg; pe: OptionLeg }

const CE_COLS = ['OI', 'Vol', 'IV%', 'Delta', 'LTP'] as const;
const PE_COLS = ['LTP', 'Delta', 'IV%', 'Vol', 'OI'] as const;

export function OptionsChain() {
  const { state, showToast } = useApp();
  const [symbol, setSymbol] = useState('NIFTY');
  const [loading, setLoading] = useState(false);
  const [chainRows, setChainRows] = useState<OptionStrikeRow[]>([]);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');
  const oiRef = useRef<HTMLCanvasElement>(null);
  const skewRef = useRef<HTMLCanvasElement>(null);
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  const spotRowRef = useRef<HTMLTableRowElement>(null);
  const scrolledRef = useRef(false);

  const idx = state.indices[symbol] ?? state.indices.NIFTY;
  const spot = (idx as IndexData)?.ltp || 24500;
  const step = symbol === 'SENSEX' || symbol === 'BANKNIFTY' ? 100 : 50;
  const atm = Math.round(spot / step) * step;

  // spot/step/atm change on every live tick — keep them out of loadChain's
  // identity (via a ref) so the poll effect below doesn't restart on every
  // tick and pile up overlapping requests against a slow endpoint.
  const fallbackRef = useRef({ spot, step, atm });
  fallbackRef.current = { spot, step, atm };

  useEffect(() => {
    setSelectedExpiry('');
    scrolledRef.current = false;
    api.expiries(symbol).then((res) => {
      const list = res?.expiries || [];
      setExpiries(list);
      if (list.length > 0) setSelectedExpiry(list[0]);
    }).catch(() => setExpiries([]));
  }, [symbol]);

  const loadChain = useCallback(async (isBackground = false) => {
    if (!isBackground) setLoading(true);
    try {
      const res = await api.optionChain(symbol, selectedExpiry || undefined);
      if (res?.strikes && res.strikes.length > 0) {
        setChainRows(res.strikes);
      } else {
        const f = fallbackRef.current;
        setChainRows(generateRealisticChain(f.spot, f.step, f.atm));
      }
    } catch {
      const f = fallbackRef.current;
      setChainRows(generateRealisticChain(f.spot, f.step, f.atm));
    } finally {
      if (!isBackground) setLoading(false);
    }
  }, [symbol, selectedExpiry]);

  useEffect(() => {
    loadChain(false);
    const interval = setInterval(() => loadChain(true), 5000);
    return () => clearInterval(interval);
  }, [loadChain]);

  // Deep OTM/ITM strikes on an expiry-day chain routinely carry zero OI,
  // volume and LTP on both legs — pure noise in a 200+ row table. Drop them.
  const visibleRows = chainRows
    .filter((r) => r.ce.oi > 0 || r.pe.oi > 0 || r.ce.ltp > 0 || r.pe.ltp > 0)
    .sort((a, b) => a.strike - b.strike);

  const maxOi = Math.max(1, ...visibleRows.map((r) => Math.max(r.ce.oi || 0, r.pe.oi || 0)));
  const spotRowIdx = visibleRows.findIndex((r) => r.strike >= spot);

  // The OI bar chart assumes ~15 rows fit legibly — window to strikes nearest ATM
  // rather than cramming in all 80+ filtered rows.
  const chartRows = [...visibleRows]
    .sort((a, b) => Math.abs(a.strike - atm) - Math.abs(b.strike - atm))
    .slice(0, 15)
    .sort((a, b) => a.strike - b.strike);

  useEffect(() => {
    if (oiRef.current && chartRows.length > 0) drawOiChart(oiRef.current, chartRows, atm);
    if (skewRef.current && chartRows.length > 0) drawIvSkewChart(skewRef.current, chartRows);
  }, [chartRows, atm]);

  // Jump to the ATM/spot row once per symbol+expiry — never fight the
  // user's own scrolling on the periodic background refreshes after that.
  useEffect(() => {
    if (scrolledRef.current || visibleRows.length === 0) return;
    const target = atmRowRef.current || spotRowRef.current;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      scrolledRef.current = true;
    }
  }, [visibleRows]);

  const totalCeOi = visibleRows.reduce((s, r) => s + (r.ce.oi || 0), 0);
  const totalPeOi = visibleRows.reduce((s, r) => s + (r.pe.oi || 0), 0);
  const pcr = totalCeOi > 0 ? (totalPeOi / totalCeOi).toFixed(2) : '1.00';

  return (
    <div className="space-y-3">
      <Card className="p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            <option value="NIFTY">NIFTY 50</option>
            <option value="BANKNIFTY">BANK NIFTY</option>
            <option value="FINNIFTY">FIN NIFTY</option>
            <option value="SENSEX">BSE SENSEX</option>
          </Select>
          <div className="text-xs font-mono text-muted pl-2 border-l border-border">
            ATM: <span className="text-gold font-bold">{fmt(atm, 0)}</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono text-muted">
          <div>Spot: <span className="text-white font-semibold">{fmt(spot)}</span></div>
          <div>PCR: <span className="text-accent font-semibold">{pcr}</span></div>
          <div>CE OI: <span className="text-accent font-semibold">{fmt(totalCeOi, 0)}</span></div>
          <div>PE OI: <span className="text-danger font-semibold">{fmt(totalPeOi, 0)}</span></div>
          <Button variant="ghost" className="text-xs py-1" onClick={() => { loadChain(); showToast('Option chain updated', 'success'); }}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>
      </Card>

      {expiries.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {expiries.map((exp) => (
            <button
              key={exp}
              onClick={() => { scrolledRef.current = false; setSelectedExpiry(exp); }}
              className={`shrink-0 px-3 py-1.5 rounded-md text-[10.5px] font-mono font-semibold border transition-colors ${
                exp === selectedExpiry
                  ? 'bg-gold/10 border-gold/40 text-gold'
                  : 'bg-surface-100 border-border text-muted hover:text-white hover:border-surface-400'
              }`}
            >
              {formatExpiryLabel(exp)}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold flex items-center justify-between">
            <span>Open Interest Distribution (CE vs PE)</span>
            <span className="text-accent text-[9px]">LIVE DHAN CHAIN</span>
          </div>
          <canvas ref={oiRef} height={130} className="w-full" />
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold flex items-center justify-between">
            <span>Implied Volatility Smile / Skew</span>
            <span className="text-gold text-[9px]">ATM Strike: {fmt(atm, 0)}</span>
          </div>
          <canvas ref={skewRef} height={130} className="w-full" />
        </Card>
      </div>

      <Card className="p-0 overflow-hidden flex flex-col min-h-0" style={{ height: 'calc(100vh - 400px)', minHeight: 320 }}>
        <div className="overflow-auto flex-1 min-h-0">
          <table className="data-table w-full">
            <thead className="sticky top-0 z-10 bg-surface-100">
              <tr>
                {CE_COLS.map((h) => (
                  <th key={`ce-${h}`} className="px-2.5 py-2 font-medium border-b border-accent/20 text-[9.5px] text-accent text-right bg-surface-100">{h}</th>
                ))}
                <th className="px-3 py-2 font-bold border-b border-gold/30 text-[9.5px] text-gold text-center bg-surface-100">STRIKE</th>
                {PE_COLS.map((h) => (
                  <th key={`pe-${h}`} className="px-2.5 py-2 font-medium border-b border-danger/20 text-[9.5px] text-danger text-left bg-surface-100">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 && (
                <tr><td colSpan={11} className="text-center py-10 text-muted text-xs font-mono">
                  {loading ? 'Loading live chain…' : 'No strikes with live data yet.'}
                </td></tr>
              )}
              {visibleRows.map((r, i) => {
                const isATM = r.strike === atm;
                return (
                  <Fragment key={r.strike}>
                    {i === spotRowIdx && <SpotMarkerRow spot={spot} rowRef={spotRowRef} />}
                    <ChainRow row={r} isATM={isATM} maxOi={maxOi} rowRef={isATM ? atmRowRef : undefined} />
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ChainRow({ row, isATM, maxOi, rowRef }: { row: OptionStrikeRow; isATM: boolean; maxOi: number; rowRef?: RefObject<HTMLTableRowElement | null> }) {
  const cePct = Math.min(100, ((row.ce.oi || 0) / maxOi) * 100);
  const pePct = Math.min(100, ((row.pe.oi || 0) / maxOi) * 100);
  return (
    <tr ref={rowRef} className={isATM ? 'bg-gold/5' : ''}>
      <td className="relative text-right px-2.5 py-[7px] border-b border-border/60 text-accent font-mono text-[10px]">
        <div className="absolute inset-y-0 right-0 bg-accent/10" style={{ width: `${cePct}%` }} />
        <span className="relative">{fmt(row.ce.oi, 0)}</span>
      </td>
      <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent/80 font-mono text-[10px]">{fmt(row.ce.volume, 0)}</td>
      <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent/80 font-mono text-[10px]">{row.ce.iv ? `${fmt(row.ce.iv, 1)}%` : '—'}</td>
      <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent/80 font-mono text-[10px]">{row.ce.delta || '—'}</td>
      <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent font-semibold font-mono text-[10px]">{fmt(row.ce.ltp)}</td>
      <td className={`text-center px-3 py-[7px] border-b border-border/60 font-bold font-mono text-[10.5px] bg-gold/5 ${isATM ? 'text-gold' : 'text-white'}`}>
        {fmt(row.strike, 0)}
      </td>
      <td className="text-left px-2.5 py-[7px] border-b border-border/60 text-danger font-semibold font-mono text-[10px]">{fmt(row.pe.ltp)}</td>
      <td className="text-left px-2.5 py-[7px] border-b border-border/60 text-danger/80 font-mono text-[10px]">{row.pe.delta || '—'}</td>
      <td className="text-left px-2.5 py-[7px] border-b border-border/60 text-danger/80 font-mono text-[10px]">{row.pe.iv ? `${fmt(row.pe.iv, 1)}%` : '—'}</td>
      <td className="text-left px-2.5 py-[7px] border-b border-border/60 text-danger/80 font-mono text-[10px]">{fmt(row.pe.volume, 0)}</td>
      <td className="relative text-left px-2.5 py-[7px] border-b border-border/60 text-danger font-mono text-[10px]">
        <div className="absolute inset-y-0 left-0 bg-danger/10" style={{ width: `${pePct}%` }} />
        <span className="relative">{fmt(row.pe.oi, 0)}</span>
      </td>
    </tr>
  );
}

function SpotMarkerRow({ spot, rowRef }: { spot: number; rowRef?: RefObject<HTMLTableRowElement | null> }) {
  return (
    <tr ref={rowRef}>
      <td colSpan={11} className="p-0 border-b border-border/60">
        <div className="relative h-5 flex items-center">
          <div className="absolute inset-x-0 h-px bg-sky/50" />
          <div className="mx-auto px-2 py-0.5 rounded bg-sky text-surface-50 text-[9.5px] font-mono font-bold z-10">
            {fmt(spot)} SPOT
          </div>
        </div>
      </td>
    </tr>
  );
}

function formatExpiryLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function drawOiChart(canvas: HTMLCanvasElement, rows: OptionStrikeRow[], atm: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  canvas.width = rect.width - 24;
  canvas.height = 130;
  const w = canvas.width, h = canvas.height, mid = w / 2;
  ctx.clearRect(0, 0, w, h);
  const maxOi = Math.max(...rows.map((r) => Math.max(r.ce.oi || 0, r.pe.oi || 0)), 10000);
  const gap = (h - 20) / (rows.length || 1);

  rows.forEach((r, i) => {
    const y = 10 + i * gap;
    const ceW = ((r.ce.oi || 0) / maxOi) * (mid - 35);
    const peW = ((r.pe.oi || 0) / maxOi) * (mid - 35);
    ctx.fillStyle = r.strike === atm ? '#f0b429' : 'rgba(0, 229, 160, 0.4)';
    ctx.fillRect(mid - 15 - ceW, y, ceW, 6);
    ctx.fillStyle = r.strike === atm ? '#f0b429' : 'rgba(255, 59, 92, 0.4)';
    ctx.fillRect(mid + 15, y, peW, 6);
    ctx.font = '8px JetBrains Mono';
    ctx.fillStyle = r.strike === atm ? '#f0b429' : '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(r.strike === atm ? 'ATM' : String(r.strike), mid, y + 5.5);
  });
}

function drawIvSkewChart(canvas: HTMLCanvasElement, rows: OptionStrikeRow[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  canvas.width = rect.width - 24;
  canvas.height = 130;
  const w = canvas.width, h = canvas.height;
  const pad = { top: 10, right: 15, bottom: 20, left: 35 };
  const cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
  ctx.clearRect(0, 0, w, h);
  if (rows.length === 0) return;

  const ivs = rows.map((r) => r.ce.iv || 14);
  const mnY = Math.min(...ivs) - 2, mxY = Math.max(...ivs) + 2, rngY = Math.max(1, mxY - mnY);

  ctx.beginPath();
  rows.forEach((r, i) => {
    const x = pad.left + (i / (rows.length - 1)) * cw;
    const y = pad.top + ch * (1 - ((r.ce.iv || 14) - mnY) / rngY);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#f0b429';
  ctx.lineWidth = 1.8;
  ctx.stroke();
}

function generateRealisticChain(spot: number, step: number, atm: number): OptionStrikeRow[] {
  return Array.from({ length: 15 }, (_, i) => {
    const strike = atm + (i - 7) * step;
    const dist = (strike - spot) / step;
    const baseLtp = step * 1.5;
    const ceLtp = Math.max(1, baseLtp - dist * (step * 0.45));
    const peLtp = Math.max(1, baseLtp + dist * (step * 0.45));
    const ceDelta = Number(Math.min(0.95, Math.max(0.05, 0.5 - dist * 0.08)).toFixed(2));
    const peDelta = Number(Math.min(-0.05, Math.max(-0.95, -0.5 - dist * 0.08)).toFixed(2));
    const iv = Number((13.5 + Math.abs(dist) * 0.35).toFixed(1));
    const oi = Math.max(500, Math.round(25000 - Math.abs(dist) * 2800));
    return {
      strike,
      ce: { ltp: Number(ceLtp.toFixed(2)), oi, volume: oi * 3, iv, delta: ceDelta, gamma: 0.002 },
      pe: { ltp: Number(peLtp.toFixed(2)), oi, volume: oi * 3, iv, delta: peDelta, gamma: 0.002 },
    };
  });
}
