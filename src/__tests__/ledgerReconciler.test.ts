/**
 * Runs against a REAL Postgres instance — this reconciler's entire job is
 * comparing mem against actual persisted rows, so a mock of `pool.query`
 * would only prove the mock behaves as scripted, not that the SQL and
 * NUMERIC/NULL handling are actually correct. Requires TEST_DATABASE_URL
 * (any truthy value, to opt out of the forced in-memory test mode) and
 * DATABASE_URL pointing at a real, disposable database:
 *
 *   DATABASE_URL=postgres://dhanhq_test:test@127.0.0.1:5432/dhanhq_node_test \
 *   TEST_DATABASE_URL=1 npx jest ledgerReconciler --forceExit
 *
 * Run in its own jest invocation, not part of the default suite — the rest
 * of the suite is written and tuned against the in-memory mode every other
 * test file runs in, and flipping the whole process to Postgres mode would
 * change their behavior too.
 */
import {
  initDatabase, dbMode, pool, executePaperOrder, getPaperWallet, listPaperPositions,
  reconcileLedger, correctLedgerFromPostgres, resetPaperWallet, findMissingOrders, closePaperPosition,
} from '../db';

const RUN = !!process.env.TEST_DATABASE_URL;
const d = RUN ? describe : describe.skip;

// `pool` is a single module-level singleton shared by every describe block
// in this file (and, if imported elsewhere in the same jest run, the whole
// process) — ending it belongs in ONE top-level afterAll, not one per
// describe block. Calling pool.end() inside the first block's afterAll
// closed the pool before the second block's beforeAll could reconnect,
// silently falling back to memory mode and failing every assertion in it.
afterAll(async () => {
  if (RUN) await pool.end();
});

