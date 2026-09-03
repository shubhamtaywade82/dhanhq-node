import { BrokerPortfolioSource } from '../services/portfolioSource';

// A lightweight object shaped like the three DhanClient namespaces
// BrokerPortfolioSource actually touches — same pattern as
// expiryResolver.test.ts's stubClient, rather than constructing a real
// DhanClient and spying on its HTTP layer.
function stubClient(opts: {
  positions?: any[];
  positionsImpl?: () => Promise<any[]>;
  funds?: any;
  place?: jest.Mock;
} = {}) {
  return {
    positions: { list: jest.fn(opts.positionsImpl ?? (async () => opts.positions ?? [])) },
    funds: { getLimit: jest.fn(async () => opts.funds ?? {}) },
    orders: { place: opts.place ?? jest.fn(async () => ({ correlationId: 'corr', data: { orderId: 'ord1' } })) },
  } as any;
}

function rawPosition(overrides: Record<string, any> = {}) {
  return {
    tradingSymbol: 'NIFTY25JAN24000CE',
    securityId: '123456',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    buyQty: 50, buyAvg: 100, sellQty: 0, sellAvg: 0, netQty: 50,
    realizedProfit: 0, unrealizedProfit: 250, costPrice: 100,
    drvStrikePrice: 24000, drvOptionType: 'CALL',
    ...overrides,
  };
}

