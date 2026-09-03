import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { SandboxExecutionEngine } from '../engines/sandbox';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';

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
    const { sandbox } = setup({ orderStatus: 'TRADED', averagePrice: 100, filledQty: 50 });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr1', intent_id: 'i1',
      params: { security_id: '11111', quantity: 50, transaction_type: 'BUY' },
    });
    expect(res.status).toBe('TRADED');
    expect(res.fill_price).toBe(100);
    expect(res.order_id).toBe('sbx1');
  });

  it('rejects without calling the broker when the risk gate blocks', async () => {
    const { sandbox, client, risk } = setup({ orderStatus: 'TRADED' });
    jest.spyOn(risk, 'canTrade').mockReturnValue({ allowed: false, reason: 'kill switch armed' });
    const res = await sandbox.placeOrder({
      correlation_id: 'corr2', intent_id: 'i2',
      params: { security_id: '22222', quantity: 10, transaction_type: 'BUY' },
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