d('reconcileLedger / correctLedgerFromPostgres (real Postgres)', () => {
  beforeAll(async () => {
    await initDatabase();
    expect(dbMode()).toBe('postgres'); // fail loudly if the env isn't actually wired to Postgres
  });

  beforeEach(async () => { await resetPaperWallet(100000); });

  it('reports no drift right after a normal fill — mem and Postgres were written from the same transaction', async () => {
    await executePaperOrder({ symbol: 'LEDGER_OK', securityId: '77001', quantity: 50, transactionType: 'BUY', price: 100 });
    const report = await reconcileLedger();
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
  });

  it('detects a wallet field changed directly in Postgres, outside this process, and corrects mem from it', async () => {
    await executePaperOrder({ symbol: 'LEDGER_WALLET', securityId: '77002', quantity: 50, transactionType: 'BUY', price: 100 });
    // Simulates exactly what the reconciler exists to catch: a change to
    // the durable store this process didn't make itself.
    await pool.query(`UPDATE paper_wallet SET realized_pnl = realized_pnl + 500 WHERE id = 'default'`);

    const report = await reconcileLedger();
    expect(report.ok).toBe(false);
    expect(report.mismatches.some((m) => m.subject === 'wallet' && m.field === 'realized_pnl')).toBe(true);

    const before = await getPaperWallet();
    await correctLedgerFromPostgres(report);
    const after = await getPaperWallet();
    expect(after.realizedPnl).toBeCloseTo(before.realizedPnl + 500, 2); // mem now matches Postgres
    expect((await reconcileLedger()).ok).toBe(true); // and the drift is gone
  });

  it('detects a position field changed directly in Postgres and corrects mem from it', async () => {
    await executePaperOrder({ symbol: 'LEDGER_POS', securityId: '77003', quantity: 50, transactionType: 'BUY', price: 100 });
    await pool.query(`UPDATE paper_positions SET stop_loss = 42.50 WHERE id = 'LEDGER_POS'`);

    const report = await reconcileLedger();
    expect(report.ok).toBe(false);
    expect(report.mismatches.some((m) => m.subject === 'LEDGER_POS' && m.field === 'stop_loss')).toBe(true);

    await correctLedgerFromPostgres(report);
    const pos = (await listPaperPositions()).find((p) => p.tradingSymbol === 'LEDGER_POS');
    expect(pos?.stopLoss).toBeCloseTo(42.5, 2);
  });

  it('never flags ltp or unrealized_pnl — mark-to-market legitimately updates those in mem only', async () => {
    await executePaperOrder({ symbol: 'LEDGER_MTM', securityId: '77004', quantity: 50, transactionType: 'BUY', price: 100 });
    // Postgres's ltp is whatever it was at the fill (100) and is NEVER
    // updated by mark-to-market — mem's ltp moving away from that on every
    // tick must not be reported as drift.
    const positions = await listPaperPositions();
    const pos = positions.find((p) => p.tradingSymbol === 'LEDGER_MTM');
    expect(pos?.ltp).toBe(100);
    // Directly diverge mem's ltp the way markPositionsToMarket would, via
    // the public API surface available: there isn't one that touches only
    // ltp without a real tick feed in this test, so instead assert the
    // FIELD LIST itself excludes ltp/unrealized_pnl by checking that a
    // Postgres-side ltp change alone (with mem unchanged) is NOT reported.
    await pool.query(`UPDATE paper_positions SET ltp = 999 WHERE id = 'LEDGER_MTM'`);
    const report = await reconcileLedger();
    expect(report.mismatches.some((m) => m.field === 'ltp' || m.field === 'unrealized_pnl')).toBe(false);
  });

  it('flags a position open in Postgres but absent from mem, and pulls it in on correction', async () => {
    // Simulates a write that reached Postgres but never touched mem — the
    // scenario missingInMem exists to catch.
    await pool.query(
      `INSERT INTO paper_positions (id, symbol, security_id, exchange_segment, product_type, buy_qty, buy_avg, sell_qty, sell_avg, net_qty, realized_pnl, ltp, margin_blocked)
       VALUES ('LEDGER_GHOST', 'LEDGER_GHOST', '77005', 'NSE_FNO', 'INTRADAY', 50, 100, 0, 0, 50, 0, 100, 5000)`,
    );

    const report = await reconcileLedger();
    expect(report.missingInMem).toContain('LEDGER_GHOST');

    expect((await listPaperPositions()).find((p) => p.tradingSymbol === 'LEDGER_GHOST')).toBeUndefined();
    await correctLedgerFromPostgres(report);
    expect((await listPaperPositions()).find((p) => p.tradingSymbol === 'LEDGER_GHOST')).toBeDefined();
  });

  it('flags a position open in mem but absent (or flat) in Postgres, and drops it from mem on correction', async () => {
    await executePaperOrder({ symbol: 'LEDGER_PHANTOM', securityId: '77006', quantity: 50, transactionType: 'BUY', price: 100 });
    // Simulates Postgres losing the write mem still believes happened.
    await pool.query(`DELETE FROM paper_positions WHERE id = 'LEDGER_PHANTOM'`);

    const report = await reconcileLedger();
    expect(report.missingInPostgres).toContain('LEDGER_PHANTOM');

    expect((await listPaperPositions()).find((p) => p.tradingSymbol === 'LEDGER_PHANTOM')).toBeDefined();
    await correctLedgerFromPostgres(report);
    expect((await listPaperPositions()).find((p) => p.tradingSymbol === 'LEDGER_PHANTOM')).toBeUndefined();
  });
});

d('findMissingOrders (real Postgres)', () => {
  beforeAll(async () => {
    await initDatabase();
    expect(dbMode()).toBe('postgres');
  });
  beforeEach(async () => { await resetPaperWallet(100000); });

  it('matches an entry order by its correlation_id column', async () => {
    await executePaperOrder({
      symbol: 'FMO_PG_ENTRY', securityId: '77007', quantity: 50,
      transactionType: 'BUY', price: 100, correlationId: 'fmo_pg_corr_1',
    });
    expect(await findMissingOrders(['fmo_pg_corr_1'])).toEqual([]);
  });

  it('matches an exit order by its id column', async () => {
    await executePaperOrder({ symbol: 'FMO_PG_EXIT', securityId: '77008', quantity: 50, transactionType: 'BUY', price: 100 });
    const close: any = await closePaperPosition('FMO_PG_EXIT', 110);
    expect(await findMissingOrders([close.orderId])).toEqual([]);
  });

  it('reports an id absent from paper_orders entirely', async () => {
    expect(await findMissingOrders(['pg_never_placed'])).toEqual(['pg_never_placed']);
  });
});
