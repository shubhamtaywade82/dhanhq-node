import dotenv from 'dotenv';
dotenv.config();

import { createDhanClient } from '../src/auth';

interface InstrumentConfig {
  symbol: string;
  securityId: string;
  exchangeSegment: string;
}

const INSTRUMENTS: readonly InstrumentConfig[] = [
  { symbol: 'NIFTY 50', securityId: '13', exchangeSegment: 'IDX_I' },
  { symbol: 'SENSEX', securityId: '51', exchangeSegment: 'IDX_I' },
];

const SYMBOL_BY_ID: Record<string, string> = Object.fromEntries(
  INSTRUMENTS.map((inst) => [inst.securityId, inst.symbol]),
);

function formatPrice(value: number): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatChange(ltp: number, prevClose: number): string {
  if (!prevClose) return '';
  const diff = ltp - prevClose;
  const pct = (diff / prevClose) * 100;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${formatPrice(diff)} (${sign}${pct.toFixed(2)}%)`;
}

function getIstTime(): string {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  });
}

function logInitialSnapshot(quoteMap: any, prevCloseMap: Map<string, number>): void {
  console.log(`\n[${getIstTime()} IST] ── Initial Market Snapshot ──`);
  for (const inst of INSTRUMENTS) {
    const data = quoteMap?.[inst.exchangeSegment]?.[inst.securityId];
    if (!data) continue;

    const ltp = Number(data.last_price || data.ltp || 0);
    const prevClose = Number(data.ohlc?.close || data.prevClose || ltp);
    const open = Number(data.ohlc?.open || data.open || ltp);
    const high = Number(data.ohlc?.high || data.high || ltp);
    const low = Number(data.ohlc?.low || data.low || ltp);

    prevCloseMap.set(inst.securityId, prevClose);
    const change = formatChange(ltp, prevClose);

    console.log(
      `  • ${inst.symbol.padEnd(9)} | LTP: ${formatPrice(ltp).padStart(9)} | Change: ${change.padStart(16)} | O: ${formatPrice(open)} | H: ${formatPrice(high)} | L: ${formatPrice(low)} | PrevClose: ${formatPrice(prevClose)}`,
    );
  }
  console.log(`[${getIstTime()} IST] ── Streaming Live WebSocket Ticks (Ctrl+C to stop) ──\n`);
}

function handleTick(tick: any, prevCloseMap: Map<string, number>): void {
  const secId = String(tick.securityId ?? '');
  const symbol = SYMBOL_BY_ID[secId] || `SEC_${secId}`;

  // Dhan sends prev-close packets on connect to establish baseline
  if (tick.type === 'prev-close' && typeof tick.previousClose === 'number') {
    prevCloseMap.set(secId, tick.previousClose);
    return;
  }

  const ltp = Number(tick.ltp ?? tick.lastTradedPrice ?? 0);
  if (!ltp) return;

  const prevClose = prevCloseMap.get(secId) || 0;
  const change = prevClose ? ` | Change: ${formatChange(ltp, prevClose)}` : '';

  console.log(
    `[${getIstTime()} IST] [${symbol.padEnd(8)}] LTP: ${formatPrice(ltp).padStart(9)}${change}`,
  );
}

function setupShutdown(marketWs: any): void {
  const shutdown = () => {
    console.log(`\n[${getIstTime()} IST] Disconnecting from DhanHQ WebSocket...`);
    try {
      marketWs.disconnect();
    } catch {
      // Ignore disconnect errors during process exit
    }
    console.log(`[${getIstTime()} IST] Exited cleanly.`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  console.log(`[${getIstTime()} IST] Initializing DhanHQ client...`);
  const client = await createDhanClient();

  const prevCloseMap = new Map<string, number>();

  // Fetch initial quote via REST so baseline OHLC and previous close are known immediately
  try {
    const secIds = INSTRUMENTS.map((inst) => inst.securityId);
    const quoteRes = await client.marketFeed.quote({ IDX_I: secIds });
    logInitialSnapshot(quoteRes.data, prevCloseMap);
  } catch (err: any) {
    // Non-fatal: WebSocket ticks will still stream if REST quote fails
    console.warn(`[${getIstTime()} IST] Warning: Initial REST quote fetch failed (${err.message})`);
  }

  const marketWs = (client as any).ws.market;
  // Index instruments on DhanHQ binary WebSocket require ticker mode (RequestCode 15)
  marketWs.mode = 'ticker';

  marketWs.on('open', () => {
    console.log(`[${getIstTime()} IST] WebSocket connected. Subscribing to NIFTY 50 and SENSEX...`);
    marketWs.subscribe(
      INSTRUMENTS.map((inst) => ({
        exchangeSegment: inst.exchangeSegment,
        securityId: inst.securityId,
      })),
    );
  });

  marketWs.on('tick', (tick: any) => handleTick(tick, prevCloseMap));
  marketWs.on('error', (err: any) => console.error(`[${getIstTime()} IST] WebSocket error:`, err?.message || err));
  marketWs.on('close', () => console.log(`[${getIstTime()} IST] WebSocket connection closed.`));

  setupShutdown(marketWs);
  await marketWs.connect();
}

main().catch((err) => {
  console.error(`[${getIstTime()} IST] Fatal error:`, err.message || err);
  process.exit(1);
});
