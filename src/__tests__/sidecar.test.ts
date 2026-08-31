import { initDatabase, executePaperOrder, listPaperPositions, listPaperOrders, getPaperWallet, closePaperPosition, resetPaperWallet, pool } from "../db";

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
    const closeRes = await closePaperPosition("NIFTY24JAN24250CE", 220);
    expect(closeRes.status).toBe("TRADED");

    const positions = await listPaperPositions();
    const pos = positions.find((p) => p.tradingSymbol === "NIFTY24JAN24250CE");
    expect(pos?.netQty).toBe(0);
    expect(pos?.realizedProfit).toBe(1000); // (220 - 200) * 50 = +1000

    const wallet = await getPaperWallet();
    expect(wallet.realizedPnl).toBe(1000);
  });

  it("generates a valid 6-digit TOTP from base32 secret", () => {
    const { DhanAuth } = require("@nemesis-oss/dhanhq-sdk");
    const secret = "JBSWY3DPEHPK3PXP"; // RFC 4648 Base32 test secret
    const code = DhanAuth.generateTotp(secret);
    expect(code).toBeDefined();
    expect(code).toMatch(/^\d{6}$/);
  });
});
