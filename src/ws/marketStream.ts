import { WebSocket } from 'ws';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';

interface TickData {
  securityId: string;
  ltp: number;
  change: number;
  pctChange: number;
  volume: number;
  oi: number;
  timestamp: number;
}

export class MarketStreamManager {
  private clients: Set<WebSocket> = new Set();
  private instruments: Array<{ securityId: string; exchangeSegment: string }> = [];
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private client: DhanClient;

  constructor(client: DhanClient) {
    this.client = client;
  }

  subscribe(ws: WebSocket): void {
    this.clients.add(ws);
    console.log(`[Stream] Client subscribed. Total: ${this.clients.size}`);

    if (!this.tickInterval) {
      this.startPolling();
    }
  }

  unsubscribe(ws: WebSocket): void {
    this.clients.delete(ws);
    console.log(`[Stream] Client unsubscribed. Total: ${this.clients.size}`);

    if (this.clients.size === 0 && this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  addInstruments(instruments: Array<{ securityId: string; exchangeSegment: string }>): void {
    this.instruments = instruments;
    console.log(`[Stream] Tracking ${instruments.length} instruments`);
  }

  private startPolling(): void {
    // Poll indices every 2 seconds during market hours
    this.tickInterval = setInterval(async () => {
      if (this.clients.size === 0) return;

      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const day = now.getDay();

      // Only poll during market hours (Mon-Fri, 9:15-15:30 IST)
      const isWeekday = day >= 1 && day <= 5;
      const totalMinutes = hours * 60 + minutes;
      const marketOpen = 9 * 60 + 15;
      const marketClose = 15 * 60 + 30;
      const isMarketHours = isWeekday && totalMinutes >= marketOpen && totalMinutes <= marketClose;

      if (!isMarketHours) return;

      try {
        const indices = ['13', '25', '27', '26']; // NIFTY, BANKNIFTY, FINNIFTY, VIX
        const symbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'INDIAVIX'];

        for (let i = 0; i < indices.length; i++) {
          try {
            const quote = await this.client.marketFeed.quote({ IDX_I: [indices[i]] });
            const d = (quote.data as any)?.IDX_I?.[indices[i]];

            if (d) {
              const ltp = Number(d.lastTradedPrice || d.ltp || 0);
              const prevClose = Number(d.close || d.prevClose || ltp);

              const tick: TickData = {
                securityId: indices[i],
                ltp,
                change: ltp - prevClose,
                pctChange: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
                volume: Number(d.volume || 0),
                oi: Number(d.oi || 0),
                timestamp: Date.now(),
              };

              this.broadcast({
                type: 'tick',
                symbol: symbols[i],
                data: tick,
              });
            }
          } catch {
            // Silently skip failed individual fetches
          }
        }
      } catch (e: any) {
        console.warn('[Stream] Poll error:', e.message);
      }
    }, 2000);
  }

  private broadcast(message: any): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}
