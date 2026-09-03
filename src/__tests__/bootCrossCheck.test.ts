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
    await crossCheckJournalOnBoot([], risk);
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
    await crossCheckJournalOnBoot(entries, risk);

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
    await crossCheckJournalOnBoot(entries, risk);

    expect(alertSpy).toHaveBeenCalledWith('ERROR', 'core', expect.stringContaining('ghost_trade_corr'));
  });

  it('alerts WARN when the journal\'s last kill action was ARM but the risk engine reports not killed', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(false);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [entry(1, 'kill', { action: 'arm', reason: 'daily loss' })];
    await crossCheckJournalOnBoot(entries, risk);

    expect(alertSpy).toHaveBeenCalledWith('WARN', 'core', expect.stringContaining('ARM'));
  });

  it('alerts WARN when the journal\'s last kill action was DISARM but the risk engine reports killed', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(true);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [entry(1, 'kill', { action: 'disarm' })];
    await crossCheckJournalOnBoot(entries, risk);

    expect(alertSpy).toHaveBeenCalledWith('WARN', 'core', expect.stringContaining('DISARM'));
  });

  it('does not alert on kill state when the journal and risk engine already agree', async () => {
    const { risk } = setup();
    jest.spyOn(risk, 'isKilled').mockReturnValue(true);
    const alertSpy = jest.spyOn(db, 'pushAlert');

    const entries: JournalEntry[] = [entry(1, 'kill', { action: 'arm', reason: 'manual' })];
    await crossCheckJournalOnBoot(entries, risk);

    expect(alertSpy).not.toHaveBeenCalled();
  });
});
