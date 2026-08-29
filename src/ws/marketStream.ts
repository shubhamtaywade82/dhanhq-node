import { WebSocket } from 'ws';
import { eventBus, type Envelope, type Channel } from '../services/eventBus';
import { marketClock } from '../services/marketHours';

/**
 * WebSocket hub — the backend→frontend telemetry stream.
 *
 * Protocol (frontend is a pure consumer):
 *   Server → Client: { channel, ts, payload } envelopes on channels:
 *     tick | log | alert | telemetry | risk | portfolio | order | system
 *   Client → Server:
 *     { type: 'subscribe', channels: [...] }   — filter (default: all)
 *     { type: 'unsubscribe' }
 *     { type: 'ping' }                          — server replies pong
 *
 * On connect the client receives a hydration snapshot
 * (recent logs, alerts, telemetry, risk state) so a late-attaching UI
 * shows real history immediately — no fabricated seed data.
 */

const ALL_CHANNELS: Channel[] = ['tick', 'log', 'alert', 'telemetry', 'risk', 'portfolio', 'order', 'system'];
const HYDRATION_CHANNELS: Channel[] = ['log', 'alert', 'telemetry'];

export class MarketStreamManager {
  private clients = new Map<WebSocket, { channels: Set<Channel>; send: (env: Envelope) => void }>();

  subscribe(ws: WebSocket): void {
    const entry = {
      channels: new Set<Channel>(ALL_CHANNELS),
      send: (env: Envelope) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
      },
    };
    this.clients.set(ws, entry);
    console.log(`[WS] Client connected. Total: ${this.clients.size}`);

    // Hydrate with real recent history.
    for (const env of eventBus.recent(undefined, HYDRATION_CHANNELS).slice(-60)) {
      try { entry.send(env); } catch { /* ignore */ }
    }
    ws.send(JSON.stringify({
      channel: 'system', ts: Date.now(),
      payload: { type: 'connected', channels: ALL_CHANNELS, clock: marketClock() },
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
          entry.channels = new Set<Channel>(msg.channels.filter((c: any) => ALL_CHANNELS.includes(c)));
          ws.send(JSON.stringify({ channel: 'system', ts: Date.now(), payload: { type: 'subscribed', channels: [...entry.channels] } }));
        } else if (msg.type === 'unsubscribe') {
          entry.channels = new Set();
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ channel: 'system', ts: Date.now(), payload: { type: 'pong' } }));
        }
      } catch { /* malformed — ignore */ }
    });
  }

  unsubscribe(ws: WebSocket): void {
    this.clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${this.clients.size}`);
  }

  /** Attach the hub to the central bus (called once at boot). */
  attach(): void {
    eventBus.attachWsClient((env) => {
      for (const entry of this.clients.values()) {
        if (entry.channels.has(env.channel)) {
          try { entry.send(env); } catch { /* dead socket cleaned on close */ }
        }
      }
    });
  }

  stats() {
    return {
      clients: this.clients.size,
      channels: ALL_CHANNELS,
    };
  }
}
