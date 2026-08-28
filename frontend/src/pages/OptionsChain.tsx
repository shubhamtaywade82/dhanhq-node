import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { fmt } from '../utils/formatters';
import { RefreshCw } from 'lucide-react';
import type { IndexData } from '../store/types';

export function OptionsChain() {
  const { state, showToast } = useApp();
  const [symbol, setSymbol] = useState('NIFTY');
  const [expiry, setExpiry] = useState('2025-01-30');
  const oiRef = useRef<HTMLCanvasElement>(null);
  const skewRef = useRef<HTMLCanvasElement>(null);

  const idx = state.indices[symbol] ?? state.indices.NIFTY;
  const spot = (idx as IndexData).ltp;
  const step = symbol === 'BANKNIFTY' ? 100 : 50;
  const atm = Math.round(spot / step) * step;

  useEffect(() => {
    if (oiRef.current) drawOiChart(oiRef.current);
    if (skewRef.current) drawIvSkewChart(skewRef.current);
  }, [symbol, spot]);

  const strikes = Array.from({ length: 15 }, (_, i) => atm + (i - 7) * step);

  return (
    <div className="space-y-4">
      <Card className="p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            <option value="NIFTY">NIFTY 50</option>
            <option value="BANKNIFTY">BANK NIFTY</option>
            <option value="FINNIFTY">FIN NIFTY</option>
          </Select>
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="2025-01-30">30 JAN 2025 (Weekly)</option>
            <option value="2025-02-06">06 FEB 2025 (Next)</option>
            <option value="2025-02-27">27 FEB 2025 (Monthly)</option>
          </Select>
          <div className="text-xs font-mono text-muted pl-2 border-l border-border">
            ATM: <span className="text-gold font-bold">{fmt(atm, 0)}</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono text-muted">
          <div>Spot: <span className="text-white font-semibold">{fmt(spot)}</span></div>
          <div>IV Rank: <span className="text-sky font-semibold">42.3</span></div>
          <div>PCR: <span className="text-accent font-semibold">1.12</span></div>
          <div>Max Pain: <span className="text-gold font-semibold">24,200</span></div>
          <Button variant="ghost" className="text-xs py-1" onClick={() => showToast('Options chain refreshed', 'success')}>
            <RefreshCw size={12} /> Refresh
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold flex items-center justify-between">
            <span>Open Interest Distribution (CE vs PE)</span>
            <span className="text-accent text-[9px]">DHAN /v2/optionchain</span>
          </div>
          <canvas ref={oiRef} height={130} className="w-full" />
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold flex items-center justify-between">
            <span>Implied Volatility Smile / Skew</span>
            <span className="text-gold text-[9px]">ATM IV: 13.8%</span>
          </div>
          <canvas ref={skewRef} height={130} className="w-full" />
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px] font-mono">
          <thead>
            <tr>
              <th className="text-right px-2.5 py-2 text-accent font-medium border-b border-border text-[9.5px]">OI (CE)</th>
              <th className="text-right px-2.5 py-2 text-accent font-medium border-b border-border text-[9.5px]">Chg OI</th>
              <th className="text-right px-2.5 py-2 text-accent font-medium border-b border-border text-[9.5px]">Vol</th>
              <th className="text-right px-2.5 py-2 text-accent font-medium border-b border-border text-[9.5px]">IV%</th>
              <th className="text-right px-2.5 py-2 text-accent font-medium border-b border-border text-[9.5px]">Delta</th>
              <th className="text-right px-2.5 py-2 text-accent font-medium border-b border-border text-[9.5px]">Gamma</th>
              <th className="text-right px-2.5 py-2 text-accent font-medium border-b border-border text-[9.5px] font-bold">LTP (CE)</th>
              <th className="text-center px-2.5 py-2 text-gold font-medium border-b border-border text-[9.5px] font-bold">STRIKE</th>
              <th className="text-left px-2.5 py-2 text-danger font-medium border-b border-border text-[9.5px] font-bold">LTP (PE)</th>
              <th className="text-right px-2.5 py-2 text-danger font-medium border-b border-border text-[9.5px]">Gamma</th>
              <th className="text-right px-2.5 py-2 text-danger font-medium border-b border-border text-[9.5px]">Delta</th>
              <th className="text-right px-2.5 py-2 text-danger font-medium border-b border-border text-[9.5px]">IV%</th>
              <th className="text-right px-2.5 py-2 text-danger font-medium border-b border-border text-[9.5px]">Vol</th>
              <th className="text-right px-2.5 py-2 text-danger font-medium border-b border-border text-[9.5px]">Chg OI</th>
              <th className="text-right px-2.5 py-2 text-danger font-medium border-b border-border text-[9.5px]">OI (PE)</th>
            </tr>
          </thead>
          <tbody>
            {strikes.map((strike) => {
              const isATM = strike === atm;
              const isItmCE = strike < spot;
              const isItmPE = strike > spot;
              const dist = strike - spot;
              const ceLTP = Math.max(1, Math.round((spot - strike) * 0.4 + 50 + Math.abs(Math.sin(strike) * 80)));
              const peLTP = Math.max(1, Math.round((strike - spot) * 0.4 + 50 + Math.abs(Math.cos(strike) * 80)));
              const ceOI = Math.round((10000 + Math.abs(Math.sin(strike * 0.1)) * 50000) * (isItmCE ? 1.3 : 0.8));
              const peOI = Math.round((10000 + Math.abs(Math.cos(strike * 0.1)) * 50000) * (isItmPE ? 1.3 : 0.8));
              const ceIV = (12 + Math.abs(dist) / spot * 200 + Math.abs(Math.sin(strike)) * 5).toFixed(1);
              const peIV = (12 + Math.abs(dist) / spot * 200 + Math.abs(Math.cos(strike)) * 5).toFixed(1);
              const ceDelta = Math.max(-1, Math.min(1, 0.5 - (dist / spot) * 8 + Math.sin(strike) * 0.05)).toFixed(2);
              const peDelta = Math.max(-1, Math.min(1, -0.5 + (dist / spot) * 8 + Math.cos(strike) * 0.05)).toFixed(2);
              const ceGamma = Math.abs(0.002 + Math.abs(Math.sin(strike * 0.05)) * 0.003).toFixed(4);
              const peGamma = Math.abs(0.002 + Math.abs(Math.cos(strike * 0.05)) * 0.003).toFixed(4);
              const ceVol = Math.round(500 + Math.abs(Math.sin(strike)) * 5000);
              const peVol = Math.round(500 + Math.abs(Math.cos(strike)) * 5000);

              return (
                <tr key={strike} className={`${isATM ? 'bg-gold/5 border-y border-gold/20' : ''} ${isItmCE ? 'bg-accent/3' : ''} ${isItmPE ? 'bg-danger/3' : ''}`}>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent">{fmt(ceOI, 0)}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent">{Math.round(Math.sin(strike) * 1500)}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent">{fmt(ceVol, 0)}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent">{ceIV}%</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent">{ceDelta}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent">{ceGamma}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-accent font-semibold">{fmt(ceLTP)}</td>
                  <td className={`text-center px-2.5 py-[7px] border-b border-border/60 font-bold ${isATM ? 'text-gold' : 'text-white'}`}>{fmt(strike, 0)}</td>
                  <td className="text-left px-2.5 py-[7px] border-b border-border/60 text-danger font-semibold">{fmt(peLTP)}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-danger">{peGamma}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-danger">{peDelta}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-danger">{peIV}%</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-danger">{fmt(peVol, 0)}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-danger">{Math.round(Math.cos(strike) * 1500)}</td>
                  <td className="text-right px-2.5 py-[7px] border-b border-border/60 text-danger">{fmt(peOI, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function drawOiChart(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  canvas.width = rect.width - 24;
  canvas.height = 130;
  const w = canvas.width;
  const h = canvas.height;
  const mid = w / 2;
  ctx.clearRect(0, 0, w, h);

  const strikes = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
  const barH = 7;
  const gap = (h - 20) / strikes.length;

  strikes.forEach((s, i) => {
    const y = 10 + i * gap;
    const ceOI = Math.round(15000 + Math.abs(Math.sin(i)) * 45000);
    const peOI = Math.round(15000 + Math.abs(Math.cos(i)) * 45000);
    const ceW = (ceOI / 60000) * (mid - 35);
    const peW = (peOI / 60000) * (mid - 35);
    ctx.fillStyle = s === 0 ? '#f0b429' : 'rgba(0, 229, 160, 0.4)';
    ctx.fillRect(mid - 15 - ceW, y, ceW, barH);
    ctx.fillStyle = s === 0 ? '#f0b429' : 'rgba(255, 59, 92, 0.4)';
    ctx.fillRect(mid + 15, y, peW, barH);
    ctx.font = '8.5px JetBrains Mono';
    ctx.fillStyle = s === 0 ? '#f0b429' : '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(s === 0 ? 'ATM' : s > 0 ? `+${s}` : String(s), mid, y + 6.5);
  });

  ctx.strokeStyle = 'rgba(100, 116, 139, 0.2)';
  ctx.beginPath();
  ctx.moveTo(mid, 0);
  ctx.lineTo(mid, h);
  ctx.stroke();
}

function drawIvSkewChart(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  canvas.width = rect.width - 24;
  canvas.height = 130;
  const w = canvas.width;
  const h = canvas.height;
  const pad = { top: 10, right: 15, bottom: 20, left: 35 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  ctx.clearRect(0, 0, w, h);

  const pts = Array.from({ length: 15 }, (_, i) => {
    const m = (i - 7) * 0.5;
    return { x: m, y: 12 + Math.abs(m) * 2.8 + Math.abs(Math.sin(i)) * 1.5 };
  });

  const mnY = 10;
  const mxY = 30;
  const rngY = mxY - mnY;

  ctx.strokeStyle = 'rgba(28, 40, 63, 0.7)';
  for (let i = 0; i <= 3; i++) {
    const y = pad.top + (ch / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.font = '8.5px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(`${fmt(mxY - (rngY / 3) * i, 0)}%`, pad.left - 4, y + 3);
  }

  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = pad.left + ((p.x - pts[0].x) / (pts[pts.length - 1].x - pts[0].x)) * cw;
    const y = pad.top + ch * (1 - (p.y - mnY) / rngY);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#f0b429';
  ctx.lineWidth = 1.8;
  ctx.stroke();
}
