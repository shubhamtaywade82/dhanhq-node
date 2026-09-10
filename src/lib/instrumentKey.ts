/** Canonical instrument identity for order/position actions — DhanHQ's
 * stable pair; tradingSymbol is display-only and can differ across modes. */
export interface InstrumentKey {
  securityId: string;
  exchangeSegment: string;
}

export function toInstrumentKey(pos: {
  securityId?: string;
  exchangeSegment?: string;
  security_id?: string;
  exchange_segment?: string;
}): InstrumentKey {
  return {
    securityId: String(pos.securityId ?? pos.security_id ?? ''),
    exchangeSegment: String(pos.exchangeSegment ?? pos.exchange_segment ?? 'NSE_FNO'),
  };
}

export function keysMatch(a: InstrumentKey, b: InstrumentKey): boolean {
  return String(a.securityId) === String(b.securityId) && a.exchangeSegment === b.exchangeSegment;
}
