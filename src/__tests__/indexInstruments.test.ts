import { INDEX_INSTRUMENTS } from '../services/marketData';

// Regression test: INDIAVIX's securityId was hardcoded as '26' — silently
// wrong. Verified against DhanHQ's own live instrument master
// (https://images.dhan.co/api-data/api-scrip-master.csv, NSE IDX_I rows):
// '26' isn't even an index (it's an unrelated NSE bond, SDL HR 6.7% 2030),
// so subscribing/quoting under IDX_I with it returns no data at all rather
// than a wrong number — India VIX would just never populate. The real
// SEM_SMST_SECURITY_ID for INDIA VIX is '21'. The other four indices were
// checked against the same source and are correct.
describe('INDEX_INSTRUMENTS — security IDs verified against DhanHQ\'s instrument master', () => {
  it('has the correct security ID for every index', () => {
    expect(INDEX_INSTRUMENTS.NIFTY.securityId).toBe('13');
    expect(INDEX_INSTRUMENTS.BANKNIFTY.securityId).toBe('25');
    expect(INDEX_INSTRUMENTS.FINNIFTY.securityId).toBe('27');
    expect(INDEX_INSTRUMENTS.MIDCPNIFTY.securityId).toBe('442');
    expect(INDEX_INSTRUMENTS.SENSEX.securityId).toBe('51');
    expect(INDEX_INSTRUMENTS.INDIAVIX.securityId).toBe('21');
  });

  it('never uses the old wrong VIX id — 26 is not even an index in DhanHQ\'s master', () => {
    expect(INDEX_INSTRUMENTS.INDIAVIX.securityId).not.toBe('26');
  });
});
