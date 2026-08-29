import { EventEmitter } from 'events';

/**
 * Central event bus. Every backend service (market data, risk engine,
 * autonomy loop, agent orchestrator, paper engine) publishes here.
 *
 * The bus fans events out to:
 *  - WebSocket hub (frontend control plane, zero or more clients)
 *  - Redis pub/sub (Rails sidecar compatibility, best-effort)
 *
 * The bus itself is transport-agnostic: services never know whether a
 * frontend is attached. This is what lets the backend run free of the UI.
 */

export type Channel =
  | 'tick'          // market data updates (indices, instrument LTPs)
  | 'log'           // structured system logs
  | 'alert'         // risk + system alerts (persisted)
  | 'telemetry'     // agent ReAct step events
  | 'risk'          // circuit breaker / risk state snapshots
  | 'portfolio'     // positions / orders / funds snapshots
  | 'order'         // fills, rejections, cancellations
  | 'system';       // lifecycle: boot, mode changes, kill switch

export interface Envelope<T = any> {
  channel: Channel;
  ts: number;
  payload: T;
}

type Handler = (env: Envelope) => void;

export class EventBus {
  private emitter = new EventEmitter();
  private wsClients = new Set<(env: Envelope) => void>();
  private redisSink: ((channel: string, message: string) => Promise<void>) | null = null;
  private history: Envelope[] = [];
  private readonly historyLimit = 500;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  /** Services subscribe locally (in-process). */
  on(channel: Channel | '*', handler: Handler): () => void {
    const wrapped = channel === '*' ? handler : (env: Envelope) => {
      if (env.channel === channel) handler(env);
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  /** The WebSocket hub registers its per-client senders here. */
  attachWsClient(send: (env: Envelope) => void): () => void {
    this.wsClients.add(send);
    return () => this.wsClients.delete(send);
  }

  /** Redis publisher (optional, best-effort Rails bridge). */
  setRedisSink(sink: ((channel: string, message: string) => Promise<void>) | null): void {
    this.redisSink = sink;
  }

  emit<T>(channel: Channel, payload: T): void {
    const env: Envelope<T> = { channel, ts: Date.now(), payload };
    this.history.push(env as Envelope);
    if (this.history.length > this.historyLimit) this.history.shift();

    this.emitter.emit('event', env as Envelope);

    for (const send of this.wsClients) {
      try { send(env as Envelope); } catch { /* dead client — hub cleans up */ }
    }

    if (this.redisSink) {
      this.redisSink(`dhan:events:${channel}`, JSON.stringify(payload)).catch(() => {});
    }
  }

  /** Recent events, newest last — used to hydrate late-attaching WS clients. */
  recent(sinceTs?: number, channels?: Channel[]): Envelope[] {
    return this.history.filter((e) =>
      (!sinceTs || e.ts > sinceTs) && (!channels || channels.includes(e.channel)),
    );
  }

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'SYSTEM' | 'TRADE', message: string, source: string): void {
    this.emit('log', {
      level, message, source,
      reqId: `req_${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
    });
  }
}

export const eventBus = new EventBus();
