import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { crossCheckJournalOnBoot } from '../core';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import { eventBus } from '../services/eventBus';
import { initDatabase, executePaperOrder } from '../db';
import * as db from '../db';
import type { JournalEntry } from '../services/journal';

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

function entry(seq: number, kind: JournalEntry['kind'], payload: any): JournalEntry {
  return { seq, ts: Date.now() + seq, kind, payload };
}

describe('crossCheckJournalOnBoot', () => {
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const client = stubClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    return { risk };
  }

  it('does nothing on a fresh day with no prior entries — nothing to check yet', async () => {
    const { risk } = setup();
    const logSpy = jest.spyOn(eventBus, 'log');
    const alertSpy = jest.spyOn(db, 'pushAlert');
    await crossCheckJournalOnBoot([], risk, stubClient());
    expect(logSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('reports nothing when every journaled trade has a matching durable order and kill state agrees', async () => {
    const { risk } = setup();
    await executePaperOrder({
      symbol: 'BOOT_OK', securityId: '99001', quantity: 50,
      transactionType: 'BUY', price: 100, correlationId: 'boot_ok_corr',
    });
    jest.spyOn(risk, 'isKilled').mockReturnValue(false);

    const alertSpy = jest.spyOn(db, 'pushAlert');
    const entries: JournalEntry[] = [
      entry(1, 'order_intent', { correlation_id: 'boot_ok_corr' }),
      entry(2, 'order_result', { correlation_id: 'boot_ok_corr', status: 'TRADED' }),
    ];
    await crossCheckJournalOnBoot(entries, risk, stubClient());

    expect(alertSpy).not.toHaveBeenCalledWith('ERROR', expect.anything(), expect.anything());
    expect(alertSpy).not.toHaveBeenCalledWith('WARN', expect.anything(), expect.anything());
  });

  it('alerts ERROR when the journal recorded a trade with no matching durable order', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(false);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [
      entry(1, 'order_result', { correlation_id: 'ghost_trade_corr', status: 'TRADED' }),
    ];
    await crossCheckJournalOnBoot(entries, risk, stubClient());

    expect(alertSpy).toHaveBeenCalledWith('ERROR', 'core', expect.stringContaining('ghost_trade_corr'));
  });

  it('does not alert on live or sandbox trades when booted in paper mode', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(false);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [
      entry(1, 'order_intent', { correlation_id: 'live_intent', mode: 'live' }),
      entry(2, 'order_result', { correlation_id: 'live_intent', status: 'TRADED', is_paper: false, mode: 'live' }),
      entry(3, 'order_result', { correlation_id: 'sbx_trade', status: 'TRADED', is_paper: false, mode: 'sandbox' }),
    ];
    await crossCheckJournalOnBoot(entries, risk, stubClient());

    expect(alertSpy).not.toHaveBeenCalledWith('ERROR', expect.anything(), expect.anything());
  });

  describe('sandbox/live mode — resolving orders via the broker instead of paper_orders', () => {
    // SandboxExecutionEngine/LiveExecutionEngine journal status:'TRADED'
    // results but never insert into paper_orders (only executePaperOrder
    // does) — a TRADED result is itself durable (the journal is an fsync'd
    // file), so it's only an order the process died WITHOUT recording an
    // outcome for (no order_result at all) that needs resolving, via the
    // broker's own order book.
    function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
      const prior = process.env.TRADING_MODE;
      process.env.TRADING_MODE = mode;
      return fn().finally(() => {
        if (prior === undefined) delete process.env.TRADING_MODE;
        else process.env.TRADING_MODE = prior;
      });
    }

    it('does not alert on a TRADED result with no matching intent — the journal entry is itself the durable record', () => withMode('sandbox', async () => {
      const { risk } = setup();
      jest.spyOn(risk, 'isKilled').mockReturnValue(false);
      const alertSpy = jest.spyOn(db, 'pushAlert');

      const entries: JournalEntry[] = [
        entry(1, 'order_result', { correlation_id: 'sandbox_trade_corr', status: 'TRADED' }),
      ];
      await crossCheckJournalOnBoot(entries, risk, stubClient());

      expect(alertSpy).not.toHaveBeenCalledWith('ERROR', expect.anything(), expect.anything());
    }));

    it('resolves an unresolved intent via the sandbox client and does not alert when the broker has a record', () => withMode('sandbox', async () => {
      const { risk } = setup();
      jest.spyOn(risk, 'isKilled').mockReturnValue(false);
      const alertSpy = jest.spyOn(db, 'pushAlert');
      const sandboxClient = stubClient();
      jest.spyOn(sandboxClient.orders, 'getByCorrelationId').mockResolvedValue({ orderId: 'sbx1', orderStatus: 'TRADED' } as any);

      const entries: JournalEntry[] = [
        entry(1, 'order_intent', { correlation_id: 'died_mid_place' }),
      ];
      await crossCheckJournalOnBoot(entries, risk, stubClient(), sandboxClient);

      expect(sandboxClient.orders.getByCorrelationId).toHaveBeenCalledWith('died_mid_place');
      expect(alertSpy).not.toHaveBeenCalledWith('ERROR', expect.anything(), expect.anything());
    }));

    it('alerts ERROR when the broker has no record of an unresolved intent', () => withMode('sandbox', async () => {
      const { risk } = setup();
      jest.spyOn(risk, 'isKilled').mockReturnValue(false);
      const alertSpy = jest.spyOn(db, 'pushAlert');
      const sandboxClient = stubClient();
      jest.spyOn(sandboxClient.orders, 'getByCorrelationId').mockResolvedValue({} as any);

      const entries: JournalEntry[] = [
        entry(1, 'order_intent', { correlation_id: 'truly_lost' }),
      ];
      await crossCheckJournalOnBoot(entries, risk, stubClient(), sandboxClient);

      expect(alertSpy).toHaveBeenCalledWith('ERROR', 'core', expect.stringContaining('truly_lost'));
    }));

    it('alerts ERROR when there is an unresolved intent but no sandbox client to reconcile against', () => withMode('sandbox', async () => {
      const { risk } = setup();
      jest.spyOn(risk, 'isKilled').mockReturnValue(false);
      const alertSpy = jest.spyOn(db, 'pushAlert');

      const entries: JournalEntry[] = [
        entry(1, 'order_intent', { correlation_id: 'no_client' }),
      ];
      await crossCheckJournalOnBoot(entries, risk, stubClient(), undefined);

      expect(alertSpy).toHaveBeenCalledWith('ERROR', 'core', expect.stringContaining('no_client'));
    }));
  });

  it('alerts WARN when the journal\'s last kill action was ARM but the risk engine reports not killed', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(false);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [entry(1, 'kill', { action: 'arm', reason: 'daily loss' })];
    await crossCheckJournalOnBoot(entries, risk, stubClient());

    expect(alertSpy).toHaveBeenCalledWith('WARN', 'core', expect.stringContaining('ARM'));
  });

  it('alerts WARN when the journal\'s last kill action was DISARM but the risk engine reports killed', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(true);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [entry(1, 'kill', { action: 'disarm' })];
    await crossCheckJournalOnBoot(entries, risk, stubClient());

    expect(alertSpy).toHaveBeenCalledWith('WARN', 'core', expect.stringContaining('DISARM'));
  });

  it('does not alert on kill state when the journal and risk engine already agree', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(true);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [entry(1, 'kill', { action: 'arm', reason: 'manual' })];
    await crossCheckJournalOnBoot(entries, risk, stubClient());

    expect(alertSpy).not.toHaveBeenCalled();
  });
});
