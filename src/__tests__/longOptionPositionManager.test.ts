import { MarketDataService } from '../services/marketData';
import { LongOptionPositionManager } from '../services/longOptionPositionManager';
import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import {
  initDatabase, executePaperOrder, listPaperPositions, resetPaperWallet, getPaperWallet,
} from '../db';

const SEC_ID = '44000';

function stubMarket(ltp: number): MarketDataService {
  const svc = new MarketDataService(new DhanClient({ clientId: 'test', token: 'test' }));
  setLtp(svc, ltp);
  return svc;
}

function setLtp(svc: MarketDataService, ltp: number): void {
  (svc as any).quotes.set(SEC_ID, {
    securityId: SEC_ID, ltp, change: 0, pctChange: 0, high: ltp, low: ltp, open: ltp, prevClose: ltp,
    volume: 0, oi: 0, updatedAt: Date.now(),
  });
}

async function openLongOption(entryPrice: number): Promise<void> {
  await executePaperOrder({
    symbol: 'NIFTY24950CE', securityId: SEC_ID, exchangeSegment: 'NSE_FNO',
    transactionType: 'BUY', orderType: 'MARKET', productType: 'INTRADAY', quantity: 75, price: entryPrice,
  });
}

describe('LongOptionPositionManager (wired against real db.ts paper positions)', () => {
  beforeAll(async () => { await initDatabase(); });
  beforeEach(async () => { await resetPaperWallet(); });

  it('books a partial exit once the position crosses the first ratchet level', async () => {
    await openLongOption(100);
    const market = stubMarket(150); // +50 on 100 entry, well past 0.25R/0.5R for a 28% stop
    const manager = new LongOptionPositionManager(market);

    await manager.evaluate(false);

    const [pos] = await listPaperPositions();
    expect(pos.netQty).toBeGreaterThan(0);
    expect(pos.netQty).toBeLessThan(75); // partial booked, not a full exit
    const wallet = await getPaperWallet();
    expect(wallet.realizedPnl).toBeGreaterThan(0);
  });

  it('force-flattens on the end-of-day flag regardless of trail state', async () => {
    await openLongOption(100);
    const market = stubMarket(105); // barely green — nowhere near a normal ratchet exit
    const manager = new LongOptionPositionManager(market);

    await manager.evaluate(true);

    const [pos] = await listPaperPositions();
    expect(pos.netQty).toBe(0);
  });

  it('preserves the locked floor across an add-to fill instead of resetting it', async () => {
    await openLongOption(100);
    const market = stubMarket(150);
    const manager = new LongOptionPositionManager(market);
    const symbol = 'NIFTY24950CE';

    await manager.evaluate(false); // fires the breakeven partial, locks a floor > hard stop
    setLtp(market, 220);
    await manager.evaluate(false); // bigger peak — floor ratchets up further

    const floorBefore = manager.getState(symbol)!.floorNet;
    expect(floorBefore).toBeGreaterThan(0);

    // Add-to fill changes netQty out from under the manager, same as a
    // second BUY on this symbol would in the live tick loop.
    await executePaperOrder({
      symbol, securityId: SEC_ID, exchangeSegment: 'NSE_FNO',
      transactionType: 'BUY', orderType: 'MARKET', productType: 'INTRADAY', quantity: 75, price: 210,
    });
    const [posAfterAdd] = await listPaperPositions();

    await manager.evaluate(false); // resync path — must not wipe peak/floor

    const state = manager.getState(symbol)!;
    expect(state.remainingQuantity).toBe(posAfterAdd.netQty);
    expect(state.floorNet).toBe(floorBefore);
  });

  it('does nothing while disabled', async () => {
    await openLongOption(100);
    const market = stubMarket(150);
    const manager = new LongOptionPositionManager(market);
    manager.setEnabled(false);

    await manager.evaluate(false);

    const [pos] = await listPaperPositions();
    expect(pos.netQty).toBe(75);
  });
});
