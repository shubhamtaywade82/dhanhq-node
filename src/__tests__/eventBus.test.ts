import { EventBus, eventBus } from '../services/eventBus';
import { marketClock, isIndianMarketOpen } from '../services/marketHours';

describe('EventBus', () => {
  it('delivers channel-filtered events to local subscribers', () => {
    const bus = new EventBus();
    const ticks: any[] = [];
    const logs: any[] = [];
    bus.on('tick', (e) => ticks.push(e.payload));
    bus.on('log', (e) => logs.push(e.payload));

    bus.emit('tick', { symbol: 'NIFTY', ltp: 24250 });
    bus.emit('log', { level: 'INFO', message: 'hello' });

    expect(ticks).toEqual([{ symbol: 'NIFTY', ltp: 24250 }]);
    expect(logs).toEqual([{ level: 'INFO', message: 'hello' }]);
  });

  it('fans out to attached ws clients and records history for hydration', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.attachWsClient((env) => received.push(env.channel));
    bus.emit('alert', { level: 'WARN' });
    bus.emit('telemetry', { agent: 'planner' });
    expect(received).toEqual(['alert', 'telemetry']);
    expect(bus.recent().length).toBe(2);
    expect(bus.recent(undefined, ['alert']).length).toBe(1);
  });

  it('survives a throwing ws client without dropping other clients', () => {
    const bus = new EventBus();
    const ok: string[] = [];
    bus.attachWsClient(() => { throw new Error('dead socket'); });
    bus.attachWsClient((env) => ok.push(env.channel));
    expect(() => bus.emit('system', { type: 'boot' })).not.toThrow();
    expect(ok).toEqual(['system']);
  });

  it('keeps a per-channel history — a burst of ticks does not evict log/alert history', () => {
    // Previously one 500-envelope buffer was shared across every channel;
    // a tick storm (every instrument, every price move) would push
    // logs/alerts/telemetry out of the buffer within seconds of market
    // open, so a newly-attaching client's hydration snapshot was ticks and
    // nothing else. Each channel must keep its own history now.
    const bus = new EventBus();
    bus.emit('log', { message: 'before the storm' });
    for (let i = 0; i < 600; i++) bus.emit('tick', { securityId: '13', ltp: 24000 + i });

    const logs = bus.recent(undefined, ['log']);
    expect(logs.length).toBe(1);
    expect(logs[0].payload.message).toBe('before the storm');

    // The tick channel's own buffer is still bounded (ring, not unbounded).
    const ticks = bus.recent(undefined, ['tick']);
    expect(ticks.length).toBeLessThan(600);
    expect(ticks[ticks.length - 1].payload.ltp).toBe(24000 + 599); // newest survives
  });

  it('recent() merges multiple channels sorted oldest-first', () => {
    const bus = new EventBus();
    bus.emit('log', { n: 1 });
    bus.emit('alert', { n: 2 });
    bus.emit('log', { n: 3 });
    const merged = bus.recent(undefined, ['log', 'alert']);
    expect(merged.map((e) => e.payload.n)).toEqual([1, 2, 3]);
  });
});

describe('MarketHours (IST-bound)', () => {
  it('classifies weekday 10:00 IST as market open', () => {
    // Monday 2026-01-05 04:30 UTC == 10:00 IST
    const clock = marketClock(new Date('2026-01-05T04:30:00Z'));
    expect(clock.isMarketOpen).toBe(true);
    expect(clock.isWeekday).toBe(true);
  });

  it('classifies Saturday as closed regardless of time', () => {
    const clock = marketClock(new Date('2026-01-03T07:00:00Z')); // Saturday 12:30 IST
    expect(clock.isMarketOpen).toBe(false);
    expect(clock.isWeekday).toBe(false);
  });

  it('recognizes the EOD square-off window (15:20–15:30 IST)', () => {
    const clock = marketClock(new Date('2026-01-05T09:45:00Z')); // 15:15 IST → not yet
    expect(clock.squareOffWindow).toBe(false);
    const inWindow = marketClock(new Date('2026-01-05T09:50:00Z')); // 15:20 IST → in window
    expect(inWindow.squareOffWindow).toBe(true);
    const after = marketClock(new Date('2026-01-05T10:00:00Z')); // 15:30 IST → closed
    expect(after.squareOffWindow).toBe(false);
    expect(after.isMarketOpen).toBe(false);
  });

  it('isIndianMarketOpen matches the clock', () => {
    expect(isIndianMarketOpen(new Date('2026-01-05T04:30:00Z'))).toBe(true);
    expect(isIndianMarketOpen(new Date('2026-01-03T04:30:00Z'))).toBe(false);
  });
});

describe('Event bus singleton', () => {
  it('exposes a shared log helper', () => {
    const events: any[] = [];
    const off = eventBus.on('log', (e) => events.push(e.payload));
    eventBus.log('INFO', 'test message', 'test');
    off();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ level: 'INFO', message: 'test message', source: 'test' });
  });
});
