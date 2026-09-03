import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import { initDatabase } from '../db';
import type { NormalizedPosition, PortfolioSource } from '../services/portfolioSource';

// Regression coverage for a real pre-existing bug: armKillSwitch/
// disarmKillSwitch used to call traderControls.killSwitch()/.pnlExit() —
// neither exists on TraderControls (the real methods are
// setKillSwitch(status) and setPnlExit(request)). Because both calls used
// optional chaining, the wrong name resolved to undefined and silently
// no-opped instead of throwing: the broker's own kill switch never actually
// engaged in live mode, while armKillSwitch went on to record
// brokerKillSwitch as engaged anyway.

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

function stubPortfolio(overrides: Partial<PortfolioSource> = {}): PortfolioSource {
  return {
    kind: 'broker',
    getPositions: jest.fn(async () => [] as NormalizedPosition[]),
    getWallet: jest.fn(async () => ({
      availableMargin: 0, usedMargin: 0, realizedPnl: 0, sessionRealizedPnl: 0,
      unrealizedPnl: 0, totalCharges: 0, netRealizedPnl: 0, totalBalance: 0, equity: 0,
    })),
    getTodayOrderStats: jest.fn(async () => ({ total: 0, filled: 0, rejected: 0, consecutiveLosses: 0 })),
    recordOrderOutcome: jest.fn(),
    markToMarket: jest.fn(async () => ({ totalUnrealized: 0, staleCount: 0 })),
    closePosition: jest.fn(async () => ({ status: 'noop' as const })),
    closeAll: jest.fn(async () => []),
    ...overrides,
  };
}

describe("RiskEngine kill switch — DhanHQ Trader's Control calls", () => {
  const originalMode = process.env.TRADING_MODE;
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env.TRADING_MODE = originalMode;
  });

  it("calls the real SDK method setKillSwitch('ACTIVATE') when arming in live mode", async () => {
    process.env.TRADING_MODE = 'live';
    const client = stubClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market, stubPortfolio());
    const setKillSwitch = jest.spyOn(client.traderControls, 'setKillSwitch').mockResolvedValue({} as any);

    const result = await risk.armKillSwitch('test kill');

    expect(setKillSwitch).toHaveBeenCalledWith('ACTIVATE');
    expect(result.details.brokerKillSwitch).toBe('ACTIVATE');
    expect(result.details.brokerKillSwitchError).toBeUndefined();
  });

  it("calls setKillSwitch('DEACTIVATE') when disarming in live mode", async () => {
    process.env.TRADING_MODE = 'live';
    const client = stubClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market, stubPortfolio());
    const setKillSwitch = jest.spyOn(client.traderControls, 'setKillSwitch').mockResolvedValue({} as any);
    await risk.armKillSwitch('test kill');
    setKillSwitch.mockClear();

    await risk.disarmKillSwitch();

    expect(setKillSwitch).toHaveBeenCalledWith('DEACTIVATE');
  });

  it('never calls the nonexistent pnlExit/killSwitch methods', async () => {
    process.env.TRADING_MODE = 'live';
    const client = stubClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market, stubPortfolio());
    jest.spyOn(client.traderControls, 'setKillSwitch').mockResolvedValue({} as any);
    expect((client.traderControls as any).killSwitch).toBeUndefined();
    expect((client.traderControls as any).pnlExit).toBeUndefined();

    await risk.armKillSwitch('test kill');
    // No throw means the optional-chained calls to the (nonexistent) old
    // method names never actually got a chance to matter either way — the
    // real assertion is the setKillSwitch spy above actually firing.
  });

  it('still squares off every position locally even when the broker kill-switch call itself fails', async () => {
    process.env.TRADING_MODE = 'live';
    const client = stubClient();
    const market = new MarketDataService(client);
    const closeAll = jest.fn(async () => [{ status: 'TRADED' as const, symbol: 'X', orderId: 'o1' }]);
    const risk = new RiskEngine(client, market, stubPortfolio({ closeAll }));
    jest.spyOn(client.traderControls, 'setKillSwitch').mockRejectedValue(new Error('rate limited'));

    const result = await risk.armKillSwitch('broker call fails');

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(result.details.positionsClosed).toBe(1);
    expect(result.details.brokerKillSwitchError).toContain('rate limited');
  });

  it('does not call traderControls at all in paper mode', async () => {
    process.env.TRADING_MODE = 'paper';
    const client = stubClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market, stubPortfolio());
    const setKillSwitch = jest.spyOn(client.traderControls, 'setKillSwitch').mockResolvedValue({} as any);

    await risk.armKillSwitch('paper mode kill');

    expect(setKillSwitch).not.toHaveBeenCalled();
  });
});
