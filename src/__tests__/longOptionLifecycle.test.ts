import { MarketDataService } from '../services/marketData';
import { LongOptionPositionManager } from '../services/longOptionPositionManager';
import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import {
  initDatabase, executePaperOrder, createPaperStrategy, listPaperStrategies, listPaperPositions,
  getPaperWallet, resetPaperWallet, calculateOrderCharges, markPositionsToMarket,
} from '../db';

// Full open->hold->exit lifecycle for a single long-option position, with
// every wallet/position number hand-computed and checked exactly against
// the real db.ts formulas — not loose bounds — so a regression in fees,
// margin, PnL, or equity math fails here instead of surfacing as a live
// ~₹134K drift (see the margin-fix commit earlier this session).

const SEC_ID = '55001';
const SYMBOL = 'LIFECYCLE24950CE';
const QTY = 75;
const ENTRY = 100;

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

async function openLongOption(): Promise<void> {
  await executePaperOrder({
    symbol: SYMBOL, securityId: SEC_ID, exchangeSegment: 'NSE_FNO',
    transactionType: 'BUY', orderType: 'MARKET', productType: 'INTRADAY', quantity: QTY, price: ENTRY,
  });
  // Mirrors what AdaptiveSupertrendScanner.deploy() registers — a single-leg
  // RUNNING strategy whose only exit is LongOptionPositionManager, so
  // closeParentStrategyIfFlat() gets exercised end-to-end, not just the raw position.
  await createPaperStrategy({
    id: 'lifecycle_strat', name: 'Adaptive Supertrend', symbol: 'NIFTY', type: 'ADAPTIVE_SUPERTREND',
    lots: 1, legs: [{ instrument: SYMBOL, side: 'BUY' }],
  });
}

