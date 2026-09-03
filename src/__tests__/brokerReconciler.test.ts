import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { AutonomyEngine } from '../services/autonomy';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import { initDatabase } from '../db';
import * as db from '../db';
import type { NormalizedPosition, PortfolioSource } from '../services/portfolioSource';

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

function normalizedPosition(overrides: Partial<NormalizedPosition> = {}): NormalizedPosition {
  return {
    tradingSymbol: 'NIFTY25JAN24000CE', securityId: '77001', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
    buyQty: 50, buyAvg: 100, sellQty: 0, sellAvg: 0, netQty: 50,
    realizedProfit: 0, unrealizedProfit: 0, pnl: 0, costPrice: 100, ltp: 100, marginBlocked: 0,
    stopLoss: null, target: null, trailingStop: null, strike: 24000, optionType: 'CALL',
    ...overrides,
  };
}

function stubPortfolio(positions: NormalizedPosition[], opts: { kind?: 'paper' | 'broker'; closePosition?: jest.Mock } = {}): PortfolioSource {
  return {
    kind: opts.kind ?? 'broker',
    getPositions: jest.fn(async () => positions),
    getWallet: jest.fn(async () => ({
      availableMargin: 0, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0,
      unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: 0, equity: 0,
    })),
    getTodayOrderStats: jest.fn(async () => ({ total: 0, filled: 0, rejected: 0, consecutiveLosses: 0 })),
    recordOrderOutcome: jest.fn(),
    markToMarket: jest.fn(async () => ({ totalUnrealized: 0, staleCount: 0 })),
    closePosition: opts.closePosition ?? jest.fn(async () => ({ status: 'TRADED' as const, symbol: 'X', orderId: 'o1' })),
    closeAll: jest.fn(async () => []),
    invalidate: jest.fn(),
  };
}

describe('AutonomyEngine — unmanaged live position reconciler', () => {
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => jest.restoreAllMocks());

  function setup(portfolio: PortfolioSource) {
    const client = stubClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    const autonomy = new AutonomyEngine(client, market, risk, portfolio);
    return { market, risk, autonomy };
  }

  it('flattens and arms the kill switch for a broker position PositionMonitor is not tracking', async () => {
    const closePosition = jest.fn(async () => ({ status: 'TRADED' as const, symbol: 'NIFTY25JAN24000CE', orderId: 'ord1' }));
    const portfolio = stubPortfolio([normalizedPosition()], { closePosition });
    const { market, risk, autonomy } = setup(portfolio);
    jest.spyOn(risk, 'isKilled').mockReturnValue(false);
    const armSpy = jest.spyOn(risk, 'armKillSwitch').mockResolvedValue({ status: 'killed', details: {} });
    const alertSpy = jest.spyOn(db, 'pushAlert');

    expect(market.monitor.tracked().find((t) => t.securityId === '77001')).toBeUndefined();
    await (autonomy as any).reconcileUnmanagedLivePositions();

    expect(closePosition).toHaveBeenCalledWith('NIFTY25JAN24000CE');
    expect(armSpy).toHaveBeenCalledTimes(1);
    expect(armSpy.mock.calls[0][0]).toContain('NIFTY25JAN24000CE');
    expect(alertSpy).toHaveBeenCalledWith('ERROR', 'autonomy', expect.stringContaining('UNMANAGED LIVE POSITION'));
  });

  it('does nothing when PositionMonitor is already tracking the position', async () => {
    const closePosition = jest.fn();
    const portfolio = stubPortfolio([normalizedPosition()], { closePosition });
    const { market, risk, autonomy } = setup(portfolio);
    market.monitor.track({ securityId: '77001', exchangeSegment: 'NSE_FNO', quantity: 50, entryPrice: 100, stopLoss: 80 });
    const armSpy = jest.spyOn(risk, 'armKillSwitch');
    const alertSpy = jest.spyOn(db, 'pushAlert');

    await (autonomy as any).reconcileUnmanagedLivePositions();

    expect(closePosition).not.toHaveBeenCalled();
    expect(armSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('is a no-op in paper mode — this reconciler is broker-only by construction', async () => {
    const closePosition = jest.fn();
    const portfolio = stubPortfolio([normalizedPosition()], { kind: 'paper', closePosition });
    const { autonomy } = setup(portfolio);

    await (autonomy as any).reconcileUnmanagedLivePositions();

    expect(portfolio.getPositions).not.toHaveBeenCalled();
    expect(closePosition).not.toHaveBeenCalled();
  });

  it('flattens the position but does not re-arm an already-engaged kill switch', async () => {
    const closePosition = jest.fn(async () => ({ status: 'TRADED' as const, symbol: 'NIFTY25JAN24000CE', orderId: 'ord2' }));
    const portfolio = stubPortfolio([normalizedPosition()], { closePosition });
    const { risk, autonomy } = setup(portfolio);
    jest.spyOn(risk, 'isKilled').mockReturnValue(true);
    const armSpy = jest.spyOn(risk, 'armKillSwitch');

    await (autonomy as any).reconcileUnmanagedLivePositions();

    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(armSpy).not.toHaveBeenCalled();
  });

  it('skips flat positions and positions with a placeholder security id', async () => {
    const closePosition = jest.fn();
    const portfolio = stubPortfolio([
      normalizedPosition({ netQty: 0, securityId: '77002' }),
      normalizedPosition({ netQty: 50, securityId: '0' }),
    ], { closePosition });
    const { risk, autonomy } = setup(portfolio);
    const armSpy = jest.spyOn(risk, 'armKillSwitch');

    await (autonomy as any).reconcileUnmanagedLivePositions();

    expect(closePosition).not.toHaveBeenCalled();
    expect(armSpy).not.toHaveBeenCalled();
  });

  it('logs REJECTED without throwing when the square-off order itself fails', async () => {
    const closePosition = jest.fn(async () => ({ status: 'REJECTED' as const, symbol: 'NIFTY25JAN24000CE', reason: 'margin insufficient' }));
    const portfolio = stubPortfolio([normalizedPosition()], { closePosition });
    const { risk, autonomy } = setup(portfolio);
    jest.spyOn(risk, 'isKilled').mockReturnValue(false);
    const armSpy = jest.spyOn(risk, 'armKillSwitch').mockResolvedValue({ status: 'killed', details: {} });

    await expect((autonomy as any).reconcileUnmanagedLivePositions()).resolves.toBeUndefined();
    expect(closePosition).toHaveBeenCalledTimes(1);
    // Still halts trading even though the flatten attempt itself failed —
    // an unmanaged position that COULDN'T be closed is strictly worse, not
    // a reason to leave the kill switch disarmed.
    expect(armSpy).toHaveBeenCalledTimes(1);
  });
});
