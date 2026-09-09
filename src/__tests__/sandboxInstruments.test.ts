import { resolveSandboxOptionLeg, roundToTick } from '../services/sandboxInstruments';

function mockClient(rows: any[]) {
  return {
    instruments: {
      bySegment: jest.fn().mockResolvedValue(rows),
    },
  } as any;
}

describe('sandboxInstruments', () => {
  it('maps production strike to sandbox securityId by underlying/strike/type', async () => {
    const leg = await resolveSandboxOptionLeg(mockClient([
      { underlyingSymbol: 'NIFTY', instrument: 'OPTIDX', strikePrice: 23600, optionType: 'CE', securityId: '46026', lotSize: 65, tickSize: 5, displayName: 'NIFTY 13 JAN 23600 CALL' },
      { underlyingSymbol: 'NIFTY', instrument: 'OPTIDX', strikePrice: 23600, optionType: 'CE', securityId: '40293', lotSize: 65, tickSize: 5, displayName: 'NIFTY 06 JAN 23600 CALL' },
    ]), { underlying: 'NIFTY', strike: 23600, optionType: 'CE', expiry: '2026-01-13' });
    expect(leg?.securityId).toBe('46026');
    expect(leg?.quantity).toBe(65);
  });

  it('rounds limit price to the contract tick size', () => {
    expect(roundToTick(123.2, 5)).toBe(125);
    expect(roundToTick(122.4, 5)).toBe(120);
  });
});
