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
    return `${tag} ${p.status || '?'} ${p.mode || ''} ${p.symbol || ''} ${p.transaction_type || ''} qty=${p.quantity ?? '?'}${p.fill_price ? ` @ ${p.fill_price}` : ''}`;
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

async function printStatus(): Promise<boolean> {
  const [health, state, summary, policy, scanner] = await Promise.all([
    api<any>('/api/health'),
    api<any>('/api/control/state'),
    api<any>('/api/portfolio/summary'),
    api<any>('/api/control/long-option-policy'),
    api<any>('/api/control/adaptive-supertrend'),
  ]);
  if (!health || health.status !== 'ok') {
    printSection('Waiting for sidecar');
    console.log(`  ${BASE} not reachable — is dev:server running?`);
    return false;
  }

  const clock = state?.autonomy?.clock;
  const wallet = summary?.wallet || {};
  const open = (summary?.positions || []).filter((p: any) => p.netQty !== 0);

  printSection('Sandbox supertrend watch');
  const sys = state?.systemState || 'unknown';
  if (sys !== 'READY') {
    console.log(`  *** SYSTEM ${sys} — new orders BLOCKED. Run: curl -X POST ${BASE}/api/control/reconcile-boot`);
  }
  console.log(`  mode=${health.mode}  system=${sys}  market=${clock?.isMarketOpen ? 'OPEN' : 'closed'}  scan=${state?.autonomy?.scanEnabled ? 'on' : 'off'}  long-policy=${policy?.enabled ? 'on' : 'off'}`);
  console.log(`  autonomy cycles=${state?.autonomy?.cycles ?? 0}  last=${state?.autonomy?.lastCycleAgoSec ?? '?'}s ago  killed=${health.killed}`);
  console.log(`  equity=${fmtInr(wallet.equity ?? 0)}  avail=${fmtInr(wallet.availableMargin ?? 0)}  dayPnl=${fmtInr(wallet.sessionRealizedPnl ?? 0)}  open=${open.length}`);

  for (const p of open) {
    const side = p.netQty > 0 ? 'LONG' : 'SHORT';
    console.log(`  • ${p.tradingSymbol} ${side} x${Math.abs(p.netQty)} avg=${p.buyAvg || p.sellAvg} pnl=${fmtInr(p.pnl ?? 0)}`);
  }

  const tracked = policy?.positions || [];
  if (tracked.length > 0) {
    console.log('  long-option ratchet:');
    for (const s of tracked) {
      console.log(`    ${s.tradingSymbol} qty=${s.remainingQuantity} peak=${fmtInr(s.peakNet)} floor=${fmtInr(s.floorNet)} partial=${s.partialTaken}`);
    }
  }

  if (scanner?.symbols) {
    const block = scanner.canTrade ? '' : ` BLOCKED: ${scanner.tradeBlockReason || 'risk gate'}`;
    console.log(`  scanner: next scan ${scanner.nextScanInSec}s  interval=${scanner.scanIntervalSec}s${block}`);
    for (const s of scanner.symbols) {
      const dirs = `1m=${s.dir1m ?? '-'} 5m=${s.dir5m ?? '-'}`;
      console.log(`    ${s.symbol.padEnd(10)} ${s.stage.padEnd(28)} ${dirs}`);
    }
  }
  return true;
}

async function main(): Promise<void> {
  const mode = process.env.TRADING_MODE || 'paper';
  if (mode !== 'sandbox') {
    console.warn(`WARN: TRADING_MODE=${mode} (expected sandbox). API reads may show paper data.`);
  }

  console.log(`Watching ${BASE}  journal=${journalFile()}  poll=${POLL_MS}ms`);
  const tail = new JournalTail((entry) => console.log(`  ${formatJournal(entry)}`));

  let alive = await printStatus();
  if (!alive) console.log('Retrying until the sidecar is up…');

  setInterval(() => tail.poll(), 2000);
  setInterval(async () => {
    tail.rollIfNeeded();
    await printStatus();
  }, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
