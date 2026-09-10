/**
 * Live monitor for sandbox adaptive-supertrend dry-runs.
 *
 * Polls the sidecar control + portfolio APIs and tails today's journal
 * for sandbox order intents/results. Run while `npm run dev:server` (or
 * dev:all) is up with TRADING_MODE=sandbox.
 *
 * Usage: npm run watch:sandbox-supertrend
 */
import dotenv from 'dotenv';
dotenv.config();

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { marketClock } from '../src/services/marketHours';

const PORT = Number(process.env.PORT) || 3003;
const BASE = `http://localhost:${PORT}`;
const TOKEN = process.env.CONTROL_PLANE_TOKEN;
const POLL_MS = Number(process.env.WATCH_POLL_MS) || 10_000;
const JOURNAL_DIR = process.env.JOURNAL_DIR || join(process.cwd(), '.journal');
const HISTORY = Number(process.env.WATCH_HISTORY) || 5;

type JournalEntry = { seq: number; ts: number; kind: string; payload: any };

function istTime(ts = Date.now()): string {
  return new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function fmtInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function journalFile(): string {
  return join(JOURNAL_DIR, `${marketClock().istDate}.ndjson`);
}

async function api<T = any>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

function isRelevant(entry: JournalEntry): boolean {
  const p = entry.payload || {};
  if (entry.kind === 'order_intent' || entry.kind === 'order_result') {
    if (p.mode === 'sandbox') return true;
    if (String(p.intent_id || '').includes('adaptive_supertrend')) return true;
    if (String(p.correlation_id || '').includes('adaptive_supertrend')) return true;
    return p.is_paper === false && entry.kind === 'order_result';
  }
  if (entry.kind === 'eod') return true;
  if (entry.kind === 'control_command') {
    const route = String(p.route || '');
    return route.includes('scanner') || route.includes('long-option');
  }
  return false;
}

function formatJournal(entry: JournalEntry): string {
  const p = entry.payload || {};
  const tag = `[${istTime(entry.ts)}] J#${entry.seq} ${entry.kind}`;
  if (entry.kind === 'order_intent') {
    const params = p.params || {};
    return `${tag} ${p.mode || '?'} ${params.transaction_type || ''} ${params.security_id || ''} qty=${params.quantity ?? '?'}`;
  }
  if (entry.kind === 'order_result') {
    const reason = p.reason ? ` — ${p.reason}` : '';
    return `${tag} ${p.status || '?'} ${p.mode || ''} ${p.symbol || p.security_id || ''} qty=${p.quantity ?? '?'}${p.fill_price ? ` @ ${p.fill_price}` : ''}${reason}`;
  }
  if (entry.kind === 'eod') return `${tag} ${p.reason || 'square-off'}`;
  return `${tag} ${JSON.stringify(p)}`;
}

function loadJournal(): JournalEntry[] {
  const file = journalFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as JournalEntry; } catch { return null; } })
    .filter((e): e is JournalEntry => e != null);
}

class JournalTail {
  private offset = 0;
  private seenSeq = new Set<number>();

  constructor(private onLine: (entry: JournalEntry) => void) {
    this.syncOffset();
    const prior = loadJournal().filter(isRelevant);
    const tail = prior.slice(-HISTORY);
    for (const e of tail) {
      this.seenSeq.add(e.seq);
      this.onLine(e);
    }
  }

  private syncOffset(): void {
    const file = journalFile();
    if (!existsSync(file)) { this.offset = 0; return; }
    this.offset = readFileSync(file).length;
  }

  poll(): void {
    const file = journalFile();
    if (!existsSync(file)) return;
    const raw = readFileSync(file, 'utf8');
    if (raw.length <= this.offset) return;
    const chunk = raw.slice(this.offset);
    this.offset = raw.length;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (!isRelevant(entry) || this.seenSeq.has(entry.seq)) continue;
        this.seenSeq.add(entry.seq);
        this.onLine(entry);
      } catch { /* torn line */ }
    }
  }

  rollIfNeeded(): void {
    const file = journalFile();
    if (!existsSync(file)) { this.offset = 0; this.seenSeq.clear(); return; }
    if (this.offset > readFileSync(file).length) this.syncOffset();
  }
}

function printSection(title: string): void {
  console.log(`\n[${istTime()} IST] ── ${title} ──`);
}

type StatusView = {
  reachable: boolean;
  mode?: string;
  system?: string;
  marketOpen?: boolean;
  scanOn?: boolean;
  longPolicyOn?: boolean;
  killed?: boolean;
  cycles?: number;
  lastCycleAgoSec?: number | null;
  equity?: number;
  avail?: number;
  dayPnl?: number;
  open?: Array<{ symbol: string; side: string; qty: number; avg: number; pnl: number }>;
  ratchet?: Array<{ symbol: string; qty: number; peak: number; floor: number; partial: boolean }>;
  scannerBlocked?: string | null;
  scannerSymbols?: Array<{ symbol: string; stage: string; dir1m: number | null; dir5m: number | null; candles1m?: number; candles5m?: number }>;
  nextScanInSec?: number;
  scanIntervalSec?: number;
};

/** Stable fields only — excludes cycle counters and scan countdowns. */
function statusFingerprint(v: StatusView): string {
  const { cycles: _c, lastCycleAgoSec: _l, nextScanInSec: _n, scanIntervalSec: _i, ...stable } = v;
  return JSON.stringify(stable);
}

