import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AppState, ToastType } from './types';
import { initialAppState } from '../utils/mockData';
import { api } from '../services/api';
import { useBackendStream, type Envelope } from '../hooks/useBackendStream';

interface Toast {
  id: number;
  msg: string;
  type: ToastType;
}

interface AppContextValue {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  showToast: (msg: string, type?: ToastType) => void;
  openModal: (content: ReactNode) => void;
  closeModal: () => void;
  toasts: Toast[];
  modalContent: ReactNode | null;
  addSystemLog: (level: string, message: string, source?: string) => void;
  refreshPortfolio: () => Promise<void>;
  refreshControlState: () => Promise<void>;
  connected: boolean;        // backend HTTP reachable
  streamConnected: boolean;  // backend WS stream live
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialAppState);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modalContent, setModalContent] = useState<ReactNode | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const toastIdRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshPortfolio = useCallback(async () => {
    try {
      const [positions, orders, funds, strategies] = await Promise.all([
        api.positions().catch(() => null),
        api.orders().catch(() => null),
        api.funds().catch(() => null),
        api.strategies().catch(() => null),
      ]);
      setState((prev) => ({
        ...prev,
        positions: Array.isArray(positions) ? positions : prev.positions,
        orders: Array.isArray(orders) ? orders : prev.orders,
        funds: typeof funds === 'object' && funds !== null ? { ...prev.funds, ...funds } : prev.funds,
        strategies: Array.isArray(strategies) ? strategies : prev.strategies,
      }));
    } catch {
      // Ignore background sync errors
    }
  }, []);

  const refreshControlState = useCallback(async () => {
    try {
      const [ctrl, alerts, health] = await Promise.all([
        api.controlState().catch(() => null),
        api.alerts(50).catch(() => null),
        api.health().catch(() => null),
      ]);
      if (ctrl) {
        setState((prev) => ({
          ...prev,
          killed: !!ctrl.risk?.killed,
          live: !ctrl.risk?.killed,
          circuitBreakers: (ctrl.risk?.breakers || []).map((b: any) => ({
            rule: b.rule, threshold: b.threshold, current: b.current, state: b.state, action: b.action,
          })),
          agentStatus: ctrl.agent?.personas || prev.agentStatus,
          agentRunning: !!ctrl.agent?.running,
          marketSource: ctrl.market?.source || prev.marketSource,
          marketWsConnected: !!ctrl.market?.wsConnected,
          marketTickAgeSec: ctrl.market?.tickAgeSec ?? null,
          llmMode: ctrl.agent?.llm || prev.llmMode,
          persistence: health?.persistence || prev.persistence,
        }));
      }
      if (Array.isArray(alerts)) {
        setState((prev) => ({ ...prev, alerts: alerts.map((a: any) => ({ id: a.id, time: a.time, level: a.level, msg: a.msg, read: a.read ?? false })) }));
      }
    } catch {
      // Ignore
    }
  }, []);

  const refreshIndices = useCallback(async () => {
    try {
      const res = await api.indices();
      const clean = Object.fromEntries(Object.entries(res?.indices || {}).filter(([, v]) => v != null));
      if (Object.keys(clean).length > 0) {
        setState((prev) => ({ ...prev, indices: clean as any }));
      }
    } catch {
      // Backend returns honest empties when no live data — keep previous
    }
  }, []);

  const addSystemLog = useCallback((level: string, message: string, source = 'system') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const reqId = `req_${Math.random().toString(36).substring(2, 8)}`;
    setState((prev) => {
      const logs = [...prev.logs, { id, time, level, message, source, reqId }];
      return { ...prev, logs: logs.length > 400 ? logs.slice(-400) : logs };
    });
  }, []);

  // ── boot: REST snapshot, then WS telemetry ─────────────────────────
  useEffect(() => {
    let mounted = true;

    async function boot() {
      try {
        const health = await api.health();
        if (!mounted) return;
        setConnected(true);
        setState((prev) => ({
          ...prev,
          killed: !!health.killed,
          live: !health.killed,
          uptimeSeconds: Math.floor(health.uptime || 0),
        }));
      } catch {
        if (mounted) setConnected(false);
      }

      await Promise.all([
        refreshIndices(),
        refreshPortfolio(),
        refreshControlState(),
      ]);
    }

    boot();

    // Continuous background sync keeps orders, strategies, and control state fresh.
    const interval = setInterval(async () => {
      try {
        if (!streamConnectedRef.current) {
          await refreshIndices();
        }
        await Promise.all([refreshPortfolio(), refreshControlState()]);
      } catch {
        /* noop */
      }
    }, 4000);

    // Uptime ticker — sourced from backend health (real process uptime).
    const uptimeInterval = setInterval(async () => {
      try {
        const health = await api.health();
        if (mounted) {
          setConnected(true);
          setState((prev) => {
            const unrealized = prev.positions.reduce((acc, p) => acc + (p.unrealizedProfit || p.unrealizedPnl || 0), 0);
            const totalPnl = (prev.funds.realizedPnl || 0) + unrealized;
            const pnlHistory = [...prev.pnlHistory, Math.round(totalPnl)];
            if (pnlHistory.length > 180) pnlHistory.shift();
            return {
              ...prev,
              uptimeSeconds: Math.floor(health.uptime || prev.uptimeSeconds + 2),
              killed: !!health.killed,
              pnlHistory,
            };
          });
        }
      } catch {
        if (mounted) setConnected(false);
      }
    }, 2000);

    return () => {
      mounted = false;
      clearInterval(interval);
      clearInterval(uptimeInterval);
    };
  }, [refreshIndices, refreshPortfolio, refreshControlState]);

  const streamConnectedRef = useRef(false);
  streamConnectedRef.current = streamConnected;

  // ── WS envelope dispatch ────────────────────────────────────────────
  const onEnvelope = useCallback((env: Envelope) => {
    switch (env.channel) {
      case 'tick': {
        const p = env.payload || {};
        const ltp = p.data?.ltp;
        if (ltp == null) break;

        setState((prev) => {
          const nextIndices = p.symbol ? {
            ...prev.indices,
            [p.symbol]: {
              ltp,
              change: p.data.change ?? 0,
              pct: p.data.pctChange ?? 0,
              high: p.data.high ?? 0,
              low: p.data.low ?? 0,
              open: p.data.open ?? 0,
              prevClose: p.data.prevClose ?? 0,
              spot: ltp,
            },
          } : prev.indices;

          const nextPositions = p.securityId ? prev.positions.map((pos) => {
            if (String(pos.securityId) === String(p.securityId)) {
              const avg = Number(pos.buyAvg || pos.avgPrice || pos.sAvg || ltp);
              const qty = Number(pos.netQty || pos.qty || 0);
              const pnl = Number(((ltp - avg) * qty).toFixed(2));
              return { ...pos, ltp, pnl };
            }
            return pos;
          }) : prev.positions;

          return { ...prev, indices: nextIndices, positions: nextPositions };
        });
        break;
      }
      case 'log': {
        const p = env.payload || {};
        setState((prev) => {
          const id = env.ts + prev.logIdCounter;
          const logs = [...prev.logs, { id, time: p.time || new Date().toLocaleTimeString('en-GB', { hour12: false }), level: p.level || 'INFO', message: p.message || '', source: p.source || 'system', reqId: p.reqId || '-' }];
          return { ...prev, logs: logs.length > 400 ? logs.slice(-400) : logs, logIdCounter: prev.logIdCounter + 1 };
        });
        break;
      }
      case 'alert': {
        const p = env.payload || {};
        setState((prev) => {
          const alert = { id: env.ts + prev.alertIdCounter, time: new Date().toLocaleTimeString('en-GB', { hour12: false }), level: p.level || 'INFO', msg: p.msg || p.message || '', read: false };
          const alerts = [...prev.alerts, alert];
          return { ...prev, alerts: alerts.length > 200 ? alerts.slice(-200) : alerts, alertIdCounter: prev.alertIdCounter + 1 };
        });
        break;
      }
      case 'telemetry': {
        const p = env.payload || {};
        setState((prev) => ({
          ...prev,
          telemetryEvents: [...prev.telemetryEvents.slice(-399), {
            id: p.id || `ev_${env.ts}`,
            agent: p.agent || 'planner',
            type: p.type || 'ACT',
            time: p.time || new Date().toLocaleTimeString('en-GB', { hour12: false }),
            summary: p.summary,
            tool: p.tool,
            response: p.response,
            duration: p.duration,
          }],
          agentTokens: prev.agentTokens + Math.ceil((p.summary || '').length / 4),
          agentDhanCalls: prev.agentDhanCalls + (p.tool ? 1 : 0),
        }));
        break;
      }
      case 'risk': {
        const p = env.payload || {};
        setState((prev) => ({
          ...prev,
          killed: !!p.killed,
          live: !p.killed,
          circuitBreakers: (p.breakers || []).map((b: any) => ({
            rule: b.rule, threshold: b.threshold, current: b.current, state: b.state, action: b.action,
          })),
        }));
        break;
      }
      case 'portfolio': {
        const p = env.payload || {};
        if (p.positions) {
          setState((prev) => ({
            ...prev,
            positions: p.positions,
            funds: p.funds ? { ...prev.funds, ...p.funds } : prev.funds,
          }));
        }
        break;
      }
      case 'order': {
        const p = env.payload || {};
        if (p.kind === 'fill') {
          void refreshPortfolio();
          void refreshControlState();
        }
        break;
      }
      case 'system': {
        const p = env.payload || {};
        if (p.type === 'connected' || p.type === 'pong') break;
        if (p.type === 'kill_switch') {
          setState((prev) => ({ ...prev, killed: p.state === 'ENGAGED', live: p.state !== 'ENGAGED' }));
          void refreshPortfolio();
          void refreshControlState();
        } else if (p.type === 'agent_run_complete') {
          setState((prev) => ({ ...prev, agentRunning: false }));
          void refreshPortfolio();
        } else if (p.type === 'autonomy') {
          // autonomy toggled from anywhere (this UI or headless)
          void refreshControlState();
        }
        break;
      }
    }
  }, [refreshPortfolio, refreshControlState]);

  const stream = useBackendStream(onEnvelope);
  useEffect(() => {
    setStreamConnected(stream.connected);
    if (stream.connected) setConnected(true);
  }, [stream.connected]);

  const showToast = useCallback((msg: string, type: ToastType = 'success') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const openModal = useCallback((content: ReactNode) => {
    setModalContent(content);
  }, []);

  const closeModal = useCallback(() => {
    setModalContent(null);
  }, []);

  return (
    <AppContext.Provider value={{ state, setState, showToast, openModal, closeModal, toasts, modalContent, addSystemLog, refreshPortfolio, refreshControlState, connected, streamConnected }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
