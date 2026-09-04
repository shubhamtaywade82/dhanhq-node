import { warmLotSizeCache, getLotSize } from '../services/strategyConstructor';
import { eventBus } from '../services/eventBus';

// warmLotSizeCache used to call client.instruments.find(segment, symbol) —
// an exact match on the bare underlying name, which matches the synthetic
// INDEX reference row (lotSize: 1) rather than any real options contract,
// for every symbol, always. Confirmed live against the real DhanHQ scrip
// master before fixing. These tests exercise the fixed bySegment()+filter
// approach against a fake instrument list, not the real API.
function fakeInstruments(rows: Array<{ underlyingSymbol: string; instrument: string; lotSize: number }>) {
  return { bySegment: jest.fn(async () => rows) };
}

describe('warmLotSizeCache / getLotSize', () => {
  afterEach(() => jest.restoreAllMocks());

  it('picks a real (non-INDEX) contract\'s lot size, ignoring the synthetic INDEX reference row', async () => {
    const symbol = `LOTTEST_${Date.now()}`;
    const client = {
      instruments: fakeInstruments([
        { underlyingSymbol: symbol, instrument: 'INDEX', lotSize: 1 },
        { underlyingSymbol: symbol, instrument: 'OPTIDX', lotSize: 75 },
      ]),
    };
    await warmLotSizeCache(client, symbol);
    expect(getLotSize(symbol)).toBe(75);
  });

  it('queries BSE_FNO for SENSEX, NSE_FNO for everything else', async () => {
    const bySegmentSensex = jest.fn(async () => [{ underlyingSymbol: 'SENSEX', instrument: 'OPTIDX', lotSize: 20 }]);
    await warmLotSizeCache({ instruments: { bySegment: bySegmentSensex } }, 'SENSEX');
    expect(bySegmentSensex).toHaveBeenCalledWith('BSE_FNO');

    const bySegmentNifty = jest.fn(async () => [{ underlyingSymbol: `NSETEST_${Date.now()}`, instrument: 'OPTIDX', lotSize: 65 }]);
    await warmLotSizeCache({ instruments: { bySegment: bySegmentNifty } }, `NSETEST_${Date.now()}`);
    expect(bySegmentNifty).toHaveBeenCalledWith('NSE_FNO');
  });

  it('logs ERROR (not silently) when the real lot size disagrees with the hardcoded fallback', async () => {
    const logSpy = jest.spyOn(eventBus, 'log');
    const client = { instruments: fakeInstruments([{ underlyingSymbol: 'NIFTY', instrument: 'OPTIDX', lotSize: 75 }]) };
    await warmLotSizeCache(client, 'NIFTY');
    expect(logSpy).toHaveBeenCalledWith('ERROR', expect.stringContaining('Lot size mismatch'), 'strategy_constructor');
    expect(getLotSize('NIFTY')).toBe(75); // still trusts the verified real value over the stale hardcoded one
  });

  it('logs WARN (not silently) and keeps the hardcoded fallback when no real contract is found', async () => {
    const logSpy = jest.spyOn(eventBus, 'log');
    const symbol = `NOCONTRACT_${Date.now()}`;
    const client = { instruments: fakeInstruments([{ underlyingSymbol: symbol, instrument: 'INDEX', lotSize: 1 }]) };
    await warmLotSizeCache(client, symbol);
    expect(logSpy).toHaveBeenCalledWith('WARN', expect.stringContaining('Lot-size verification failed'), 'strategy_constructor');
    expect(getLotSize(symbol)).toBe(65); // the ultimate ( || 65 ) fallback for an unlisted symbol
  });
});
