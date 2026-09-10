import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';

const MONTH: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export type SandboxLegInput = {
  underlying: string;
  strike: number;
  optionType: 'CE' | 'PE';
  expiry?: string;
  exchangeSegment?: string;
};

export type SandboxLeg = {
  securityId: string;
  quantity: number;
  exchangeSegment: string;
  tickSize: number;
  displayName?: string;
};

function segmentFor(underlying: string, hint?: string): string {
  if (hint) return hint;
  return underlying.toUpperCase() === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';
}

function parseDisplayExpiry(displayName?: string): number | null {
  const m = displayName?.match(/\b(\d{1,2})\s+([A-Z]{3})\s+\d+/);
  if (!m) return null;
  const month = MONTH[m[2]!];
  if (month == null) return null;
  const year = new Date().getFullYear();
  return Date.UTC(year, month, Number(m[1]));
}

/** Sandbox security IDs differ from production — map by underlying/strike/type/expiry. */
export async function resolveSandboxOptionLeg(
  client: DhanClient,
  input: SandboxLegInput,
): Promise<SandboxLeg | null> {
  const underlying = input.underlying.toUpperCase();
  const seg = segmentFor(underlying, input.exchangeSegment);
  const optType = input.optionType === 'PE' ? 'PE' : 'CE';
  const instruments = await client.instruments.bySegment(seg as any);
  const matches = (instruments || []).filter((i: any) =>
    i?.underlyingSymbol === underlying &&
    i?.instrument === 'OPTIDX' &&
    Number(i?.strikePrice) === input.strike &&
    i?.optionType === optType,
  );
  if (!matches.length) return null;

  const target = input.expiry ? Date.parse(input.expiry) : null;
  const ranked = matches
    .map((row: any) => ({ row, exp: parseDisplayExpiry(row.displayName) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (target != null
      ? Math.abs(a.exp - target) - Math.abs(b.exp - target)
      : b.exp - a.exp));

  const best = ranked[0]!.row;
  const lot = Number(best.lotSize);
  if (!(lot > 0)) return null;
  return {
    securityId: String(best.securityId),
    quantity: lot,
    exchangeSegment: seg,
    tickSize: Number(best.tickSize) || 0.05,
    displayName: best.displayName,
  };
}

export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  return Math.round(price / tickSize) * tickSize;
}

/** POST /v2/orders body for sandbox — MARKET is rejected, route as LIMIT. */
export function buildSandboxPlaceRequest(input: {
  correlationId: string;
  securityId: string;
  exchangeSegment: string;
  transactionType: string;
  orderType: string;
  quantity: number;
  price: number;
  productType: string;
}) {
  const asLimit = input.orderType === 'MARKET';
  if (asLimit && !(input.price > 0)) {
    throw new Error('Sandbox needs price > 0 to place LIMIT (MARKET not supported)');
  }
  const orderType = asLimit ? 'LIMIT' : input.orderType;
  const price = orderType === 'MARKET' ? 0 : input.price;
  const correlationId = input.correlationId ? String(input.correlationId).slice(0, 25) : undefined;
  return {
    correlationId,
    securityId: String(input.securityId),
    exchangeSegment: input.exchangeSegment as any,
    transactionType: input.transactionType as any,
    productType: input.productType as any,
    orderType: orderType as any,
    validity: 'DAY' as const,
    quantity: input.quantity,
    disclosedQuantity: 0,
    price,
    triggerPrice: 0,
    afterMarketOrder: false,
  };
}
