import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Journal, summarizeDay, type JournalEntry } from '../services/journal';

describe('Journal', () => {
  let dir: string;
  const origDir = process.env.JOURNAL_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'journal-test-'));
    process.env.JOURNAL_DIR = dir;
  });

  afterEach(() => {
    process.env.JOURNAL_DIR = origDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes entries to a file scoped to the given trading day', async () => {
    const j = new Journal();
    j.open('2026-03-10');
    j.append('kill', { action: 'arm', reason: 'test' });
    await j.close();

    const raw = readFileSync(join(dir, '2026-03-10.ndjson'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.kind).toBe('kill');
    expect(entry.payload).toEqual({ action: 'arm', reason: 'test' });
    expect(entry.seq).toBe(1);
    expect(typeof entry.ts).toBe('number');
  });

  it('assigns a strictly increasing seq across entries', async () => {
    const j = new Journal();
    j.open('2026-03-10');
    const a = j.append('control_command', { route: 'POST /kill' });
    const b = j.append('control_command', { route: 'POST /kill/reset' });
    const c = j.append('eod', { reason: 'EOD', closed: 3 });
    await j.close();
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });

  it('reads back prior entries on reopen (simulates a restart the same trading day) and continues the seq', async () => {
    const first = new Journal();
    first.open('2026-03-10');
    first.append('order_intent', { correlation_id: 'a' });
    first.append('order_result', { correlation_id: 'a', status: 'TRADED' });
    await first.close();

    const second = new Journal();
    const prior = second.open('2026-03-10');
    expect(prior.length).toBe(2);
    expect(prior[0].kind).toBe('order_intent');
    expect(prior[1].kind).toBe('order_result');

    const next = second.append('kill', { action: 'arm' });
    expect(next.seq).toBe(3); // continues from the prior file's max seq, not reset to 1
    await second.close();
  });

  it('keeps separate days in separate files, each with its own seq starting at 1', async () => {
    const j = new Journal();
    j.open('2026-03-10');
    j.append('eod', { reason: 'day 1' });
    j.append('eod', { reason: 'day 1 again' }); // day 1 ends at seq 2

    const prior = j.open('2026-03-11'); // a new day, same still-running process — must not carry day 1's seq
    expect(prior.length).toBe(0);
    const entry = j.append('eod', { reason: 'day 2' });
    expect(entry.seq).toBe(1); // NOT 3 — a new file is a new seq space
    await j.close();

    const day1 = readFileSync(join(dir, '2026-03-10.ndjson'), 'utf8');
    const day2 = readFileSync(join(dir, '2026-03-11.ndjson'), 'utf8');
    expect(JSON.parse(day1.trim().split('\n')[0])).toMatchObject({ payload: { reason: 'day 1' } });
    expect(JSON.parse(day2.trim())).toMatchObject({ payload: { reason: 'day 2' } });
  });

  it('skips a torn final line from an unclean shutdown without losing the entries before it', async () => {
    const j = new Journal();
    j.open('2026-03-10');
    j.append('kill', { action: 'arm' });
    j.append('kill', { action: 'disarm' });
    await j.close();

    // Simulate a process killed mid-write: append a truncated JSON fragment.
    const file = join(dir, '2026-03-10.ndjson');
    writeFileSync(file, readFileSync(file, 'utf8') + '{"seq":3,"ts":1,"kind":"kill","payl');

    const second = new Journal();
    const prior = second.open('2026-03-10');
    expect(prior.length).toBe(2); // the two intact entries, torn line dropped
    expect(prior.map((e) => e.payload.action)).toEqual(['arm', 'disarm']);
    await second.close();
  });

  it('never drops an entry because open() was not called first — self-opens on first append', async () => {
    const j = new Journal();
    const entry = j.append('control_command', { route: 'POST /autonomy' });
    expect(entry.seq).toBe(1);
    await j.close();
  });

  it('self-opening on first append still continues the seq from an existing file, not restart at 1', async () => {
    // Regression test: append() used to compute `seq: ++this.seq` BEFORE
    // checking whether it needed to self-open. On a fresh Journal instance
    // (this.seq starts at 0) writing into a day that already has entries
    // from an earlier boot, that built the entry with seq 1 — then the
    // self-open call immediately after reset seq to 0 and re-derived it
    // from the file's real max (e.g. 57), leaving the counter at 57 for
    // every SUBSEQUENT append while the entry just written stayed
    // mislabeled seq 1, duplicating an existing line's sequence number.
    // No explicit date on either side — both open() (first) and append()'s
    // internal self-open (second) resolve today's real IST date the same
    // way, so they land in the same file. Passing a hardcoded date to only
    // one side would make them write to different files and pass for the
    // wrong reason.
    const first = new Journal();
    first.open();
    const todaysDate = first.currentSessionDate();
    first.append('order_intent', { correlation_id: 'a' });
    first.append('order_result', { correlation_id: 'a', status: 'TRADED' });
    await first.close(); // day so far ends at seq 2, file closed — simulates process exit

    const second = new Journal(); // simulates a restart — open() not called yet
    const entry = second.append('kill', { action: 'arm' }); // self-opens internally
    expect(entry.seq).toBe(3); // continues from the file's max, not 1
    await second.close();

    const raw = readFileSync(join(dir, `${second.currentSessionDate()}.ndjson`), 'utf8');
    expect(second.currentSessionDate()).toEqual(todaysDate);
    const seqs = raw.trim().split('\n').map((l) => JSON.parse(l).seq);
    expect(seqs).toEqual([1, 2, 3]); // no duplicate/out-of-order seq
  });

  it('close() resolves only once the write stream has actually finished, not merely scheduled', async () => {
    // The bug this guards against: close() used to return void immediately
    // after calling stream.end() (which only SCHEDULES the flush) — a
    // caller reading the file right after close() could race an
    // incompletely-flushed write. Awaiting close() must guarantee the read
    // that follows sees everything written before it.
    const j = new Journal();
    j.open('2026-03-10');
    for (let i = 0; i < 50; i++) j.append('order_intent', { correlation_id: `c${i}` });
    await j.close();

    const lines = readFileSync(join(dir, '2026-03-10.ndjson'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(50);
  });
});

describe('summarizeDay', () => {
  function entry(seq: number, kind: JournalEntry['kind'], payload: any): JournalEntry {
    return { seq, ts: seq, kind, payload };
  }

  it('collects the correlation_id of every TRADED order_result, in order', () => {
    const entries: JournalEntry[] = [
      entry(1, 'order_intent', { correlation_id: 'a' }),
      entry(2, 'order_result', { correlation_id: 'a', status: 'TRADED' }),
      entry(3, 'order_result', { correlation_id: 'b', status: 'REJECTED', reason: 'no LTP' }),
      entry(4, 'order_result', { correlation_id: 'c', status: 'TRADED' }),
    ];
    expect(summarizeDay(entries).tradedCorrelationIds).toEqual(['a', 'c']);
  });

  it('ignores a TRADED result with no correlation_id rather than pushing undefined', () => {
    const entries: JournalEntry[] = [entry(1, 'order_result', { status: 'TRADED' })];
    expect(summarizeDay(entries).tradedCorrelationIds).toEqual([]);
  });

  it('reports the LAST kill-switch action seen, not the first', () => {
    const entries: JournalEntry[] = [
      entry(1, 'kill', { action: 'arm', reason: 'daily loss' }),
      entry(2, 'kill', { action: 'disarm' }),
      entry(3, 'kill', { action: 'arm', reason: 'manual' }),
    ];
    expect(summarizeDay(entries).lastKillAction).toBe('arm');
  });

  it('reports null kill action when the day has none', () => {
    const entries: JournalEntry[] = [entry(1, 'control_command', { route: 'POST /autonomy' })];
    expect(summarizeDay(entries).lastKillAction).toBeNull();
  });

  it('handles an empty day', () => {
    expect(summarizeDay([])).toEqual({ tradedCorrelationIds: [], lastKillAction: null });
  });
});
