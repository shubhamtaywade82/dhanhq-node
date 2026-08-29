import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from './eventBus';
import { marketClock, istNow } from './marketHours';

/**
 * Always-on market data service.
 *
 * - Primary source: DhanHQ binary WebSocket (SDK `client.ws.market`) —
 *   real-time ticks, no polling cost.
 * - Fallback source: REST `marketFeed.quote` polling (every 3s) when the
 *   WS is not connected (off-hours token absence, WS outage, sandbox runs).
 *
 * The service starts at server boot and keeps running with ZERO frontend
 * clients attached — the autonomy loop and risk engine both consume it.
 * Frontend WS clients are pure observers.
 *
 * It also feeds the SDK's PositionMonitor (stop-loss / target / trailing
 * exits), which was previously dead code in this repo.
 */

export const INDEX_INSTRUMENTS: Record<string, { securityId: string; label: string }> = {
  NIFTY: { securityId: '13', label: 'NIFTY 50' },
  BANKNIFTY: { securityId: '25', label: 'NIFTY BANK' },
  FINNIFTY: { securityId: '27', label: 'NIFTY FIN SERVICE' },
  MIDCPNIFTY: { securityId: '442', label: 'NIFTY MID SELECT' },
  INDIAVIX: { securityId: '26', label: 'INDIA VIX' },
};

const INDEX_SEC_IDS = Object.values(INDEX_INSTRUMENTS).map((i) => i.securityId);
const SEC_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(INDEX_INSTRUMENTS).map(([sym, i]) => [i.securityId, sym]),
);

export interface QuoteSnapshot {
  securityId: string;
  symbol?: string;
  ltp: number;
  change: number;
  pctChange: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  volume: number;
  oi: number;
  updatedAt: number;
}

export class MarketDataService {
  private client: DhanClient;
  private quotes = new Map<string, QuoteSnapshot>();     // securityId → snapshot
  private wsStarted = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wsTickCount = 0;
  private restTickCount = 0;
  private lastTickAt = 0;
  private source: 'ws' | 'rest' | 'none' = 'none';
  private extraSubscriptions = new Set<string>();        // 'SEG:SECID' keys
  private unsubEventBus: (() => void) | null = null;
  readonly monitor = new PositionMonitor();

  constructor(client: DhanClient) {
    this.client = client;
  }

  async start(): Promise<void> {
    // Feed monitor exits into the bus (autonomy engine acts on them).
    this.monitor.on('exit', (signal: any) => {
      eventBus.emit('order', {
        kind: 'exit_signal',
        reason: signal.reason,
        positionId: signal.positionId,
        securityId: signal.securityId,
        pnl: signal.pnl,
        exitPrice: signal.exitPrice,
      });
    });

    // Start DhanHQ binary WS in a best-effort way. When it cannot connect
    // (no token / off-hours), the REST poller below still feeds the cache.
    this.tryStartWs();

    // Always run the REST poller as fallback + refresher. Outside market
    // hours it backs off to a slow cadence so we don't burn rate limits.
    this.schedulePolling();

    eventBus.log('SYSTEM', `Market data service started (ws=${this.wsStarted ? 'attempting' : 'unavailable'}, rest fallback armed)`, 'market_data');
  }

  private tryStartWs(): void {
    // Only bring up the DhanHQ binary WS when a token is actually
    // resolvable — the SDK's WS auth throws (in an event handler) when
    // credentials are absent, which would crash the process.
    const tokenResolvable = !!(process.env.DHAN_ACCESS_TOKEN && process.env.DHAN_ACCESS_TOKEN !== 'your_access_token')
      || !!(process.env.DHAN_PIN && process.env.DHAN_TOTP_SECRET)
      || !!(process.env.DHAN_AUTH_PROVIDER_URL && process.env.DHAN_AUTH_PROVIDER_TOKEN);
    if (!tokenResolvable) {
      eventBus.log('WARN', 'No DhanHQ credentials configured — binary WS disabled, REST polling will serve market data when a token appears', 'market_data');
      return;
    }
    try {
      const ws: any = (this.client as any).ws;
      ws.market?.on?.('tick', (tick: any) => {
        this.wsTickCount++;
        this.lastTickAt = Date.now();
        this.source = 'ws';
        this.ingestTick(tick);
      });
      ws.orders?.on?.('order', (order: any) => {
        eventBus.emit('order', { kind: 'order_update', order });
      });
      ws.connect?.().then(() => {
        ws.market?.subscribe?.(
          INDEX_SEC_IDS.map((id) => ({ exchangeSegment: 'IDX_I', securityId: id })),
        );
        this.wsStarted = true;
        this.source = 'ws';
        eventBus.log('INFO', 'DhanHQ binary WebSocket connected — real-time tick stream live', 'market_data');
      }).catch((e: any) => {
        eventBus.log('WARN', `DhanHQ WebSocket unavailable (${e?.message || e}) — falling back to REST polling`, 'market_data');
      });
    } catch (e: any) {
      eventBus.log('WARN', `DhanHQ WebSocket start failed (${e?.message || e}) — REST polling only`, 'market_data');
    }
  }

