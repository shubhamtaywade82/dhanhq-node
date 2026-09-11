import {
  brokerJournalMode, describeModeContract, executionBrokerClient, getTradingMode,
  isBrokerMode, isLiveMode, isPaperMode, isSandboxMode,
} from '../lib/tradingMode';

describe('tradingMode', () => {
  const prior = process.env.TRADING_MODE;

  afterEach(() => {
    if (prior === undefined) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = prior;
  });

  it('defaults to paper', () => {
    delete process.env.TRADING_MODE;
    expect(getTradingMode()).toBe('paper');
    expect(isPaperMode()).toBe(true);
    expect(isBrokerMode()).toBe(false);
  });

  it('recognizes sandbox and live', () => {
    process.env.TRADING_MODE = 'sandbox';
    expect(isSandboxMode()).toBe(true);
    expect(brokerJournalMode()).toBe('sandbox');
    expect(isBrokerMode()).toBe(true);

    process.env.TRADING_MODE = 'live';
    expect(isLiveMode()).toBe(true);
    expect(brokerJournalMode()).toBe('live');
  });

  it('routes broker API calls to sandbox client only in sandbox mode', () => {
    const main = { id: 'main' } as any;
    const sandbox = { id: 'sandbox' } as any;
    process.env.TRADING_MODE = 'paper';
    expect(executionBrokerClient(main, sandbox)).toBe(main);
    process.env.TRADING_MODE = 'sandbox';
    expect(executionBrokerClient(main, sandbox)).toBe(sandbox);
    process.env.TRADING_MODE = 'live';
    expect(executionBrokerClient(main, sandbox)).toBe(main);
  });

  it('documents the mode contract', () => {
    process.env.TRADING_MODE = 'paper';
    expect(describeModeContract()).toContain('paper execution');
    process.env.TRADING_MODE = 'sandbox';
    expect(describeModeContract()).toContain('sandbox execution');
    process.env.TRADING_MODE = 'live';
    expect(describeModeContract()).toContain('order-update WS');
  });
});