async function fetchStatus(): Promise<StatusView> {
  const [health, state, summary, policy, scanner] = await Promise.all([
    api<any>('/api/health'),
    api<any>('/api/control/state'),
    api<any>('/api/portfolio/summary'),
    api<any>('/api/control/long-option-policy'),
    api<any>('/api/control/adaptive-supertrend'),
  ]);
  if (!health || health.status !== 'ok') return { reachable: false };

  const clock = state?.autonomy?.clock;
  const wallet = summary?.wallet || {};
  const open = (summary?.positions || []).filter((p: any) => p.netQty !== 0);

  return {
    reachable: true,
    mode: health.mode,
    system: state?.systemState || 'unknown',
    marketOpen: !!clock?.isMarketOpen,
    scanOn: !!state?.autonomy?.scanEnabled,
    longPolicyOn: !!policy?.enabled,
    killed: !!health.killed,
    cycles: state?.autonomy?.cycles ?? 0,
    lastCycleAgoSec: state?.autonomy?.lastCycleAgoSec ?? null,
    equity: wallet.equity ?? 0,
    avail: wallet.availableMargin ?? 0,
    dayPnl: wallet.sessionRealizedPnl ?? 0,
    open: open.map((p: any) => ({
      symbol: p.tradingSymbol,
      side: p.netQty > 0 ? 'LONG' : 'SHORT',
      qty: Math.abs(p.netQty),
      avg: p.buyAvg || p.sellAvg,
      pnl: p.pnl ?? 0,
    })),
    ratchet: (policy?.positions || []).map((s: any) => ({
      symbol: s.tradingSymbol, qty: s.remainingQuantity,
      peak: s.peakNet, floor: s.floorNet, partial: s.partialTaken,
    })),
    scannerBlocked: scanner?.canTrade ? null : (scanner?.tradeBlockReason || 'risk gate'),
    scannerSymbols: (scanner?.symbols || []).map((s: any) => ({
      symbol: s.symbol, stage: s.stage, dir1m: s.dir1m ?? null, dir5m: s.dir5m ?? null,
      candles1m: s.candles1m, candles5m: s.candles5m,
    })),
    nextScanInSec: scanner?.nextScanInSec,
    scanIntervalSec: scanner?.scanIntervalSec,
  };
}

function renderStatus(v: StatusView): void {
  if (!v.reachable) {
    printSection('Waiting for sidecar');
    console.log(`  ${BASE} not reachable — is dev:server running?`);
    return;
  }

  printSection('Sandbox supertrend watch');
  if (v.system !== 'READY') {
    console.log(`  *** SYSTEM ${v.system} — new orders BLOCKED. Run: curl -X POST ${BASE}/api/control/reconcile-boot`);
  }
  console.log(`  mode=${v.mode}  system=${v.system}  market=${v.marketOpen ? 'OPEN' : 'closed'}  scan=${v.scanOn ? 'on' : 'off'}  long-policy=${v.longPolicyOn ? 'on' : 'off'}`);
  console.log(`  autonomy cycles=${v.cycles}  last=${v.lastCycleAgoSec ?? '?'}s ago  killed=${v.killed}`);
  console.log(`  equity=${fmtInr(v.equity ?? 0)}  avail=${fmtInr(v.avail ?? 0)}  dayPnl=${fmtInr(v.dayPnl ?? 0)}  open=${v.open?.length ?? 0}`);

  for (const p of v.open || []) {
    console.log(`  • ${p.symbol} ${p.side} x${p.qty} avg=${p.avg} pnl=${fmtInr(p.pnl)}`);
  }

  if ((v.ratchet || []).length > 0) {
    console.log('  long-option ratchet:');
    for (const s of v.ratchet!) {
      console.log(`    ${s.symbol} qty=${s.qty} peak=${fmtInr(s.peak)} floor=${fmtInr(s.floor)} partial=${s.partial}`);
    }
  }

  if (v.scannerSymbols?.length) {
    const block = v.scannerBlocked ? ` BLOCKED: ${v.scannerBlocked}` : '';
    console.log(`  scanner: next scan ${v.nextScanInSec}s  interval=${v.scanIntervalSec}s${block}`);
    for (const s of v.scannerSymbols) {
      const bars = `${s.candles1m ?? '?'}/${s.candles5m ?? '?'} bars`;
      console.log(`    ${s.symbol.padEnd(10)} ${s.stage.padEnd(32)} 1m=${s.dir1m ?? '-'} 5m=${s.dir5m ?? '-'}  (${bars})`);
    }
  }
}

async function pollStatus(lastFingerprint: string | null, force = false): Promise<{ alive: boolean; fingerprint: string | null }> {
  const view = await fetchStatus();
  const fp = statusFingerprint(view);
  if (force || fp !== lastFingerprint) renderStatus(view);
  return { alive: view.reachable, fingerprint: fp };
}

async function main(): Promise<void> {
  const mode = process.env.TRADING_MODE || 'paper';
  if (mode !== 'sandbox') {
    console.warn(`WARN: TRADING_MODE=${mode} (expected sandbox). API reads may show paper data.`);
  }

  console.log(`Watching ${BASE}  journal=${journalFile()}  poll=${POLL_MS}ms  (status logs on change only)`);
  const tail = new JournalTail((entry) => console.log(`  ${formatJournal(entry)}`));

  let fingerprint: string | null = null;
  const first = await pollStatus(null, true);
  fingerprint = first.fingerprint;
  if (!first.alive) console.log('Retrying until the sidecar is up…');

  setInterval(() => tail.poll(), 2000);
  setInterval(async () => {
    tail.rollIfNeeded();
    const result = await pollStatus(fingerprint);
    fingerprint = result.fingerprint;
  }, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