  private schedulePolling(): void {
    const tick = async () => {
      const clock = marketClock();
      // WS healthy and inside market hours → light refresh only.
      const wsFresh = this.source === 'ws' && Date.now() - this.lastTickAt < 10_000;
      const interval = wsFresh ? 30_000 : clock.isMarketOpen ? 3_000 : 60_000;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(tick, interval);
      if (!clock.isMarketOpen && !clock.isPreOpen) {
        // Off-hours: one quote per cycle keeps the UI honest without hammering.
      }
      await this.pollIndices();
      await this.pollExtraInstruments();
    };
    tick();
  }

  private async pollIndices(): Promise<void> {
    try {
      const res = await this.client.marketFeed.quote({ IDX_I: INDEX_SEC_IDS });
      const idxData = (res.data as any)?.IDX_I || {};
      let touched = false;
      for (const [secId, symbol] of Object.entries(SEC_TO_SYMBOL)) {
        const d = idxData[secId];
        if (!d) continue;
        touched = true;
        this.ingestRestQuote(secId, symbol, d);
      }
      if (touched) { this.restTickCount++; this.lastTickAt = Date.now(); if (this.source !== 'ws') this.source = 'rest'; }
    } catch (e: any) {
      eventBus.log('WARN', `Index quote poll failed: ${e?.message || e}`, 'market_data');
    }
  }

  /** Subscribe to non-index instruments (option legs held in paper positions). */
  addInstruments(instruments: Array<{ securityId: string; exchangeSegment: string }>): void {
    for (const { securityId, exchangeSegment } of instruments) {
      if (!securityId || securityId === '0') continue;
      this.extraSubscriptions.add(`${exchangeSegment}:${securityId}`);
    }
    try {
      (this.client as any).ws?.market?.subscribe?.(
        [...this.extraSubscriptions].map((k) => {
          const [exchangeSegment, securityId] = k.split(':');
          return { exchangeSegment, securityId };
        }),
      );
    } catch { /* WS down — REST poller covers extras */ }
  }

