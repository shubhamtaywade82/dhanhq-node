import { DhanClient, type Candle } from '@nemesis-oss/dhanhq-sdk';
import { MarketDataService } from '../services/marketData';
import { RiskEngine } from '../services/riskEngine';
import { PaperExecutionEngine } from '../engines/paper';
import { AdaptiveSupertrendScanner } from '../services/adaptiveSupertrendScanner';
import { AdaptiveParameterAI } from '../services/adaptiveSupertrend';
import { initDatabase, resetPaperWallet, listPaperStrategies, listPaperPositions } from '../db';

// Engineered so a bullish 1m Supertrend crossover fires on the very last
// bar, the 5m Supertrend (derived from the same buffer) agrees, and the
// resulting regime bucket ("medium" volatility / "strong" trend) is NOT the
// special-cased high-vol/strong-trend heuristic seed — so with epsilon
// forced to 0, AdaptiveParameterAI deterministically argmaxes to action
// index 4 ({atrPeriod:14, multiplier:3.0}), the exact params used to
// verify the crossover below. Found by direct search against the SDK's
// real supertrend()/adx()/bollingerBands() — see scratchpad/find_candles.js.
function buildCrossoverSeries(): Candle[] {
  const candles: Candle[] = [];
  let ts = 1_704_100_800; // 5-minute-aligned epoch seconds
  let px = 100;
  for (let i = 0; i < 60; i++) {
    px += -0.2 + Math.sin(i * 0.7) * 0.15;
    candles.push({ timestamp: ts, open: px, high: px + 0.3, low: px - 0.3, close: px, volume: 0 });
    ts += 60;
  }
  for (let i = 0; i < 3; i++) {
    px += 0.8;
    candles.push({ timestamp: ts, open: px, high: px + 0.3, low: px - 0.3, close: px, volume: 0 });
    ts += 60;
  }
  return candles;
}

function toChartsResponse(candles: Candle[]) {
  return {
    timestamp: candles.map((c) => c.timestamp),
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
  };
}

const lastClose = buildCrossoverSeries().at(-1)!.close; // ~90.76
const sampleChain = [
  { strike: Math.round(lastClose) - 5, ce: { ltp: 8, securityId: '901' }, pe: { ltp: 3, securityId: '902' } },
  { strike: Math.round(lastClose), ce: { ltp: 5, securityId: '903' }, pe: { ltp: 5, securityId: '904' } },
  { strike: Math.round(lastClose) + 5, ce: { ltp: 3, securityId: '905' }, pe: { ltp: 8, securityId: '906' } },
];

// NIFTY's securityId ('13', see INDEX_INSTRUMENTS) gets the engineered
// crossover series; every other watchlist symbol gets too few candles to
// signal at all — otherwise all 5 symbols would fire off the same series.
function fakeClient(): DhanClient {
  const series = toChartsResponse(buildCrossoverSeries());
  const flat = toChartsResponse(buildCrossoverSeries().slice(0, 10));
  return {
    charts: {
      intraday: jest.fn().mockImplementation(({ securityId }: { securityId: string }) =>
        Promise.resolve(securityId === '13' ? series : flat)),
    },
    optionChain: { fetchNormalized: jest.fn().mockResolvedValue({ strikes: sampleChain }) },
  } as unknown as DhanClient;
}

describe('AdaptiveSupertrendScanner (wired against real db.ts)', () => {
  beforeAll(async () => { await initDatabase(); });
  beforeEach(async () => { await resetPaperWallet(); });

  it('deploys a BUY leg with no risk_limits, records the strategy, and tracks a pending reward', async () => {
    const client = fakeClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const paramAI = new AdaptiveParameterAI({ epsilon: 0 }); // deterministic argmax, no persistence file

    const addInstrumentsSpy = jest.spyOn(market, 'addInstruments');
    const placeOrderSpy = jest.spyOn(paper, 'placeOrder');

    const scanner = new AdaptiveSupertrendScanner(client, market, paper, risk, paramAI);
    await scanner.evaluate({ isMarketOpen: true, squareOffWindow: false });

    expect(addInstrumentsSpy).toHaveBeenCalled();
    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
    const intent = placeOrderSpy.mock.calls[0]![0];
    expect(intent.risk_limits).toBeUndefined();
    expect(intent.params.transaction_type).toBe('BUY');

    const strategies = await listPaperStrategies();
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.type).toBe('ADAPTIVE_SUPERTREND');

    const positions = await listPaperPositions();
    expect(positions.filter((p: any) => p.netQty > 0)).toHaveLength(1);

    const pendingLearns: Map<string, any> = (scanner as any).pendingLearns;
    const openLeg: Map<string, string> = (scanner as any).openLeg;
    expect(pendingLearns.has('NIFTY')).toBe(true);
    expect(openLeg.has('NIFTY')).toBe(true);
  });

  it('does nothing outside market hours', async () => {
    const client = fakeClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const placeOrderSpy = jest.spyOn(paper, 'placeOrder');

    const scanner = new AdaptiveSupertrendScanner(client, market, paper, risk, new AdaptiveParameterAI({ epsilon: 0 }));
    await scanner.evaluate({ isMarketOpen: false, squareOffWindow: false });

    expect(placeOrderSpy).not.toHaveBeenCalled();
  });
});
