import { WebSocket } from 'ws';
import { MarketStreamManager } from '../ws/marketStream';
import { eventBus } from '../services/eventBus';

/** Minimal fake socket — just enough surface for MarketStreamManager to
 * drive: readyState, bufferedAmount (mutable, for backpressure), send,
 * and the on() handlers it registers (message/close/error), which this
 * test doesn't need to fire. */
function fakeSocket(): { sent: any[]; ws: WebSocket; setBuffered: (n: number) => void } {
  const sent: any[] = [];
  let bufferedAmount = 0;
  const ws: any = {
    readyState: WebSocket.OPEN,
    get bufferedAmount() { return bufferedAmount; },
    send: (data: string) => sent.push(JSON.parse(data)),
    on: () => {},
  };
  return { sent, ws: ws as WebSocket, setBuffered: (n: number) => { bufferedAmount = n; } };
}

describe('MarketStreamManager — tick conflation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('conflates a burst of ticks for the same instrument into one send per flush', () => {
    const mgr = new MarketStreamManager();
    mgr.attach();
    const { sent, ws } = fakeSocket();
    mgr.subscribe(ws);
    sent.length = 0; // discard the connect/hydration envelopes

    for (let i = 0; i < 20; i++) {
      eventBus.emit('tick', { securityId: '13', data: { ltp: 24000 + i } });
    }
    // Nothing sent yet — ticks are buffered until the flush interval fires.
    expect(sent.filter((e) => e.channel === 'tick').length).toBe(0);

    jest.advanceTimersByTime(150);
    const tickSends = sent.filter((e) => e.channel === 'tick');
    expect(tickSends.length).toBe(1); // 20 ticks on one instrument → one send
    expect(tickSends[0].payload.data.ltp).toBe(24019); // the LATEST, not the first

    mgr.unsubscribe(ws);
  });

  it('does not conflate across different instruments', () => {
    const mgr = new MarketStreamManager();
    mgr.attach();
    const { sent, ws } = fakeSocket();
    mgr.subscribe(ws);
    sent.length = 0;

    eventBus.emit('tick', { securityId: '13', data: { ltp: 24000 } });
    eventBus.emit('tick', { securityId: '25', data: { ltp: 57000 } });
    jest.advanceTimersByTime(150);

    const tickSends = sent.filter((e) => e.channel === 'tick');
    expect(tickSends.length).toBe(2);

    mgr.unsubscribe(ws);
  });

  it('never conflates non-tick envelopes — every fill/alert/log is delivered', () => {
    const mgr = new MarketStreamManager();
    mgr.attach();
    const { sent, ws } = fakeSocket();
    mgr.subscribe(ws);
    sent.length = 0;

    eventBus.emit('order', { kind: 'fill', symbol: 'A' });
    eventBus.emit('order', { kind: 'fill', symbol: 'B' });
    eventBus.log('INFO', 'first', 'test');
    eventBus.log('INFO', 'second', 'test');

    // Discrete channels are sent immediately, no flush wait needed.
    expect(sent.filter((e) => e.channel === 'order').length).toBe(2);
    expect(sent.filter((e) => e.channel === 'log').length).toBe(2);

    mgr.unsubscribe(ws);
  });
});

describe('MarketStreamManager — backpressure', () => {
  it('drops rather than queues once a client falls behind, and counts the drop', () => {
    const mgr = new MarketStreamManager();
    mgr.attach();
    const { sent, ws, setBuffered } = fakeSocket();
    mgr.subscribe(ws);
    sent.length = 0;

    setBuffered(2 * 1024 * 1024); // 2 MiB — over the 1 MiB threshold
    eventBus.log('WARN', 'should be dropped', 'test');

    expect(sent.filter((e) => e.channel === 'log').length).toBe(0);
    expect(mgr.stats().totalDropped).toBeGreaterThanOrEqual(1);

    mgr.unsubscribe(ws);
  });

  it('resumes delivering once the client drains its buffer', () => {
    const mgr = new MarketStreamManager();
    mgr.attach();
    const { sent, ws, setBuffered } = fakeSocket();
    mgr.subscribe(ws);
    sent.length = 0;

    setBuffered(2 * 1024 * 1024);
    eventBus.log('WARN', 'dropped', 'test');
    setBuffered(0);
    eventBus.log('WARN', 'delivered', 'test');

    const logs = sent.filter((e) => e.channel === 'log');
    expect(logs.length).toBe(1);
    expect(logs[0].payload.message).toBe('delivered');

    mgr.unsubscribe(ws);
  });
});

describe('MarketStreamManager — per-channel hydration', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a tick storm before connect does not starve a new client of log/alert hydration', () => {
    // Simulate a busy trading session that ran before this client ever
    // connected: far more ticks than the log/alert history depth. Uniquely
    // tagged log/alert so this passes only if THEY specifically survived —
    // not just "some log/alert exists" from bleed-over in the shared
    // eventBus singleton across tests in this file.
    for (let i = 0; i < 200; i++) eventBus.emit('tick', { securityId: '13', data: { ltp: 24000 + i } });
    eventBus.log('INFO', 'hydration-marker-log', 'test');
    eventBus.emit('alert', { level: 'WARN', msg: 'hydration-marker-alert' });

    const mgr = new MarketStreamManager();
    mgr.attach();
    const { sent, ws } = fakeSocket();
    mgr.subscribe(ws); // hydration runs synchronously here
    jest.advanceTimersByTime(150); // let any hydrated ticks flush

    expect(sent.some((e) => e.channel === 'log' && e.payload.message === 'hydration-marker-log')).toBe(true);
    expect(sent.some((e) => e.channel === 'alert' && e.payload.msg === 'hydration-marker-alert')).toBe(true);

    mgr.unsubscribe(ws);
  });
});