  private async pollExtraInstruments(): Promise<void> {
    if (this.extraSubscriptions.size === 0) return;
    const bySegment: Record<string, string[]> = {};
    for (const key of this.extraSubscriptions) {
      const [seg, id] = key.split(':');
      (bySegment[seg] ||= []).push(id);
    }
    try {
      const res = await this.client.marketFeed.quote(bySegment);
      const data = (res.data as any) || {};
      for (const [seg, ids] of Object.entries(bySegment)) {
        for (const id of ids) {
          const d = data[seg]?.[id];
          if (d) this.ingestRestQuote(id, undefined, d);
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── ingestion ────────────────────────────────────────────────────────

  private ingestTick(tick: any): void {
    const secId = String(tick.securityId ?? tick.security_id ?? '');
    if (!secId) return;
    const symbol = SEC_TO_SYMBOL[secId];
    const prev = this.quotes.get(secId);
    const ltp = Number(tick.ltp ?? tick.lastTradedPrice ?? prev?.ltp ?? 0);
    const prevClose = Number(tick.close ?? prev?.prevClose ?? ltp);
    const snap: QuoteSnapshot = {
      securityId: secId,
      symbol,
      ltp,
      prevClose,
      change: ltp - prevClose,
      pctChange: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
      high: Number(tick.high ?? prev?.high ?? ltp),
      low: Number(tick.low ?? prev?.low ?? ltp),
      open: Number(tick.open ?? prev?.open ?? ltp),
      volume: Number(tick.volume ?? prev?.volume ?? 0),
      oi: Number(tick.oi ?? tick.openInterest ?? prev?.oi ?? 0),
      updatedAt: Date.now(),
    };
    this.quotes.set(secId, snap);

    // Feed the SDK PositionMonitor for stop-loss/target/trailing exits.
    try {
      this.monitor.onTick({
        type: 'ticker',
        responseCode: 0, messageLength: 0, exchangeSegmentCode: 0,
        exchangeSegment: String(tick.exchangeSegment || 'IDX_I'),
        securityId: secId,
        ltp, ltt: Math.floor(Date.now() / 1000),
        raw: Buffer.alloc(0),
      } as any);
    } catch { /* monitor defensive */ }

    if (symbol) {
      eventBus.emit('tick', { symbol, data: this.toTickPayload(snap) });
    } else {
      eventBus.emit('tick', { securityId: secId, data: this.toTickPayload(snap) });
    }
  }

  private ingestRestQuote(secId: string, symbol: string | undefined, d: any): void {
    const ltp = Number(d.lastTradedPrice || d.last_price || d.ltp || 0);
    if (!ltp) return;
    const ohlc = d.ohlc || {};
    const prevClose = Number(ohlc.close || d.close || d.prevClose || ltp);
    const prev = this.quotes.get(secId);
    const snap: QuoteSnapshot = {
      securityId: secId,
      symbol,
      ltp,
      prevClose,
      change: ltp - prevClose,
      pctChange: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
      high: Number(ohlc.high || d.high || ltp),
      low: Number(ohlc.low || d.low || ltp),
      open: Number(ohlc.open || d.open || ltp),
      volume: Number(d.volume || 0),
      oi: Number(d.oi || d.openInterest || 0),
      updatedAt: Date.now(),
    };
    this.quotes.set(secId, snap);

    try {
      this.monitor.onTick({
        type: 'ticker',
        responseCode: 0, messageLength: 0, exchangeSegmentCode: 0,
        exchangeSegment: 'IDX_I',
        securityId: secId,
        ltp, ltt: Math.floor(Date.now() / 1000),
        raw: Buffer.alloc(0),
      } as any);
    } catch { /* monitor defensive */ }

    if (this.source !== 'ws') {
      if (symbol) eventBus.emit('tick', { symbol, data: this.toTickPayload(snap) });
      else eventBus.emit('tick', { securityId: secId, data: this.toTickPayload(snap) });
    }
  }

  private toTickPayload(s: QuoteSnapshot) {
    return {
      securityId: s.securityId,
      ltp: s.ltp,
      change: Number(s.change.toFixed(2)),
      pctChange: Number(s.pctChange.toFixed(2)),
      high: s.high, low: s.low, open: s.open, prevClose: s.prevClose,
      volume: s.volume, oi: s.oi,
      timestamp: s.updatedAt,
    };
  }

  // ── queries ──────────────────────────────────────────────────────────

  getLtp(securityId: string | number): number | null {
    const snap = this.quotes.get(String(securityId));
    if (!snap || !snap.ltp) return null;
    // Staleness guard: a quote older than 5 minutes during market hours is
    // not a fillable price.
    const clock = marketClock();
    if (clock.isMarketOpen && Date.now() - snap.updatedAt > 5 * 60_000) return null;
    return snap.ltp;
  }

  getQuote(securityId: string | number): QuoteSnapshot | null {
    return this.quotes.get(String(securityId)) || null;
  }

  getIndices(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [sym, inst] of Object.entries(INDEX_INSTRUMENTS)) {
      const snap = this.quotes.get(inst.securityId);
      out[sym] = snap ? {
        ltp: snap.ltp,
        change: Number(snap.change.toFixed(2)),
        pct: Number(snap.pctChange.toFixed(2)),
        high: snap.high, low: snap.low, open: snap.open, prevClose: snap.prevClose,
        updatedAt: snap.updatedAt,
      } : null;
    }
    return out;
  }

  /** Seconds since the freshest tick of any instrument. */
  tickAgeSec(): number {
    return this.lastTickAt ? Math.round((Date.now() - this.lastTickAt) / 1000) : Infinity;
  }

  stats() {
    return {
      source: this.source,
      wsConnected: this.wsStarted && this.source === 'ws',
      wsTicks: this.wsTickCount,
      restTicks: this.restTickCount,
      trackedInstruments: this.quotes.size,
      extraSubscriptions: this.extraSubscriptions.size,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      tickAgeSec: this.tickAgeSec() === Infinity ? null : this.tickAgeSec(),
      istTime: istNow().toLocaleTimeString('en-GB', { hour12: false }),
    };
  }

  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.unsubEventBus?.();
    try { (this.client as any).ws?.disconnect?.(); } catch { /* noop */ }
  }
}
