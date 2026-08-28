import { useEffect, useRef, useCallback, useState } from 'react';

interface TickMessage {
  type: 'tick';
  symbol: string;
  data: {
    securityId: string;
    ltp: number;
    change: number;
    pctChange: number;
    volume: number;
    oi: number;
    timestamp: number;
  };
}

type Message = TickMessage;

export function useMarketStream(onTick?: (symbol: string, data: TickMessage['data']) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws';

    try {
      const ws = new WebSocket(WS_URL) as WebSocket;
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] Connected to market stream');
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg: Message = JSON.parse(event.data);
          if (msg.type === 'tick' && onTick) {
            onTick(msg.symbol, msg.data);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        console.log('[WS] Disconnected, reconnecting in 3s...');
        setConnected(false);
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      reconnectTimer.current = setTimeout(connect, 3000);
    }
  }, [onTick]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}