describe('Long-option paper lifecycle (open -> partial -> hold -> full exit)', () => {
  beforeAll(async () => { await initDatabase(); });
  beforeEach(async () => { await resetPaperWallet(); });

  it('produces exact entry/partial/hold/EOD-exit numbers across positions and wallet', async () => {
    // 0. Fresh-reset baseline
    const preTrade = await getPaperWallet();
    expect(preTrade.availableMargin).toBe(100000);
    expect(preTrade.usedMargin).toBe(0);
    expect(preTrade.realizedPnl).toBe(0);
    expect(preTrade.totalBalance).toBe(100000);
    expect(preTrade.equity).toBe(100000);

    // 1. Entry
    await openLongOption();
    const entryCharges = calculateOrderCharges('BUY', ENTRY, QTY);
    const [posAfterEntry] = await listPaperPositions();
    expect(posAfterEntry.buyAvg).toBe(ENTRY);
    expect(posAfterEntry.netQty).toBe(QTY);
    expect(posAfterEntry.stopLoss).toBeNull(); // no fixed SL/TP for this strategy — exits owned by LongOptionExitPolicy
    expect(posAfterEntry.target).toBeNull();
    expect(posAfterEntry.marginBlocked).toBe(QTY * ENTRY); // long option: full premium blocked

    const afterEntry = await getPaperWallet();
    expect(afterEntry.usedMargin).toBe(QTY * ENTRY);
    expect(afterEntry.totalCharges).toBe(entryCharges);
    expect(afterEntry.availableMargin).toBe(100000 - QTY * ENTRY - entryCharges);
    expect(afterEntry.totalBalance).toBe(100000 - entryCharges);
    expect(afterEntry.unrealizedPnl).toBe(0); // not marked-to-market yet

    // 2. Mark-to-market tick, independent of the exit manager
    await markPositionsToMarket(() => 150);
    const [posMarked] = await listPaperPositions();
    const unrealizedAt150 = (150 - ENTRY) * QTY;
    expect(posMarked.unrealizedProfit).toBe(unrealizedAt150);
    const marked = await getPaperWallet();
    expect(marked.unrealizedPnl).toBe(unrealizedAt150);
    expect(marked.equity).toBe(100000 - entryCharges + unrealizedAt150);
    expect(marked.totalBalance).toBe(100000 - entryCharges); // margin/realized untouched by mark-to-market

    // 3. First-partial exit fires at LTP 150 (40% of qty, no slippage on partials)
    const market = stubMarket(150);
    const manager = new LongOptionPositionManager(market);
    await manager.evaluate(false);

    const partialQty = Math.floor(0.4 * QTY); // 30
    const partialCharges = calculateOrderCharges('SELL', 150, partialQty);
    const grossPartial = (150 - ENTRY) * partialQty; // 1500

    const [posAfterPartial] = await listPaperPositions();
    expect(posAfterPartial.netQty).toBe(QTY - partialQty); // 45
    expect(posAfterPartial.marginBlocked).toBe((QTY - partialQty) * ENTRY); // 4500

    const afterPartial = await getPaperWallet();
    expect(afterPartial.realizedPnl).toBe(grossPartial);
    expect(afterPartial.usedMargin).toBe((QTY - partialQty) * ENTRY);
    expect(afterPartial.totalCharges).toBe(entryCharges + partialCharges);

    // 4. Push LTP up — ratchet floor rises, no exit yet
    setLtp(market, 220);
    await manager.evaluate(false);
    const [posAfterHold] = await listPaperPositions();
    expect(posAfterHold.netQty).toBe(QTY - partialQty);
    expect((await getPaperWallet()).realizedPnl).toBe(grossPartial);

    // 5. EOD force-flatten — full close goes through closePaperPosition's
    // slippage model: half-spread for price in [100,300) is 0.50, SELL side
    // subtracts it, rounded to the 0.05 tick (already aligned here).
    await manager.evaluate(true);

    const remainingQty = QTY - partialQty; // 45
    const finalFill = 220 - 0.5; // 219.50
    const grossFinal = (finalFill - ENTRY) * remainingQty; // 5377.50
    const finalCharges = calculateOrderCharges('SELL', finalFill, remainingQty);

    const [posFinal] = await listPaperPositions();
    expect(posFinal.netQty).toBe(0);
    expect(posFinal.marginBlocked).toBe(0);

    const totalRealized = grossPartial + grossFinal; // 6877.50
    const totalCharges = entryCharges + partialCharges + finalCharges;

    const final = await getPaperWallet();
    expect(final.realizedPnl).toBeCloseTo(totalRealized, 2);
    expect(final.totalCharges).toBeCloseTo(totalCharges, 2);
    expect(final.usedMargin).toBe(0);
    expect(final.netRealizedPnl).toBeCloseTo(totalRealized - totalCharges, 2);
    expect(final.equity).toBeCloseTo(100000 + totalRealized - totalCharges, 2);
    expect(final.totalBalance).toBeCloseTo(final.availableMargin, 2); // usedMargin = 0
    expect(final.totalBalance).toBeCloseTo(final.equity, 2); // flat position: unrealizedPnl = 0
    expect(final.spanMargin).toBe(0);
    expect(final.exposureMargin).toBe(0);

    // PnL% is not a backend field anywhere (frontend-only, Header.tsx) —
    // derived here purely to confirm the pieces it's built from are correct.
    const pnlPct = ((final.realizedPnl + final.unrealizedPnl) / final.totalBalance) * 100;
    expect(pnlPct).toBeCloseTo((totalRealized / final.totalBalance) * 100, 6);

    // 6. Strategy reconciliation — the bug fixed earlier this session
    const strategies = await listPaperStrategies();
    const strat = strategies.find((s) => s.id === 'lifecycle_strat');
    expect(strat?.status).toBe('STOPPED');
  });

  it('applies the hard 28% stop-loss on a losing move and updates balances correctly negative', async () => {
    await openLongOption();
    const entryCharges = calculateOrderCharges('BUY', ENTRY, QTY);

    const market = stubMarket(60); // well past the 28% stop
    const manager = new LongOptionPositionManager(market);
    await manager.evaluate(false);

    const finalFill = 60 - 0.25; // slippage bucket for price in [20,100) is 0.25
    const grossFinal = (finalFill - ENTRY) * QTY; // -3018.75
    const exitCharges = calculateOrderCharges('SELL', finalFill, QTY);

    const [pos] = await listPaperPositions();
    expect(pos.netQty).toBe(0);
    expect(pos.marginBlocked).toBe(0);

    const wallet = await getPaperWallet();
    expect(wallet.realizedPnl).toBeCloseTo(grossFinal, 2);
    expect(wallet.realizedPnl).toBeLessThan(0);
    expect(wallet.totalCharges).toBeCloseTo(entryCharges + exitCharges, 2);
    expect(wallet.equity).toBeCloseTo(100000 + grossFinal - (entryCharges + exitCharges), 2);
    expect(wallet.equity).toBeLessThan(100000); // proves the negative-PnL path updates balance, not just the winning path
    expect(wallet.usedMargin).toBe(0);
  });
});
