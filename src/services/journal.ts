import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'fs';
import { join } from 'path';
import { moduleLogger } from '../lib/logger';
import { marketClock } from './marketHours';

const log = moduleLogger('journal');

/**
 * Append-only durable record of the decisions this system makes — the
 * thing to read after a crash or an unexpected outcome, distinct from
 * Postgres (current position/wallet state) and from stdout logs (verbose,
 * not queryable by kind, rotated away by the host).
 *
 * Scope for this pass: a durable, queryable AUDIT TRAIL — order intents and
 * their results, risk decisions (breaker trips, kill/disarm), EOD/square-off
 * events, and every control-plane command an operator issues. NOT tick
 * data (a separate, much higher-volume concern with its own tradeoffs) and
 * NOT yet used to reconstruct in-memory state on boot — this establishes
 * the durable record and the call sites that write to it; replaying it to
 * rebuild state after a crash is a follow-up, not done here.
 *
 * One file per IST trading day (JOURNAL_DIR/YYYY-MM-DD.ndjson), so a day's
 * journal is a bounded, easy-to-ship artifact and old days can be archived
 * or deleted independently. A monotonic per-process `seq` orders entries
 * unambiguously even when two land in the same millisecond.
 */

export type JournalKind =
  | 'order_intent'      // an order about to be placed (paper or live)
  | 'order_result'      // its outcome: TRADED / REJECTED / error
  | 'risk_decision'      // a circuit breaker's state transition
  | 'kill'               // kill switch armed/disarmed
  | 'eod'                // EOD/manual square-off
  | 'control_command';   // an operator action via the control-plane API

export interface JournalEntry<T = any> {
  seq: number;
  ts: number;
  kind: JournalKind;
  payload: T;
}

// A function, not a module-load-time constant — resolved fresh on every
// open() call so JOURNAL_DIR can be set per-test (or genuinely change
// between an open() call and the next) without needing the module
// reloaded, which a cached `const DIR = process.env.JOURNAL_DIR ...`
// evaluated once at import time would silently ignore.
function journalDir(): string {
  return process.env.JOURNAL_DIR || join(process.cwd(), '.journal');
}

export class Journal {
  private seq = 0;
  private stream: WriteStream | null = null;
  private sessionDate = '';

  /**
   * Opens today's journal file, returning whatever it already contains
   * (e.g. from an earlier boot the same trading day) for diagnostics. Any
   * previously-open file is closed first — callers only need to call this
   * once at boot; the autonomy loop's day-rollover is handled by calling
   * this again when the IST date changes.
   */
  open(sessionDate: string = marketClock().istDate): JournalEntry[] {
    // Not awaited: the previous stream (if any) points at a DIFFERENT file
    // (a different day), so it flushes independently on its own — nothing
    // here is about to exit the process. Only a caller about to exit needs
    // to await close() directly (see server.ts's shutdown handler).
    void this.close();
    this.sessionDate = sessionDate;
    // seq is scoped to the file being opened, not to the process — without
    // resetting here, switching from one trading day to the next inside a
    // still-running process (a boot that spans midnight, or the autonomy
    // loop's day rollover) would carry the previous day's counter into a
    // brand new, otherwise-empty file instead of starting it at 1.
    this.seq = 0;
    const dir = journalDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionDate}.ndjson`);

    const prior: JournalEntry[] = [];
    if (existsSync(file)) {
      let raw = '';
      try {
        raw = readFileSync(file, 'utf8');
      } catch (e: any) {
        log.warn({ err: { message: e.message }, file }, 'Failed to read existing journal — starting fresh append');
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as JournalEntry;
          prior.push(entry);
          if (entry.seq > this.seq) this.seq = entry.seq;
        } catch {
          // A torn final line from an unclean shutdown — everything before
          // it parsed fine and is intact; this is expected, not corruption.
        }
      }
    }

    this.stream = createWriteStream(file, { flags: 'a' });
    this.stream.on('error', (e) => log.error({ err: { message: e.message }, file }, 'Journal write stream error'));
    log.info({ file, priorEntries: prior.length }, 'Journal opened');
    return prior;
  }

  /** Records one entry and flushes it immediately — a decision worth
   * journaling is worth journaling durably before this function returns,
   * not batched and lost if the process dies in the next few seconds. */
  append<T>(kind: JournalKind, payload: T): JournalEntry<T> {
    const entry: JournalEntry<T> = { seq: ++this.seq, ts: Date.now(), kind, payload };
    if (!this.stream) {
      // Never silently drop a decision because open() wasn't called yet —
      // that would defeat the entire point during exactly the boot window
      // most likely to have surprises.
      this.open();
    }
    try {
      this.stream!.write(JSON.stringify(entry) + '\n');
    } catch (e: any) {
      log.error({ err: { message: e.message }, kind }, 'Journal append failed');
    }
    return entry;
  }

  currentSessionDate(): string {
    return this.sessionDate;
  }

  /** Resolves once the stream has actually finished flushing to disk —
   * WriteStream.end() only SCHEDULES the flush. A caller that exits the
   * process right after calling close() (server.ts's shutdown handler)
   * would otherwise race the flush and could lose the last few entries
   * written in that same shutdown, which is exactly when a decision is
   * most worth having durably recorded. */
  close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }
}

/** Process-wide singleton, matching eventBus's pattern — every service
 * that needs to journal a decision imports this directly rather than
 * threading a Journal instance through every constructor. */
export const journal = new Journal();
