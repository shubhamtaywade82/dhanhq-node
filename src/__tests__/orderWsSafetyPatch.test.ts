import { OrderUpdateWS } from '@nemesis-oss/dhanhq-sdk';
import { patchOrderWsSafety } from '../services/marketData';

// Regression coverage: the two patches installed here used to share one
// `__safetyPatched` flag name across two prototypes in the SAME chain
// (BaseWS.prototype is OrderUpdateWS.prototype's direct parent). Setting it
// on the base prototype made a plain read of
// `OrderUpdateWS.prototype.__safetyPatched` resolve to `true` too, via
// inheritance, even though it had never been set there directly — so the
// SECOND patch's own guard saw "already patched" on its very first run and
// skipped installing. The concatenated-JSON/malformed-frame onMessage
// patch never applied as a result.
describe('patchOrderWsSafety', () => {
  it('actually installs the onMessage patch — a concatenated-JSON frame is split into two order events', () => {
    patchOrderWsSafety();

    const upsert = jest.fn();
    const emit = jest.fn();
    const ctx: any = { orderStore: { upsert }, emit };

    const frame =
      '{"Type":"order_alert","Data":{"OrderNo":"1","CorrelationId":"c1","Status":"TRADED","SecurityId":"111"}}' +
      '{"Type":"order_alert","Data":{"OrderNo":"2","CorrelationId":"c2","Status":"TRADED","SecurityId":"222"}}';

    (OrderUpdateWS.prototype as any).onMessage.call(ctx, frame);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, 'order', expect.objectContaining({ orderId: '1', securityId: '111' }));
    expect(emit).toHaveBeenNthCalledWith(2, 'order', expect.objectContaining({ orderId: '2', securityId: '222' }));
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — calling it again does not re-wrap an already-patched onMessage', () => {
    patchOrderWsSafety();
    const patchedOnce = (OrderUpdateWS.prototype as any).onMessage;
    patchOrderWsSafety();
    const patchedTwice = (OrderUpdateWS.prototype as any).onMessage;
    expect(patchedTwice).toBe(patchedOnce);
  });

  it('does not throw on a malformed/heartbeat frame', () => {
    patchOrderWsSafety();
    const ctx: any = { orderStore: { upsert: jest.fn() }, emit: jest.fn() };
    expect(() => (OrderUpdateWS.prototype as any).onMessage.call(ctx, 'PING')).not.toThrow();
    expect(() => (OrderUpdateWS.prototype as any).onMessage.call(ctx, Buffer.from('not json'))).not.toThrow();
  });

  it('defers send while readyState is CONNECTING instead of throwing', () => {
    patchOrderWsSafety();
    const baseProto = Object.getPrototypeOf(OrderUpdateWS.prototype);
    const sent: string[] = [];
    const conn: any = {
      readyState: 0,
      send: (p: string) => { sent.push(p); },
    };
    const ctx: any = { connection: conn };
    expect(() => baseProto.send.call(ctx, '{"login":true}')).not.toThrow();
    expect(sent).toHaveLength(0);
    conn.readyState = 1;
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(sent).toEqual(['{"login":true}']);
        resolve();
      });
    });
  });

  it('patches startHeartbeat to send ws ping frames and avoid false close', () => {
    patchOrderWsSafety();
    const baseProto = Object.getPrototypeOf(OrderUpdateWS.prototype);
    let pingCalls = 0;
    const conn: any = {
      readyState: 1,
      ping: () => { pingCalls++; },
      close: jest.fn(),
    };
    const ctx: any = { connection: conn, pingIntervalMs: 50 };
    baseProto.startHeartbeat.call(ctx);
    expect(ctx.pongTimeout).toBeUndefined();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        clearInterval(ctx.pingInterval);
        expect(pingCalls).toBeGreaterThan(0);
        expect(conn.close).not.toHaveBeenCalled();
        resolve();
      }, 120);
    });
  });
});
