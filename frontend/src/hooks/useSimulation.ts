import { useEffect, useRef } from 'react';
import { useApp } from '../store/AppContext';
import type { AppState } from '../store/types';

function initPnlHistory(): number[] {
  const arr: number[] = [];
  let pnl = 0;
  for (let i = 0; i < 120; i++) {
    pnl += (Math.random() - 0.42) * 800;
    arr.push(Math.round(pnl));
  }
  arr[arr.length - 1] = 24850;
  return arr;
}

function simulateTick(state: AppState): Partial<AppState> {
  const newIndices = { ...state.indices };
  Object.keys(newIndices).forEach((sym) => {
    const idx = { ...newIndices[sym] };
    const delta = (Math.random() - 0.49) * 4;
    idx.ltp = Math.max(1, idx.ltp + delta);
    idx.change += delta;
    idx.pct = (idx.change / (idx.ltp - idx.change)) * 100;
    newIndices[sym] = idx;
  });

  const newStrategies = state.strategies.map((s) => {
    if (s.status === 'STOPPED') return s;
    const legs = s.legs.map((l) => ({
      ...l,
      ltp: Math.max(0.5, l.ltp + (Math.random() - 0.48) * 2.5),
    }));
    const pnl = legs.reduce(
      (total, l) => total + (l.ltp - (l.bAvg || l.sAvg || l.ltp)) * l.qty * (l.side === 'SELL' ? -1 : 1),
      0,
    );
    return { ...s, legs, pnl };
  });

  const totalPnl = newStrategies.reduce((sum, s) => sum + s.pnl, 0);
  const newPnlHistory = [...state.pnlHistory, Math.round(totalPnl)];
  if (newPnlHistory.length > 180) newPnlHistory.shift();

  return { indices: newIndices, strategies: newStrategies, pnlHistory: newPnlHistory };
}

const LOG_TEMPLATES = [
  { lv: 'INFO', msg: 'Redis GET ltp:NIFTY24JAN24250CE → 198.20 (0.3ms)', src: 'redis' },
  { lv: 'INFO', msg: 'OrderMonitorWorker: ORD-240128-006 still in :acknowledged state', src: 'sidekiq' },
  { lv: 'TRADE', msg: 'Straddle MTM recalculated via PnlCalculationWorker: +12,450 INR', src: 'sidekiq' },
  { lv: 'INFO', msg: 'ActionCable broadcasting to positions channel: 8 active legs', src: 'action_cable' },
  { lv: 'INFO', msg: 'ActiveRecord: Position Load (0.8ms) SELECT * FROM positions', src: 'activerecord' },
  { lv: 'INFO', msg: 'Delta neutralization check: Portfolio delta +0.03 — tolerance PASS', src: 'risk_engine' },
  { lv: 'INFO', msg: 'HealthCheck endpoint: PG=8ms, Redis=0.4ms, Puma=5thr', src: 'system' },
];

export function useSimulation() {
  const { setState, addSystemLog } = useApp();
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    setState((prev) => ({ ...prev, pnlHistory: initPnlHistory() }));

    const tickInterval = setInterval(() => {
      setState((prev) => {
        if (!prev.live || prev.killed) return prev;
        return { ...prev, ...simulateTick(prev) };
      });
    }, 1500);

    const logInterval = setInterval(() => {
      setState((prev) => {
        if (!prev.live || prev.killed) return prev;
        const t = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
        const id = prev.logIdCounter + 1;
        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const reqId = `req_${Math.random().toString(36).substring(2, 8)}`;
        const logs = [...prev.logs, { id, time, level: t.lv, message: t.msg, source: t.src, reqId }];
        return { ...prev, logs: logs.length > 400 ? logs.slice(-400) : logs, logIdCounter: id };
      });
    }, 3500);

    const uptimeInterval = setInterval(() => {
      setState((prev) => ({ ...prev, uptimeSeconds: prev.uptimeSeconds + 1 }));
    }, 1000);

    addSystemLog('SYSTEM', 'Axis Nexus Trading Control Plane booted', 'rails');
    addSystemLog('INFO', 'Puma 6.4.2 started with 2 workers', 'puma');
    addSystemLog('INFO', 'Sidekiq 7.2.1 active with concurrency=25', 'sidekiq');
    addSystemLog('INFO', 'DhanHQ API connected (18ms latency)', 'broker');
    addSystemLog('INFO', 'Ollama LLM connected (llama3.1:8b)', 'ollama');
    addSystemLog('INFO', 'Risk engine initialized: 8 circuit breakers', 'risk_engine');

    return () => {
      clearInterval(tickInterval);
      clearInterval(logInterval);
      clearInterval(uptimeInterval);
    };
  }, [setState, addSystemLog]);
}
