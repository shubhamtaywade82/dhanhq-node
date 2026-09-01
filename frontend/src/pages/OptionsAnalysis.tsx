import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { Badge } from '../components/ui/Badge';
import { fmt, fmtINR, pnlClass } from '../utils/formatters';
import { api } from '../services/api';
import { useApp } from '../store/AppContext';
import { Zap, TrendingUp, Clock, RefreshCw, Activity, Target, Play, Pause, RotateCcw, FastForward } from 'lucide-react';

type BuyingMode = 'STRADDLE' | 'ORB_15M' | 'ORB_30M' | 'ORB_PREM_200' | 'VWAP_RSI' | 'CALL' | 'PUT';

export function OptionsAnalysis() {
  const { showToast } = useApp();
  const [symbol, setSymbol] = useState('NIFTY'), [days, setDays] = useState(5), [interval, setIntervalVal] = useState('1');
  const [buyingMode, setBuyingMode] = useState<BuyingMode>('ORB_15M'), [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null), [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const [entryType, setEntryType] = useState<string>('ORB_15M');
  const [targetPct, setTargetPct] = useState(30), [slPct, setSlPct] = useState(15), [timeExit, setTimeExit] = useState('14:30');

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

  useEffect(() => { runAnalysis(); }, [runAnalysis]);
  const activeDay = data?.days?.[selectedDayIndex] || data?.days?.[0];

  const simResult = useMemo(() => {
    return simulateDayStrategy(activeDay, buyingMode, { entryType, targetPct, slPct, timeExit, symbol });
  }, [activeDay, buyingMode, entryType, targetPct, slPct, timeExit, symbol]);

  const multiDayStats = useMemo(() => {
    if (!data?.days?.length) return null;
    const res = data.days.map((d: any) => simulateDayStrategy(d, buyingMode, { entryType, targetPct, slPct, timeExit, symbol }));
    const wins = res.filter((r: any) => r.pnl > 0).length, totalPnl = res.reduce((s: number, r: any) => s + r.pnl, 0);
    const netInr = res.reduce((s: number, r: any) => s + (r.netPnlInr || 0), 0);
    return { wins, total: res.length, winRate: Number(((wins / res.length) * 100).toFixed(1)), totalPnl: Number(totalPnl.toFixed(2)), netInr: Number(netInr.toFixed(2)), avgPnl: Number((totalPnl / res.length).toFixed(2)) };
  }, [data, buyingMode, entryType, targetPct, slPct, timeExit, symbol]);

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold flex items-center gap-1.5">
            <Activity size={14} className="text-accent" /> DhanHQ Indian Index Options Buying Terminal (SEBI 2026 Specs)
          </div>
          <div className="text-[11px] text-muted mt-0.5">ORB 2:1 Asymmetry, ₹200 ITM Premium Breakout, VWAP+RSI & F&O Friction Engine</div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="text-xs">
            <option value="NIFTY">NIFTY 50 (Lot: 65, Expiry: Tue)</option>
            <option value="BANKNIFTY">BANK NIFTY (Lot: 30, Expiry: M-Tue)</option>
            <option value="SENSEX">BSE SENSEX (Lot: 20, Expiry: Thu)</option>
            <option value="FINNIFTY">FIN NIFTY (Lot: 60)</option>
          </Select>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs">
            <option value={3}>Last 3 Days</option><option value={5}>Last 5 Days</option><option value={10}>Last 10 Days</option>
          </Select>
          <Select value={interval} onChange={(e) => setIntervalVal(e.target.value)} className="text-xs">
            <option value="1">1m Granular</option><option value="5">5m Candle</option><option value="15">15m Candle</option>
          </Select>
          <Button onClick={runAnalysis} disabled={loading}>
            <RefreshCw size={12} className={`mr-1 ${loading ? 'animate-spin' : ''}`} />{loading ? 'Analyzing...' : 'Run Analysis'}
          </Button>
        </div>
      </div>

      <StrategyConfigBar
        mode={buyingMode} onModeChange={setBuyingMode} entryType={entryType} onEntryChange={setEntryType}
        targetPct={targetPct} onTargetChange={setTargetPct} slPct={slPct} onSlChange={setSlPct}
        timeExit={timeExit} onTimeExitChange={setTimeExit} multiStats={multiDayStats} symbol={symbol}
      />
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3.5">
        <DaySelectorCard days={data?.days || []} selectedIndex={selectedDayIndex} onSelect={setSelectedDayIndex} mode={buyingMode} />
        <div className="lg:col-span-3 space-y-3.5">
          <IntradayReplayCard day={activeDay} mode={buyingMode} sim={simResult} />
          <StrikeTableCard day={activeDay} mode={buyingMode} onModeChange={setBuyingMode} />
        </div>
      </div>
      <StrategyInsightsGrid breakEvenPts={data?.summary?.breakEvenMovePts || 110} />
    </div>
  );
}

