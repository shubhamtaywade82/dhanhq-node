import { normalizeBrokerOrder } from '../routes/portfolio';

// journalOrderRows is internal — tested via listBrokerOrders integration would
// need a full router boot; cover normalize mapping here only.

describe('normalizeBrokerOrder', () => {
  it('maps DhanHQ OrderResponse fields into the paper order-book row shape', () => {
    const row = normalizeBrokerOrder({
      orderId: '712607202142',
      correlationId: 'strat_ast_test',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      tradingSymbol: 'NIFTY23200CE',
      orderType: 'MARKET',
      quantity: 65,
      price: 0,
      filledQty: 65,
      averageTradedPrice: 100,
      createTime: '2026-09-09 12:19:37',
      legName: 'NA',
      exchangeSegment: 'NSE_FNO',
    });
    expect(row.id).toBe('712607202142');
    expect(row.corr).toBe('strat_ast_test');
    expect(row.instrument).toBe('NIFTY23200CE');
    expect(row.side).toBe('BUY');
    expect(row.qty).toBe(65);
    expect(row.filled).toBe(65);
    expect(row.avg).toBe(100);
    expect(row.status).toBe('TRADED');
  });
});
