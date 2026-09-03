import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { PositionMonitor, OrderUpdateWS, RateLimitError } from '@nemesis-oss/dhanhq-sdk';
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
  SENSEX: { securityId: '51', label: 'BSE SENSEX' },
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
  private lastWsTickAt = 0;
  private source: 'ws' | 'rest' | 'none' = 'none';
  private rateLimitedUntil = 0;                           // backoff gate after a 429
  private consecutiveRateLimits = 0;
  private wsListenersAttached = false;
  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private wsRetryAttempts = 0;
  private wsSilenceWatch: ReturnType<typeof setInterval> | null = null;
  private extraSubscriptions = new Set<string>();        // 'SEG:SECID' keys
  private unsubEventBus: (() => void) | null = null;
  readonly monitor = new PositionMonitor();

  constructor(client: DhanClient) {
    this.client = client;
  }

  async start(): Promise<void> {
    // Feed monitor exits into the bus (autonomy engine acts on them).
    // ExitSignal nests the position ({securityId, exchangeSegment, ...}) and
    // names the trigger price `price`, not `exitPrice` — reading those
    // fields flat off `signal` silently produced `undefined` for all three,
    // so autonomy's exit handler could never match a real position and
    // stop-loss/target/trailing exits never actually closed anything.
    this.monitor.on('exit', (signal: any) => {
      eventBus.emit('order', {
        kind: 'exit_signal',
        reason: signal.reason,
        positionId: signal.position?.securityId,
        securityId: signal.position?.securityId,
        pnl: signal.pnl,
        exitPrice: signal.price,
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
      patchOrderWsSafety();
      const ws: any = (this.client as any).ws;
      if (ws.market) {
        // 'full' mode (RequestCode 21) was tried here for OI on option-chain
        // legs, but DhanHQ silently drops IDX_I subscriptions under it —
        // verified directly (0 ticks in 15s on 'full' vs 67 ticks in 8s on
        // 'ticker', same securityIds). The whole ws.market connection shares
        // one mode, so it broke every index tick, forcing 100% REST-poll
        // dependency and the resulting rate-limit spam. 'ticker' is what
        // actually delivers LTP — the safety-critical path (SL/target
        // monitoring, real-time UI) needs that far more than live OI, which
        // the option-chain page already refreshes via periodic REST anyway.
        ws.market.mode = 'ticker';
        // Register subscriptions upfront so onOpen automatically transmits them.
        // Every reconnect creates a fresh WS session with no memory of prior
        // subscriptions — re-send extraSubscriptions (option legs of open
        // positions) too, or every reconnect silently downgrades their SL/
        // target monitoring from sub-second WS ticks to the 3-15s REST poll.
        ws.market.subscribe([
          ...INDEX_SEC_IDS.map((id) => ({ exchangeSegment: 'IDX_I', securityId: id })),
          ...[...this.extraSubscriptions].map((k) => {
            const [exchangeSegment, securityId] = k.split(':');
            return { exchangeSegment, securityId };
          }),
        ]);
      }
      if (!this.wsListenersAttached) {
        this.wsListenersAttached = true;
        ws.market?.on?.('tick', (tick: any) => {
          this.wsTickCount++;
          this.lastTickAt = Date.now();
          this.lastWsTickAt = Date.now();
          this.source = 'ws';
          this.ingestTick(tick);
        });
        ws.orders?.on?.('order', (order: any) => {
          eventBus.emit('order', { kind: 'order_update', order });
        });
        // Promise.allSettled never rejects, so a .then()/.catch() pair on it
        // used to always run .then() — wsStarted=true and a "connected" log
        // fired even when every connect attempt failed, and the .catch()
        // retry path was dead code. A real close/error also went unhandled,
        // so a mid-session drop silently degraded to REST for the rest of
        // the day with no reconnect and no signal. Fixed below: inspect the
        // settled results, and treat the socket's own lifecycle as normal
        // (a drop is expected, not exceptional).
        ws.market?.on?.('close', (code: number) => {
          if (!this.wsStarted) return; // already handled by the connect-failure path
          this.wsStarted = false;
          eventBus.log('WARN', `Market WS closed (code=${code}) — reconnecting`, 'market_data');
          eventBus.emit('system', { type: 'feed_degraded', source: 'rest' });
          this.scheduleWsRetry();
        });
        ws.market?.on?.('error', (e: any) => {
          eventBus.log('WARN', `Market WS error: ${e?.message || e}`, 'market_data');
        });
      }
      const connects: Promise<any>[] = [];
      if (ws.market?.connect) connects.push(ws.market.connect());
      if (ws.orders?.connect) connects.push(ws.orders.connect().catch(() => {}));
      Promise.allSettled(connects).then((results) => {
        const ok = results.length > 0 && results.some((r) => r.status === 'fulfilled');
        if (!ok) {
          const why = results
            .map((r) => (r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : ''))
            .filter(Boolean).join('; ') || 'no connect attempts succeeded';
          eventBus.log('WARN', `DhanHQ WebSocket connect failed (${why}) — REST polling only`, 'market_data');
          this.scheduleWsRetry();
          return;
        }
        this.wsStarted = true;
        this.wsRetryAttempts = 0;
        this.lastWsTickAt = Date.now(); // grace period starts from connect, not epoch 0
        eventBus.log('INFO', 'DhanHQ binary WebSocket connected — real-time tick stream live', 'market_data');
        this.armSilenceWatch();
      });
    } catch (e: any) {
      eventBus.log('WARN', `DhanHQ WebSocket start failed (${e?.message || e}) — REST polling only`, 'market_data');
      this.scheduleWsRetry();
    }
  }

  /** A half-open socket reports connected and delivers nothing — only tick
   * arrival proves liveness. Forces a reconnect on silence during market
   * hours rather than trusting the 'open' event forever. */
  private armSilenceWatch(): void {
    if (this.wsSilenceWatch) return;
    this.wsSilenceWatch = setInterval(() => {
      if (!this.wsStarted || !marketClock().isMarketOpen) return;
      if (Date.now() - this.lastWsTickAt < 20_000) return;
      eventBus.log('WARN', 'No WS tick for 20s during market hours — forcing reconnect', 'market_data');
      this.wsStarted = false;
      try { (this.client as any).ws?.market?.disconnect?.(); } catch { /* already gone */ }
      this.scheduleWsRetry();
    }, 10_000);
  }

  // A single failed handshake (e.g. a transient 429) used to disable the WS
  // for the rest of the process's life. Retry with capped exponential backoff instead.
  private scheduleWsRetry(): void {
    if (this.wsStarted || this.wsRetryTimer) return;
    this.wsRetryAttempts++;
    const delay = Math.min(15_000 * 2 ** (this.wsRetryAttempts - 1), 5 * 60_000);
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      this.tryStartWs();
    }, delay);
  }

  private patchOrderWsSafety(): void {
    patchOrderWsSafety();
  }

  private schedulePolling(): void {
    const tick = async () => {
      const clock = marketClock();
      const wsFresh = this.wsTickCount > 0 && Date.now() - this.lastWsTickAt < 10_000;
      const backoffRemaining = this.rateLimitedUntil - Date.now();
      const interval = backoffRemaining > 0 ? backoffRemaining : wsFresh ? 15_000 : clock.isMarketOpen ? 3_000 : 30_000;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(tick, interval);
      if (backoffRemaining <= 0) {
        await this.pollIndices();
        await this.pollExtraInstruments();
      }
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
        this.ingestRestQuote(secId, symbol, d, 'IDX_I');
      }
      if (touched) {
        this.restTickCount++;
        this.lastTickAt = Date.now();
        this.consecutiveRateLimits = 0;
        if (this.wsTickCount === 0 || Date.now() - this.lastWsTickAt >= 10_000) {
          this.source = 'rest';
        }
      }
    } catch (e: any) {
      if (e instanceof RateLimitError) {
        this.consecutiveRateLimits++;
        // Exponential backoff (10s, 20s, 40s ... capped at 2min) — retrying every
        // 3s into a 429 just keeps renewing Dhan's rate-limit window forever.
        const backoffMs = e.retryAfterMs || Math.min(10_000 * 2 ** (this.consecutiveRateLimits - 1), 120_000);
        this.rateLimitedUntil = Date.now() + backoffMs;
        eventBus.log('WARN', `Index quote poll rate-limited — backing off ${Math.round(backoffMs / 1000)}s`, 'market_data');
      } else {
        eventBus.log('WARN', `Index quote poll failed: ${e?.message || e}`, 'market_data');
      }
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
          if (d) this.ingestRestQuote(id, undefined, d, seg);
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

    // Prev-close packets update baseline without overwriting LTP with zero
    if (tick.type === 'prev-close' && typeof tick.previousClose === 'number') {
      if (prev) {
        prev.prevClose = tick.previousClose;
        prev.change = prev.ltp ? prev.ltp - prev.prevClose : 0;
        prev.pctChange = prev.prevClose ? (prev.change / prev.prevClose) * 100 : 0;
        prev.updatedAt = Date.now();
        if (symbol && prev.ltp > 0) {
          eventBus.emit('tick', { symbol, data: this.toTickPayload(prev) });
        }
      }
      return;
    }

    const ltp = Number(tick.ltp ?? tick.lastTradedPrice ?? prev?.ltp ?? 0);
    if (!ltp) return;
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

    eventBus.emit('tick', { symbol, securityId: secId, data: this.toTickPayload(snap) });
  }

  private ingestRestQuote(secId: string, symbol: string | undefined, d: any, exchangeSegment: string): void {
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
        exchangeSegment,
        securityId: secId,
        ltp, ltt: Math.floor(Date.now() / 1000),
        raw: Buffer.alloc(0),
      } as any);
    } catch { /* monitor defensive */ }

    eventBus.emit('tick', { symbol, securityId: secId, data: this.toTickPayload(snap) });
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

  /** Display-only. Returns the last-known price at any age, including
   * off-hours — a closed-market ticker showing yesterday's close is
   * correct, not stale. NEVER use this to decide a fill or gate a trade —
   * use getFillablePrice() for that; see its docstring for why. */
  getLtp(securityId: string | number): number | null {
    const snap = this.quotes.get(String(securityId));
    if (!snap || !snap.ltp) return null;
    const clock = marketClock();
    if (clock.isMarketOpen && Date.now() - snap.updatedAt > 5 * 60_000) return null;
    return snap.ltp;
  }

  /** The ONLY price source any execution path may use — order fills,
   * strategy seeding, position sizing. getLtp()'s staleness guard only
   * applied during market hours, so a boot outside market hours (or a
   * feed outage) returned an arbitrarily old cached price with no bound at
   * all, and callers that saw null from getLtp() (e.g. seedStandardStrategies)
   * fell back to a HARDCODED FAKE SPOT rather than skipping — both are real
   * incidents this closes. Refuses outside market hours unless explicitly
   * allowed (backtests / manual overrides), and always enforces a tight age
   * bound regardless of hours. */
  getFillablePrice(securityId: string | number, opts: { allowClosed?: boolean; maxAgeMs?: number } = {}): number | null {
    const clock = marketClock();
    if (!clock.isMarketOpen && !opts.allowClosed) return null;
    const snap = this.quotes.get(String(securityId));
    if (!snap || !snap.ltp || snap.ltp <= 0) return null;
    const maxAgeMs = opts.maxAgeMs ?? 15_000;
    if (Date.now() - snap.updatedAt > maxAgeMs) return null;
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
    const wsFresh = this.wsTickCount > 0 && Date.now() - this.lastWsTickAt < 10_000;
    return {
      source: this.source,
      wsConnected: this.wsStarted && wsFresh,
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
    if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
    if (this.wsSilenceWatch) clearInterval(this.wsSilenceWatch);
    this.unsubEventBus?.();
    try { (this.client as any).ws?.disconnect?.(); } catch { /* noop */ }
  }
}

