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

function isIndianMarketOpen(): boolean {
  const now = new Date();
  const istStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const istDate = new Date(istStr);
  const day = istDate.getDay();
  if (day < 1 || day > 5) return false;
  const minutes = istDate.getHours() * 60 + istDate.getMinutes();
  return minutes >= 555 && minutes <= 930;
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
    const symMap: Record<string, string> = {
      '13': 'NIFTY',
      '25': 'BANKNIFTY',
      '27': 'FINNIFTY',
      '26': 'INDIAVIX',
    };
    const secIds = Object.keys(symMap);

    this.tickInterval = setInterval(async () => {
      if (this.clients.size === 0 || !isIndianMarketOpen()) return;

      try {
        const quote = await this.client.marketFeed.quote({ IDX_I: secIds });
        const idxData = (quote.data as any)?.IDX_I || {};

        for (const [secId, sym] of Object.entries(symMap)) {
          const d = idxData[secId];
          if (!d) continue;

          const ltp = Number(d.lastTradedPrice || d.ltp || 0);
          const prevClose = Number(d.close || d.prevClose || ltp);

          this.broadcast({
            type: 'tick',
            symbol: sym,
            data: {
              securityId: secId,
              ltp,
              change: ltp - prevClose,
              pctChange: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
              volume: Number(d.volume || 0),
              oi: Number(d.oi || 0),
              timestamp: Date.now(),
            },
          });
        }
      } catch {
        // Silent backoff on polling error
      }
    }, 3000);
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
