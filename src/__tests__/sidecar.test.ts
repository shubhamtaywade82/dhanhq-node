import { initDatabase, executePaperOrder, listPaperPositions, listPaperOrders, getPaperWallet, closePaperPosition, resetPaperWallet, pool } from "../db";
import { eventBus } from "../services/eventBus";

describe("DhanHQ-TS Node.js Sidecar & Paper Trading", () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    await resetPaperWallet(100000);
    await pool.end();
  });

  it("exports correct configuration and mode", () => {
    const mode = process.env.TRADING_MODE || "paper";
    expect(mode).toBe("paper");
  });

  it("resets paper wallet to initial balance", async () => {
    const res = await resetPaperWallet(100000);
    expect(res.status).toBe("ok");
    expect(res.initialBalance).toBe(100000);

    const wallet = await getPaperWallet();
    expect(wallet.availableMargin).toBe(100000);
    expect(wallet.usedMargin).toBe(0);
    expect(wallet.realizedPnl).toBe(0);
  });

  it("executes a paper buy order and tracks position and wallet margin", async () => {
    const order = await executePaperOrder({
      symbol: "NIFTY24JAN24250CE",
      transactionType: "BUY",
      quantity: 50,
      price: 200,
    });
    expect(order.status).toBe("TRADED");
    expect(order.quantity).toBe(50);

    const positions = await listPaperPositions();
    const pos = positions.find((p) => p.tradingSymbol === "NIFTY24JAN24250CE");
    expect(pos).toBeDefined();
    expect(pos?.netQty).toBe(50);
    expect(pos?.buyAvg).toBe(200);

    const orders = await listPaperOrders();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders[0].instrument).toBe("NIFTY24JAN24250CE");
  });

  it("closes paper position and realizes PnL in wallet", async () => {
    // 220 is a reference price, not the fill price — closing a long SELLs,
    // and a SELL exit pays the bid side of the modelled spread (half-spread
    // 0.50 at this premium bracket): fill = 220 - 0.50 = 219.50.
    const closeRes = await closePaperPosition("NIFTY24JAN24250CE", 220);
    expect(closeRes.status).toBe("TRADED");

    const positions = await listPaperPositions();
    const pos = positions.find((p) => p.tradingSymbol === "NIFTY24JAN24250CE");
    expect(pos?.netQty).toBe(0);
    expect(pos?.realizedProfit).toBe(975); // (219.50 - 200) * 50 = +975

    const wallet = await getPaperWallet();
    expect(wallet.realizedPnl).toBe(975);
  });

  it("emits an 'order' fill envelope on close — every prior exit path bypassed the engine and emitted nothing", async () => {
    await executePaperOrder({ symbol: "NIFTY24JAN24300CE", transactionType: "BUY", quantity: 50, price: 150 });

    const seen: any[] = [];
    const off = eventBus.on('order', (env) => seen.push(env.payload));
    try {
      const res = await closePaperPosition("NIFTY24JAN24300CE", 160);
      expect(res.status).toBe("TRADED");
      const fill = seen.find((p) => p.kind === 'fill' && p.symbol === 'NIFTY24JAN24300CE');
      expect(fill).toBeDefined();
      expect(fill.fill_price).toBeCloseTo((res as any).fillPrice, 2);
    } finally {
      off();
    }
  });

  it("prices a triggered-stop close with more adverse slippage than a plain exit", async () => {
    await executePaperOrder({ symbol: "NIFTY24JAN24350CE", transactionType: "BUY", quantity: 50, price: 150 });
    const plain = await closePaperPosition("NIFTY24JAN24350CE", 160, undefined, 'EXIT');
    expect(plain.status).toBe("TRADED");

    await executePaperOrder({ symbol: "NIFTY24JAN24350CE", transactionType: "BUY", quantity: 50, price: 150 });
    const stop = await closePaperPosition("NIFTY24JAN24350CE", 160, undefined, 'STOP');
    expect(stop.status).toBe("TRADED");

    // Both close a long (SELL) at the same 160 reference — the STOP fill
    // must be strictly lower (more adverse) than the plain exit fill.
    expect((stop as any).fillPrice).toBeLessThan((plain as any).fillPrice);
  });

  it("generates a valid 6-digit TOTP from base32 secret", () => {
    const { DhanAuth } = require("@nemesis-oss/dhanhq-sdk");
    const secret = "JBSWY3DPEHPK3PXP"; // RFC 4648 Base32 test secret
    const code = DhanAuth.generateTotp(secret);
    expect(code).toBeDefined();
    expect(code).toMatch(/^\d{6}$/);
  });
});