function patchOrderWsSafety(): void {
  const proto = (OrderUpdateWS as any)?.prototype;
  if (!proto || proto.__safetyPatched) return;
  proto.__safetyPatched = true;
  const origOnMessage = proto.onMessage;
  proto.onMessage = function (data: any) {
    try {
      const raw = typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf8') : null);
      if (!raw) return;
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
      if (trimmed.includes('}{')) {
        const parts = trimmed.split(/(?<=\})(?=\{)/);
        for (const part of parts) {
          try {
            const parsed = JSON.parse(part);
            if (parsed.Type === 'order_alert' && parsed.Data) {
              const state = {
                orderId: typeof parsed.Data.OrderNo === 'string' ? parsed.Data.OrderNo : undefined,
                correlationId: typeof parsed.Data.CorrelationId === 'string' && parsed.Data.CorrelationId.length > 0 ? parsed.Data.CorrelationId : undefined,
                status: typeof parsed.Data.Status === 'string' ? parsed.Data.Status : undefined,
                tradedQty: typeof parsed.Data.TradedQty === 'number' ? parsed.Data.TradedQty : undefined,
                averageTradedPrice: typeof parsed.Data.AvgTradedPrice === 'number' ? parsed.Data.AvgTradedPrice : undefined,
                securityId: typeof parsed.Data.SecurityId === 'string' ? parsed.Data.SecurityId : undefined,
                raw: parsed.Data,
              };
              (this as any).orderStore?.upsert?.(state);
              this.emit('order', state);
            }
          } catch { /* ignore malformed part */ }
        }
        return;
      }
      origOnMessage.call(this, data);
    } catch {
      // Guard against malformed JSON or heartbeat frames from Dhan
    }
  };
}
