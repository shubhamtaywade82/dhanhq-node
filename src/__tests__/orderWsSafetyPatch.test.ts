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
});
