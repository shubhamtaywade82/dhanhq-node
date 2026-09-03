import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Journal } from '../services/journal';

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
