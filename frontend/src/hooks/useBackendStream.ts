import { useEffect, useRef, useCallback, useState } from 'react';
import { log } from '../services/logger';

/**
 * Backend telemetry stream — the ONLY realtime channel into the UI.
 *
 * The backend pushes typed envelopes { channel, ts, payload } for:
 *   tick | log | alert | telemetry | risk | portfolio | order | system
 *
 * This hook connects, subscribes (all channels by default), auto-reconnects
 * with backoff, and dispatches each envelope to the AppContext reducers.
 * The default URL matches the backend server (port 3003, path /ws).
 */

export type Channel = 'tick' | 'log' | 'alert' | 'telemetry' | 'risk' | 'portfolio' | 'order' | 'system';

export interface Envelope {
  channel: Channel;
  ts: number;
  payload: any;
}

interface StreamState {
  connected: boolean;
  lastMessageAt: number | null;
}

export function useBackendStream(
  onEnvelope: (env: Envelope) => void,
  channels?: Channel[],
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<StreamState>({ connected: false, lastMessageAt: null });
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const onEnvelopeRef = useRef(onEnvelope);
  onEnvelopeRef.current = onEnvelope;

  const connect = useCallback(() => {
    const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3003/ws';

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        retriesRef.current = 0;
        setState((s) => ({ ...s, connected: true }));
        log.info('Telemetry stream connected', { source: 'ws' });
        // Subscribe to telemetry channels (server default is all, but be explicit).
        ws.send(JSON.stringify({ type: 'subscribe', channels: channels ?? ['tick', 'log', 'alert', 'telemetry', 'risk', 'portfolio', 'order', 'system'] }));
      };

      ws.onmessage = (event) => {
        try {
          const env: Envelope = JSON.parse(event.data);
          setState((s) => ({ ...s, lastMessageAt: Date.now() }));
          if (env && env.channel) {
            onEnvelopeRef.current(env);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        const delay = Math.min(30000, 3000 * Math.pow(1.6, retriesRef.current++));
        log.warn('Telemetry stream disconnected — reconnecting', {
          source: 'ws',
          attempt: retriesRef.current,
          nextRetryMs: delay,
        });
        reconnectTimer.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      reconnectTimer.current = setTimeout(connect, 3000);
    }
  }, [channels]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return state;
}