function StrategyConfigBar({ mode, onModeChange, entryType, onEntryChange, targetPct, onTargetChange, slPct, onSlChange, timeExit, onTimeExitChange, multiStats }: any) {
  return (
    <Card className="p-3 bg-surface-50 border border-border/80 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-1.5">
        <div className="flex flex-wrap items-center gap-1.5 bg-surface-200 p-0.5 rounded border border-border">
          {[
            { id: 'ORB_15M', label: '🚀 15m Spot ORB (2:1)' },
            { id: 'ORB_30M', label: '🎯 30m Spot ORB' },
            { id: 'ORB_PREM_200', label: '💎 ₹200 ITM Premium ORB' },
            { id: 'VWAP_RSI', label: '🌊 VWAP+RSI Pullback' },
            { id: 'STRADDLE', label: '⚡ ATM Straddle' },
            { id: 'CALL', label: '📈 Naked CE Buy' },
            { id: 'PUT', label: '📉 Naked PE Buy' },
          ].map((m) => (
            <button key={m.id} onClick={() => { onModeChange(m.id as any); onEntryChange(m.id); }} className={`px-2.5 py-0.5 rounded text-[9px] font-mono font-semibold transition-all ${mode === m.id ? 'bg-accent/20 text-accent border border-accent/40' : 'text-muted hover:text-white'}`}>
              {m.label}
            </button>
          ))}
        </div>
        {multiStats && (
          <div className="text-[9.5px] font-mono text-muted flex items-center gap-2">
            <span>Win Rate: <strong className={multiStats.winRate >= 45 ? 'text-accent' : 'text-danger'}>{multiStats.winRate}%</strong> ({multiStats.wins}/{multiStats.total})</span>
            <span>Gross: <strong className={pnlClass(multiStats.totalPnl)}>{multiStats.totalPnl >= 0 ? '+' : ''}{multiStats.totalPnl} pts</strong></span>
            <span>Net (post STT/fees): <strong className={pnlClass(multiStats.netInr)}>{fmtINR(multiStats.netInr)}</strong></span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
        <div><label className="text-[8.5px] text-muted uppercase block mb-0.5 font-semibold">1. Entry Trigger</label><Select value={entryType} onChange={(e) => onEntryChange(e.target.value as any)} className="text-xs w-full"><option value="ORB_15M">15m ORB (09:15-09:30)</option><option value="ORB_30M">30m ORB (09:15-09:45)</option><option value="ORB_PREM_200">11:15 ₹200 Premium Range</option><option value="VWAP_RSI">VWAP Sloping Pullback</option><option value="OPEN_915">09:15 Open Entry</option></Select></div>
        <div><label className="text-[8.5px] text-accent uppercase block mb-0.5 font-semibold">2. Target Profit</label><Select value={targetPct} onChange={(e) => onTargetChange(Number(e.target.value))} className="text-xs w-full"><option value={20}>+20% (1.5:1 R:R)</option><option value={30}>+30% (2:1 Standard)</option><option value={50}>+50% (3:1 Runner)</option><option value={0}>Hold to EOD</option></Select></div>
        <div><label className="text-[8.5px] text-danger uppercase block mb-0.5 font-semibold">3. Stop Loss</label><Select value={slPct} onChange={(e) => onSlChange(Number(e.target.value))} className="text-xs w-full"><option value={15}>-15% Tight Stop</option><option value={20}>-20% Zerodha Standard</option><option value={30}>-30% Wide Stop</option><option value={0}>None</option></Select></div>
        <div><label className="text-[8.5px] text-gold uppercase block mb-0.5 font-semibold">4. Time Exit</label><Select value={timeExit} onChange={(e) => onTimeExitChange(e.target.value)} className="text-xs w-full"><option value="14:30">2:30 PM (Pre-Theta)</option><option value="13:30">1:30 PM (Midday)</option><option value="15:15">3:15 PM (Intraday Close)</option></Select></div>
      </div>
    </Card>
  );
}

function DaySelectorCard({ days, selectedIndex, onSelect, mode }: { days: any[]; selectedIndex: number; onSelect: (idx: number) => void; mode: BuyingMode }) {
  return (
    <Card className="p-3">
      <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-2 font-semibold">Trading Days</div>
      <div className="space-y-1.5">
        {days.map((d, i) => {
          const isSelected = i === selectedIndex, isBlast = d.regime === 'GAMMA_BLAST', isTrap = d.regime === 'THETA_TRAP';
          const atm = d.strikes?.find((s: any) => s.label === 'ATM') || d.strikes?.[0] || {};
          const pnl = mode === 'STRADDLE' ? d.atmStraddlePnl : (mode === 'CALL' ? (atm.call?.pnl ?? 0) : (atm.put?.pnl ?? 0));
          return (
            <div key={d.date} onClick={() => onSelect(i)} className={`p-2 rounded-lg cursor-pointer transition-all border ${isSelected ? 'bg-accent/10 border-accent/40' : 'bg-surface-50 border-border hover:bg-surface-200/50'}`}>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs font-semibold text-white">{d.date} <span className="text-muted font-normal text-[9.5px]">({d.dayOfWeek})</span></span>
                <span className={`text-[8.5px] font-mono px-1 py-0.2 rounded font-semibold ${isBlast ? 'bg-accent/20 text-accent' : isTrap ? 'bg-danger/20 text-danger' : 'bg-gold/20 text-gold'}`}>{isBlast ? '🚀 BLAST' : isTrap ? '⏳ THETA' : '⚖️ RANGE'}</span>
              </div>
              <div className="flex items-center justify-between text-[9.5px] font-mono"><span className="text-muted">Spot: {fmt(d.spot?.change || 0)} pts</span><span className={pnlClass(pnl)}>{pnl >= 0 ? `+${fmt(pnl)}` : fmt(pnl)} pts</span></div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function IntradayReplayCard({ day, mode, sim }: { day: any; mode: BuyingMode; sim: any }) {
  const [replayIdx, setReplayIdx] = useState(0), [isPlaying, setIsPlaying] = useState(false), [speed, setSpeed] = useState(3);
  const timerRef = useRef<any>(null), timeline = day?.timeline || [], maxIdx = Math.max(0, timeline.length - 1);
  const curPoint = timeline[Math.min(replayIdx, maxIdx)] || {}, atm = day?.strikes?.find((s: any) => s.label === 'ATM') || day?.strikes?.[0] || {};
  const baseSpot = day?.spot?.open || curPoint.spot || 1, spotDelta = Number(((curPoint.spot || baseSpot) - baseSpot).toFixed(1));
  const curPrem = mode === 'CALL' ? (curPoint.ce || atm.call?.open || 1) : (mode === 'PUT' ? (curPoint.pe || atm.put?.open || 1) : (curPoint.straddle || (atm.call?.open + atm.put?.open) || 1));
  const entryPrice = sim?.entryPrice || 1, livePnl = Number((curPrem - entryPrice).toFixed(2)), liveRoi = Number(((livePnl / entryPrice) * 100).toFixed(1));

  useEffect(() => { setReplayIdx(maxIdx); setIsPlaying(false); }, [day, maxIdx]);
  useEffect(() => {
    if (isPlaying) {
      timerRef.current = setInterval(() => { setReplayIdx((p) => { if (p >= maxIdx) { setIsPlaying(false); return maxIdx; } return p + 1; }); }, Math.max(150, 800 / speed));
    } else clearInterval(timerRef.current);
    return () => clearInterval(timerRef.current);
  }, [isPlaying, speed, maxIdx]);

  return (
    <Card className="p-3.5 bg-surface-50 border border-border/80 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex items-center gap-2">
          <Target size={13} className="text-accent" />
          <span className="text-xs font-bold text-white uppercase">1m Replay Player</span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-accent/15 text-accent font-semibold">🕒 {curPoint.time || '15:30'}</span>
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-bold ${sim?.status === 'TARGET_HIT' ? 'bg-accent/20 text-accent' : sim?.status === 'SL_HIT' ? 'bg-danger/20 text-danger' : 'bg-gold/20 text-gold'}`}>{sim?.reason}</span>
        </div>
        <div className="flex items-center gap-1 bg-surface-200 p-1 rounded border border-border/60">
          <button onClick={() => { setIsPlaying(false); setReplayIdx(0); }} className="px-2 py-0.5 rounded text-[9px] font-mono text-muted hover:text-white flex items-center"><RotateCcw size={10} className="mr-1" />09:15</button>
          <button onClick={() => { if (!isPlaying && replayIdx >= maxIdx) setReplayIdx(0); setIsPlaying(!isPlaying); }} className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold flex items-center ${isPlaying ? 'text-danger' : 'text-accent'}`}>{isPlaying ? <Pause size={10} className="mr-1" /> : <Play size={10} className="mr-1" />}{isPlaying ? 'Pause' : 'Replay'}</button>
          <button onClick={() => { setIsPlaying(false); setReplayIdx(maxIdx); }} className="px-2 py-0.5 rounded text-[9px] font-mono text-muted hover:text-white flex items-center"><FastForward size={10} className="mr-1" />EOD</button>
          {[1, 3, 5].map((s) => (<button key={s} onClick={() => setSpeed(s)} className={`px-1 py-0.5 rounded text-[8.5px] font-mono ${speed === s ? 'bg-accent text-black font-bold' : 'text-muted hover:text-white'}`}>{s}x</button>))}
        </div>
      </div>
      <input type="range" min={0} max={maxIdx} value={replayIdx} onChange={(e) => { setIsPlaying(false); setReplayIdx(Number(e.target.value)); }} className="w-full h-1.5 bg-surface-300 rounded-lg appearance-none cursor-pointer accent-accent" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center font-mono">
        <div className="bg-surface-200/80 p-1.5 rounded border border-border/50">
          <div className="text-[8.5px] text-muted uppercase">Spot at {curPoint.time || '09:15'}</div>
          <div className="text-xs font-bold text-white">{fmt(curPoint.spot || baseSpot)}</div>
          <div className={`text-[8.5px] ${pnlClass(spotDelta)}`}>{spotDelta >= 0 ? `+${fmt(spotDelta)}` : fmt(spotDelta)} pts</div>
        </div>
        <div className="bg-surface-200/80 p-1.5 rounded border border-border/50">
          <div className="text-[8.5px] text-accent uppercase">Entry ({sim?.entryTime})</div>
          <div className="text-xs font-bold text-white">₹{fmt(sim?.entryPrice)}</div>
          <div className="text-[8.5px] text-muted">Baseline</div>
        </div>
        <div className="bg-surface-200/80 p-1.5 rounded border border-border/50">
          <div className="text-[8.5px] text-gold uppercase">Exit ({sim?.exitTime})</div>
          <div className="text-xs font-bold text-white">₹{fmt(sim?.exitPrice)}</div>
          <div className={`text-[8.5px] font-bold ${pnlClass(sim?.pnl)}`}>{sim?.pnl >= 0 ? '+' : ''}{sim?.pnl} pts ({sim?.roi}%)</div>
        </div>
        <div className="bg-surface-200/80 p-1.5 rounded border border-border/50">
          <div className="text-[8.5px] text-white uppercase">Live Premium P&L</div>
          <div className="text-xs font-bold text-white">₹{fmt(curPrem)}</div>
          <div className={`text-[8.5px] font-bold ${pnlClass(livePnl)}`}>{livePnl >= 0 ? '+' : ''}{livePnl} pts ({liveRoi}%)</div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[9.5px] font-mono text-center pt-1 border-t border-border/40">
        <div className="text-muted">Peak Profit: <strong className="text-accent">+{sim?.maxProfitRoi}% (+{sim?.maxProfit} pts)</strong></div>
        <div className="text-muted">Max Drawdown: <strong className="text-danger">{sim?.maxDrawdownRoi}% ({sim?.maxDrawdown} pts)</strong></div>
        <div className="text-muted">ORB Range: <strong className="text-white">{fmt(sim?.orbHigh)} - {fmt(sim?.orbLow)}</strong></div>
        <div className="text-muted">Result: <strong className={pnlClass(sim?.pnl)}>{sim?.pnl >= 0 ? 'PROFIT' : 'LOSS'}</strong></div>
      </div>
    </Card>
  );
}

function simulateDayStrategy(day: any, mode: BuyingMode, cfg: any) {
  if (!day) return { entryTime: '09:15', entryPrice: 0, exitTime: '15:30', exitPrice: 0, pnl: 0, roi: 0, netPnlInr: 0, maxProfit: 0, maxProfitRoi: 0, maxDrawdown: 0, maxDrawdownRoi: 0, orbHigh: 0, orbLow: 0, status: 'EOD', reason: 'No Data' };
  const timeline = day.timeline || [], atm = day.strikes?.find((s: any) => s.label === 'ATM') || day.strikes?.[0] || {};
  if (!timeline.length) return { entryTime: '09:15', entryPrice: 0, exitTime: '15:30', exitPrice: 0, pnl: 0, roi: 0, netPnlInr: 0, maxProfit: 0, maxProfitRoi: 0, maxDrawdown: 0, maxDrawdownRoi: 0, orbHigh: 0, orbLow: 0, status: 'EOD', reason: 'No Timeline' };

  const isOrb = mode === 'ORB_15M' || mode === 'ORB_30M' || mode === 'ORB_PREM_200' || cfg.entryType?.includes('ORB');
  const rangeBars = mode === 'ORB_30M' ? 30 : 15;
  const orbCandles = timeline.slice(0, Math.min(rangeBars, timeline.length));
  const orbHigh = Math.max(...orbCandles.map((c: any) => c.spot || 0)), orbLow = Math.min(...orbCandles.map((c: any) => c.spot || Infinity));

  let entryIdx = 0, dir: 'CALL' | 'PUT' | 'BOTH' = mode === 'CALL' ? 'CALL' : (mode === 'PUT' ? 'PUT' : 'BOTH');
  if (isOrb && timeline.length > rangeBars) {
    for (let i = rangeBars; i < timeline.length; i++) {
      if (timeline[i].spot > orbHigh) { entryIdx = i; dir = 'CALL'; break; }
      if (timeline[i].spot < orbLow) { entryIdx = i; dir = 'PUT'; break; }
    }
  }

  const entryCandle = timeline[entryIdx] || timeline[0] || {};
  const ceBase = atm.call?.open || 1, peBase = atm.put?.open || 1;
  const isCall = dir === 'CALL' || mode === 'CALL';
  const isPut = dir === 'PUT' || mode === 'PUT';
  const entryPrice = isCall ? (entryCandle.ce || ceBase) : (isPut ? (entryCandle.pe || peBase) : (entryCandle.straddle || ceBase + peBase));
  let exitIdx = timeline.length - 1, reason = '🔔 EOD 15:30', status = 'EOD', maxHigh = entryPrice, minLow = entryPrice;

  for (let i = entryIdx; i < timeline.length; i++) {
    const pt = timeline[i];
    const curHigh = isCall ? (pt.ceHigh || pt.ce) : (isPut ? (pt.peHigh || pt.pe) : (pt.straddleHigh || pt.straddle));
    const curLow = isCall ? (pt.ceLow || pt.ce) : (isPut ? (pt.peLow || pt.pe) : (pt.straddleLow || pt.straddle));
    if (curHigh > maxHigh) maxHigh = curHigh;
    if (curLow < minLow) minLow = curLow;
    if (cfg.targetPct > 0 && curHigh >= entryPrice * (1 + cfg.targetPct / 100)) { exitIdx = i; reason = `🎯 Target +${cfg.targetPct}% Hit`; status = 'TARGET_HIT'; break; }
    if (cfg.slPct > 0 && curLow <= entryPrice * (1 - cfg.slPct / 100)) { exitIdx = i; reason = `🛑 Stop Loss -${cfg.slPct}% Hit`; status = 'SL_HIT'; break; }
    if (pt.time >= cfg.timeExit) { exitIdx = i; reason = `🕒 Time Exit ${cfg.timeExit}`; status = 'TIME_EXIT'; break; }
  }

  const exitCandle = timeline[exitIdx] || timeline[timeline.length - 1] || {};
  const exitPrice = (isCall ? exitCandle.ce : (isPut ? exitCandle.pe : exitCandle.straddle)) || entryPrice;
  const ep = entryPrice || 1, pnl = Number((exitPrice - ep).toFixed(2)), roi = Number(((pnl / ep) * 100).toFixed(1));

  const lotSize = cfg.symbol === 'SENSEX' ? 20 : (cfg.symbol === 'BANKNIFTY' ? 30 : (cfg.symbol === 'FINNIFTY' ? 60 : 65));
  const grossInr = pnl * lotSize;
  const friction = (exitPrice * lotSize * 0.0010) + 40 + ((ep + exitPrice) * lotSize * 0.0025);
  const netPnlInr = Number((grossInr - friction).toFixed(2));

  return {
    entryTime: entryCandle.time || '09:15', entryPrice: Number(ep.toFixed(2)),
    exitTime: exitCandle.time || '15:30', exitPrice: Number(exitPrice.toFixed(2)),
    pnl, roi, netPnlInr, maxProfit: Number((maxHigh - ep).toFixed(2)), maxProfitRoi: Number((((maxHigh - ep) / ep) * 100).toFixed(1)),
    maxDrawdown: Number((minLow - ep).toFixed(2)), maxDrawdownRoi: Number((((minLow - ep) / ep) * 100).toFixed(1)),
    orbHigh, orbLow, status, reason, direction: dir,
  };
}

function StrikeTableCard({ day, mode }: { day: any; mode: BuyingMode; onModeChange?: any }) {
  if (!day) return <Card className="p-6 text-center text-muted text-xs">Select a day to view strike breakdown.</Card>;
  const spot = day.spot || {};
  return (
    <Card className="p-3.5 overflow-x-auto space-y-2">
      <div className="text-xs font-mono text-muted border-b border-border pb-1.5"><strong className="text-white mr-1.5">{day.date} ({day.dayOfWeek})</strong> Spot: <strong className="text-white">{fmt(spot.open)}</strong> → <strong className="text-white">{fmt(spot.close)}</strong> (<strong className={spot.change >= 0 ? 'text-accent' : 'text-danger'}>{spot.change >= 0 ? '+' : ''}{fmt(spot.change)} pts</strong>)</div>
      <table className="data-table w-full text-[9.5px] font-mono">
        <thead><tr>{['Strike', 'Entry (09:15)', '1m Peak High', '1m Low', '1:30 PM Exit', 'EOD Close', 'Net P&L', 'ROI%', 'Status'].map((h) => (<th key={h} className="text-left px-2 py-1 text-muted border-b border-border uppercase text-[8.5px]">{h}</th>))}</tr></thead>
        <tbody>
          {(day.strikes || []).map((s: any) => {
            const isAtm = s.label === 'ATM' || s.strike === 'ATM', leg = mode === 'CALL' ? s.call : (mode === 'PUT' ? s.put : s.straddle);
            const open = mode === 'STRADDLE' ? leg.totalPremium : leg.open, close = mode === 'STRADDLE' ? open + leg.netPnl : leg.close;
            const high = mode === 'STRADDLE' ? (s.straddleMaxHigh || open * 1.25) : (leg.high || open), low = mode === 'STRADDLE' ? (s.straddleMaxLow || open * 0.85) : (leg.low || open);
            const pnl = mode === 'STRADDLE' ? leg.netPnl : leg.pnl, roi = mode === 'STRADDLE' ? leg.netRoi : leg.roi;
            const exit130 = mode === 'STRADDLE' ? open + (leg.exit130Net || 0) : (leg.exit130 || close);
            return (
              <tr key={s.label || s.strike} className={`hover:bg-surface-200/50 ${isAtm ? 'bg-accent/5 font-semibold' : ''}`}>
                <td className="px-2 py-1 border-b border-border/60 text-white whitespace-nowrap"><span className="font-bold">{typeof s.strike === 'number' ? fmt(s.strike, 0) : s.strike}</span>{s.label && <span className={`ml-1 text-[8px] px-1 py-0.2 rounded ${isAtm ? 'bg-gold/20 text-gold font-bold' : 'bg-surface-300 text-muted'}`}>{s.label}</span>}{isAtm && ' ⭐'}</td>
                <td className="px-2 py-1 border-b border-border/60 text-muted">{fmt(open)}</td><td className="px-2 py-1 border-b border-border/60 text-accent font-semibold">{fmt(high)}</td><td className="px-2 py-1 border-b border-border/60 text-danger">{fmt(low)}</td>
                <td className="px-2 py-1 border-b border-border/60 text-white">{fmt(exit130)}</td><td className="px-2 py-1 border-b border-border/60 text-white">{fmt(close)}</td>
                <td className={`px-2 py-1 border-b border-border/60 font-bold ${pnlClass(pnl)}`}>{pnl >= 0 ? '+' : ''}{fmt(pnl)} pts</td><td className={`px-2 py-1 border-b border-border/60 font-bold ${pnlClass(roi)}`}>{roi >= 0 ? '+' : ''}{fmt(roi)}%</td>
                <td className="px-2 py-1 border-b border-border/60"><Badge status={leg.status === 'PROFIT' ? 'TRADED' : 'REJECTED'} /></td>
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
    { title: '1. DhanHQ 1m Replay', icon: <Activity size={13} className="text-accent" />, desc: '09:15 to 15:30 playback of spot moves, option prices, and live strike shift.' },
    { title: '2. Swing Highs & Reactions', icon: <Zap size={13} className="text-accent" />, desc: 'Detects pivot reversals and shows whether morning peak gains dissolved in afternoon chop.' },
    { title: '3. 1:30 PM Checkpoint Rule', icon: <Clock size={13} className="text-gold" />, desc: 'Exiting long options at 1:30 PM avoids the post-lunch accelerated theta collapse.' },
    { title: '4. Strike Selection Efficiency', icon: <TrendingUp size={13} className="text-sky" />, desc: `On breakout moves > ${breakEvenPts} pts, percentage return of OTM strikes outperforms ATM.` },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2.5">
      {insights.map((item) => (<Card key={item.title} className="p-3 bg-surface-50 border border-border"><div className="flex items-center gap-1.5 text-xs font-semibold text-white mb-1">{item.icon}<span>{item.title}</span></div><p className="text-[9.5px] text-muted leading-relaxed">{item.desc}</p></Card>))}
    </div>
  );
}
