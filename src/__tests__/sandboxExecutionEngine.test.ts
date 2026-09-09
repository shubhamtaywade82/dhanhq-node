import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { SandboxExecutionEngine } from '../engines/sandbox';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import * as sandboxInstruments from '../services/sandboxInstruments';

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test', baseURL: 'https://sandbox.dhan.co/v2' });
}

describe('SandboxExecutionEngine.placeOrder', () => {
  function setup(settled: { orderStatus: string; averagePrice?: number; filledQty?: number }) {
    const client = stubClient();
    jest.spyOn(client.orders, 'place').mockResolvedValue({ correlationId: 'c1', data: { orderId: 'sbx1' } } as any);
    jest.spyOn(client.orders, 'getById').mockResolvedValue(settled as any);
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: true });
    const sandbox = new SandboxExecutionEngine(client, market, risk);
    return { sandbox, client, risk };
  }

  afterEach(() => jest.restoreAllMocks());

  it('places the order against the sandbox client and reports the settled status', async () => {
    const { sandbox, client } = setup({ orderStatus: 'TRADED', averagePrice: 100, filledQty: 50 });
    jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg').mockResolvedValue({
      securityId: '11111', quantity: 50, exchangeSegment: 'NSE_FNO', tickSize: 0.05,
    });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr1', intent_id: 'i1',
      params: {
        security_id: '11111', quantity: 50, transaction_type: 'BUY', price: 99.5,
        underlying: 'NIFTY', strike: 23600, option_type: 'CE', expiry: '2026-09-15',
      },
    });
    expect(res.status).toBe('TRADED');
    expect(res.fill_price).toBe(100);
    expect(res.order_id).toBe('sbx1');
    expect(client.orders.place).toHaveBeenCalledWith(expect.objectContaining({
      orderType: 'LIMIT', price: 99.5, validity: 'DAY',
      disclosedQuantity: 0, triggerPrice: 0, afterMarketOrder: false,
    }));
  });

  it('remaps production security_id to sandbox scrip master before place', async () => {
    const { sandbox, client } = setup({ orderStatus: 'TRADED', averagePrice: 100, filledQty: 65 });
    jest.spyOn(sandboxInstruments, 'resolveSandboxOptionLeg').mockResolvedValue({
      securityId: '46026', quantity: 65, exchangeSegment: 'NSE_FNO', tickSize: 5,
    });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr3', intent_id: 'i3',
      params: {
        security_id: '47301', quantity: 65, transaction_type: 'BUY', price: 123,
        underlying: 'NIFTY', strike: 23600, option_type: 'CE', expiry: '2026-09-15',
      },
    });
    expect(res.status).toBe('TRADED');
    expect(client.orders.place).toHaveBeenCalledWith(expect.objectContaining({
      securityId: '46026', quantity: 65, orderType: 'LIMIT', price: 125,
    }));
  });

  it('rejects without calling the broker when the risk gate blocks', async () => {
    const { sandbox, client, risk } = setup({ orderStatus: 'TRADED' });
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: false, reason: 'kill switch armed' });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr2', intent_id: 'i2',
      params: {
        security_id: '22222', quantity: 10, transaction_type: 'BUY', price: 50,
        underlying: 'NIFTY', strike: 23600, option_type: 'CE',
      },
    });
    expect(res.status).toBe('REJECTED');
    expect(client.orders.place).not.toHaveBeenCalled();
  });
});

describe('SandboxExecutionEngine.closeLeg', () => {
  function setup(settled: { orderStatus: string }) {
    const client = stubClient();
    jest.spyOn(client.orders, 'place').mockResolvedValue({ correlationId: 'c1', data: { orderId: 'sbx-close' } } as any);
    jest.spyOn(client.orders, 'getById').mockResolvedValue(settled as any);
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    const sandbox = new SandboxExecutionEngine(client, market, risk);
    return { sandbox, client, risk };
  }

  afterEach(() => jest.restoreAllMocks());

  it('places a reversing order and bypasses risk.canTrade() — unwinding a partial fill must work even when entries are blocked', async () => {
    const { sandbox, client, risk } = setup({ orderStatus: 'TRADED' });
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: false, reason: 'kill switch armed' });

    const res = await sandbox.closeLeg({ securityId: '11111', qty: 50, side: 'BUY', instrument: 'NIFTY24000CE' }, 100);

    expect(res.status).toBe('TRADED');
    expect(client.orders.place).toHaveBeenCalledWith(expect.objectContaining({ transactionType: 'SELL', quantity: 50 }));
  });
});
