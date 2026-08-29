import dotenv from "dotenv";
import { startCore } from "./core";
import Redis from "ioredis";
import type { Core } from "./core";

dotenv.config();

// Default Node behavior is to crash the process on these, which kills the whole `bin/dev`
// foreman group (any Procfile process exiting triggers SIGTERM to all). This is an auxiliary
// execution sidecar — it must never take the Rails trading daemon down with it.
process.on("uncaughtException", (e) => console.error("[Sidecar] Uncaught exception:", e));
process.on("unhandledRejection", (e) => console.error("[Sidecar] Unhandled rejection:", e));

/**
 * Headless sidecar entry (no HTTP server).
 *
 * Boots the SAME autonomous core as the API server — market data feed,
 * risk engine, autonomy loop, agent orchestrator — and additionally
 * listens for execution intents on Redis (`dhan:execution:intents`),
 * the legacy Rails bridge. The system runs and trades autonomously
 * whether or not anything else is attached.
 */
async function main() {
  console.log("=================================================");
  console.log("Starting DhanHQ-TS Execution Sidecar (headless)");
  console.log(`Mode: ${process.env.TRADING_MODE || "paper"}`);
  console.log("=================================================");

  try {
    const core = await startCore();
    await listenForIntents(core);
    console.log("[Sidecar] Process ready. Autonomous stack running; listening for Rails Redis intents.");
  } catch (e) {
    console.error("[Sidecar] Initialization error:", e);
  }
}

async function listenForIntents(core: Core): Promise<void> {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";
  const intentSubscriber = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 1000, 10000)),
  });
  intentSubscriber.on('error', () => { /* Redis optional in headless mode */ });

  intentSubscriber.subscribe("dhan:execution:intents", (err) => {
    if (err) {
      console.error("[Sidecar Executor] Subscribe error:", err.message);
      return;
    }
    console.log("[Sidecar Executor] Subscribed to dhan:execution:intents");
  });

  intentSubscriber.on("message", async (channel, message) => {
    if (channel !== "dhan:execution:intents") return;
    try {
      const intent = JSON.parse(message);
      console.log(`[Sidecar Executor] Processing intent ${intent.intent_id} (${intent.strategy})`);
      const isLive = process.env.TRADING_MODE === "live";
      const engine = isLive ? core.live : core.paper;
      await engine.placeOrder(intent);
    } catch (e: any) {
      console.error("[Sidecar Executor] Execution failed:", e.message);
    }
  });
}

main();
