import { useEffect, useRef } from 'react';
import { useApp } from '../store/AppContext';

export function useSimulation() {
  const { setState, addSystemLog } = useApp();
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const uptimeInterval = setInterval(() => {
      setState((prev) => {
        const unrealized = prev.positions.reduce((acc, p) => acc + (p.unrealizedProfit || p.unrealizedPnl || 0), 0);
        const totalPnl = (prev.funds.realizedPnl || 0) + unrealized;
        const pnlHistory = [...prev.pnlHistory, Math.round(totalPnl)];
        if (pnlHistory.length > 180) pnlHistory.shift();

        return {
          ...prev,
          uptimeSeconds: prev.uptimeSeconds + 1,
          pnlHistory,
        };
      });
    }, 2000);

    addSystemLog('SYSTEM', 'Axis Nexus Trading Node.js Sidecar active', 'sidecar');
    addSystemLog('INFO', 'Connected to PostgreSQL database for Paper Trading persistence', 'postgres');
    addSystemLog('INFO', 'DhanHQ SDK initialized with dynamic token authority & TOTP fallback', 'dhan_auth');

    return () => {
      clearInterval(uptimeInterval);
    };
  }, [setState, addSystemLog]);
}