describe('BrokerPortfolioSource', () => {
  it('maps DhanHQ PositionResponse fields into NormalizedPosition, including strike/optionType from drv fields', async () => {
    const client = stubClient({ positions: [rawPosition()] });
    const src = new BrokerPortfolioSource(client, 60_000);
    const [pos] = await src.getPositions();
    expect(pos.tradingSymbol).toBe('NIFTY25JAN24000CE');
    expect(pos.netQty).toBe(50);
    expect(pos.realizedProfit).toBe(0);
    expect(pos.unrealizedProfit).toBe(250);
    expect(pos.pnl).toBe(250);
    expect(pos.strike).toBe(24000);
    expect(pos.optionType).toBe('CALL');
    expect(pos.ltp).toBeCloseTo(105, 2); // buyAvg + unrealized/netQty = 100 + 250/50
  });

  it('maps FundLimitResponse fields into WalletSnapshot, deriving session P&L by summing positions', async () => {
    const client = stubClient({
      positions: [
        rawPosition({ realizedProfit: 500, unrealizedProfit: -100 }),
        rawPosition({ tradingSymbol: 'BANKNIFTY25JAN52000PE', securityId: '999', realizedProfit: 200, unrealizedProfit: 50 }),
      ],
      funds: { availabelBalance: 80000, utilizedAmount: 20000 },
    });
    const src = new BrokerPortfolioSource(client, 60_000);
    const wallet = await src.getWallet();
    expect(wallet.availableMargin).toBe(80000);
    expect(wallet.usedMargin).toBe(20000);
    expect(wallet.sessionRealizedPnl).toBe(700);
    expect(wallet.realizedPnl).toBe(700);
    expect(wallet.unrealizedPnl).toBe(-50);
    expect(wallet.totalBalance).toBe(100000);
    expect(wallet.equity).toBeCloseTo(99950, 2);
  });

  it('caches the poll — repeated calls inside the TTL window hit the broker API only once', async () => {
    const client = stubClient({ positions: [rawPosition()] });
    const src = new BrokerPortfolioSource(client, 60_000);
    await src.getPositions();
    await src.getWallet();
    await src.getPositions();
    expect(client.positions.list).toHaveBeenCalledTimes(1);
    expect(client.funds.getLimit).toHaveBeenCalledTimes(1);
  });

  it('markToMarket respects the poll TTL instead of forcing a fresh poll on every call', async () => {
    // Regression test for the force-poll bug: markToMarket used to call
    // ensureFresh(true) unconditionally, which would hit the broker API on
    // every single tick once wired into AutonomyEngine.scheduleTickMark().
    const client = stubClient({ positions: [rawPosition()] });
    const src = new BrokerPortfolioSource(client, 60_000);
    await src.markToMarket(() => null);
    await src.markToMarket(() => null);
    await src.markToMarket(() => null);
    expect(client.positions.list).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers during an in-flight poll share the same request rather than each starting their own', async () => {
    let resolveList!: (v: any[]) => void;
    const listPromise = new Promise<any[]>((resolve) => { resolveList = resolve; });
    const client = stubClient({ positionsImpl: () => listPromise });
    const src = new BrokerPortfolioSource(client, 60_000);
    const p1 = src.getPositions();
    const p2 = src.getPositions();
    resolveList([rawPosition()]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(client.positions.list).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('serves the last-known snapshot and marks degraded when a poll fails', async () => {
    const client = stubClient({ positions: [rawPosition()] });
    const src = new BrokerPortfolioSource(client, 10);
    await src.getPositions();
    expect(src.isDegraded()).toBe(false);

    client.positions.list.mockRejectedValueOnce(new Error('network blip'));
    await new Promise((r) => setTimeout(r, 15)); // clear the TTL so the next read re-polls

    const positions = await src.getPositions();
    expect(positions).toHaveLength(1); // last-known snapshot, not thrown or emptied
    expect(src.isDegraded()).toBe(true);
  });

  it('still respects the poll interval after a failed poll — a failure does not defeat the throttle', async () => {
    // Regression test: an earlier version only advanced the throttle clock
    // on a SUCCESSFUL poll, so once a poll failed the throttle window never
    // re-closed (Date.now() - lastPollAt stayed >= pollIntervalMs forever)
    // and every subsequent call re-attempted the broker call — the exact
    // hammering the class exists to prevent, worse under a real outage.
    const client = stubClient({ positions: [rawPosition()] });
    const src = new BrokerPortfolioSource(client, 60_000);
    client.positions.list.mockRejectedValueOnce(new Error('network blip'));
    await src.getPositions(); // fails, but the attempt still counts
    await src.getPositions();
    await src.getPositions();
    expect(client.positions.list).toHaveBeenCalledTimes(1);
  });

  it('lets a concurrent caller dedupe onto an in-flight poll even when that poll started this same instant', async () => {
    // Regression test: splitting "last attempt" from "last success" (for
    // the throttle-after-failure fix above) initially broke the OTHER
    // dedup case — poll() sets its attempt timestamp synchronously as its
    // first statement, so a second caller arriving in the same tick saw
    // "an attempt just started" and returned early serving the stale
    // pre-poll cache, instead of awaiting the same in-flight request.
    let resolveList!: (v: any[]) => void;
    const listPromise = new Promise<any[]>((resolve) => { resolveList = resolve; });
    const client = stubClient({ positionsImpl: () => listPromise });
    const src = new BrokerPortfolioSource(client, 60_000);
    const p1 = src.getPositions();
    const p2 = src.getPositions();
    resolveList([rawPosition()]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toHaveLength(1);
    expect(r2).toEqual(r1);
  });

  it('invalidate() forces the next read to poll even inside the TTL window', async () => {
    const client = stubClient({ positions: [rawPosition()] });
    const src = new BrokerPortfolioSource(client, 60_000);
    await src.getPositions();
    expect(client.positions.list).toHaveBeenCalledTimes(1);

    src.invalidate();
    await src.getPositions();
    expect(client.positions.list).toHaveBeenCalledTimes(2);
  });

  it('tallies order outcomes for the rejection-rate breaker', async () => {
    const client = stubClient();
    const src = new BrokerPortfolioSource(client, 60_000);
    src.recordOrderOutcome({ status: 'TRADED' });
    src.recordOrderOutcome({ status: 'REJECTED' });
    src.recordOrderOutcome({ status: 'TRADED' });
    const stats = await src.getTodayOrderStats();
    expect(stats.total).toBe(3);
    expect(stats.filled).toBe(2);
    expect(stats.rejected).toBe(1);
  });

  it('infers a consecutive-loss streak from a negative realizedProfit delta across polls, and resets it on a gain', async () => {
    const client = stubClient({ positions: [rawPosition({ realizedProfit: 0 })] });
    const src = new BrokerPortfolioSource(client, 10);
    await src.getPositions(); // baseline poll — nothing to diff against yet
    expect((await src.getTodayOrderStats()).consecutiveLosses).toBe(0);

    await new Promise((r) => setTimeout(r, 15));
    client.positions.list.mockResolvedValueOnce([rawPosition({ realizedProfit: -300 })]); // a losing close
    await src.getPositions();
    expect((await src.getTodayOrderStats()).consecutiveLosses).toBe(1);

    await new Promise((r) => setTimeout(r, 15));
    client.positions.list.mockResolvedValueOnce([rawPosition({ realizedProfit: -100 })]); // net gain since last poll
    await src.getPositions();
    expect((await src.getTodayOrderStats()).consecutiveLosses).toBe(0);
  });

  it('closePosition places a reversing SELL MARKET order for a long position and returns TRADED', async () => {
    const place = jest.fn(async () => ({ correlationId: 'c1', data: { orderId: 'ord42' } }));
    const client = stubClient({ positions: [rawPosition({ netQty: 50 })], place });
    const src = new BrokerPortfolioSource(client, 60_000);
    const result = await src.closePosition('NIFTY25JAN24000CE');
    expect(result.status).toBe('TRADED');
    expect(result.orderId).toBe('ord42');
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ transactionType: 'SELL', quantity: 50, orderType: 'MARKET' }));
  });

  it('closePosition forces a fresh poll rather than trusting a cache that may predate the position — no false noop', async () => {
    // Regression test: closePosition used to call ensureFresh() (cache-
    // respecting), same as a routine read. A position opened within the
    // last pollIntervalMs would be absent from the cache, findOpenPosition
    // would find nothing, and the caller got back {status:'noop'} while the
    // real broker position stayed open — a silently failed exit.
    const client = stubClient({ positions: [] }); // cache starts empty
    const src = new BrokerPortfolioSource(client, 60_000);
    await src.getPositions(); // populates the (empty) cache within the TTL

    // The position now exists at the broker (a fill this instance hasn't
    // polled yet) — closePosition must not trust the stale empty cache.
    client.positions.list.mockResolvedValueOnce([rawPosition({ netQty: 50 })]);
    const place = jest.fn(async () => ({ correlationId: 'c1', data: { orderId: 'ord99' } }));
    (client.orders.place as jest.Mock) = place;

    const result = await src.closePosition('NIFTY25JAN24000CE');
    expect(result.status).toBe('TRADED');
    expect(place).toHaveBeenCalled();
  });

  it('closePosition reverses a short position with a BUY order', async () => {
    const place = jest.fn(async () => ({ correlationId: 'c1', data: { orderId: 'ord43' } }));
    const client = stubClient({ positions: [rawPosition({ netQty: -50, buyQty: 0, sellQty: 50 })], place });
    const src = new BrokerPortfolioSource(client, 60_000);
    await src.closePosition('NIFTY25JAN24000CE');
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ transactionType: 'BUY', quantity: 50 }));
  });

  it('closePosition is a noop when no matching open position exists', async () => {
    const client = stubClient({ positions: [] });
    const src = new BrokerPortfolioSource(client, 60_000);
    const result = await src.closePosition('GHOST');
    expect(result.status).toBe('noop');
  });

  it('closeAll reverses every open position and skips flat ones', async () => {
    const place = jest.fn(async () => ({ correlationId: 'c', data: { orderId: 'x' } }));
    const client = stubClient({
      positions: [
        rawPosition({ tradingSymbol: 'A', securityId: '1', netQty: 50 }),
        rawPosition({ tradingSymbol: 'B', securityId: '2', netQty: 0 }),
        rawPosition({ tradingSymbol: 'C', securityId: '3', netQty: -25 }),
      ],
      place,
    });
    const src = new BrokerPortfolioSource(client, 60_000);
    const results = await src.closeAll(() => null);
    expect(results).toHaveLength(2);
    expect(place).toHaveBeenCalledTimes(2);
  });

  it('reports REJECTED without throwing when the reversing order fails', async () => {
    const place = jest.fn(async () => { throw new Error('margin insufficient'); });
    const client = stubClient({ positions: [rawPosition({ netQty: 50 })], place });
    const src = new BrokerPortfolioSource(client, 60_000);
    const result = await src.closePosition('NIFTY25JAN24000CE');
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toContain('margin insufficient');
  });
});
