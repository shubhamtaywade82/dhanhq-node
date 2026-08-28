import { DhanClient, OrderTracker, PositionMonitor, Pipeline, createSkillRegistry } from "@nemesis-oss/dhanhq-sdk";
import { OllamaClient } from "@nemesis-oss/ollama-sdk";
import Redis from "ioredis";
import { redisPublisher } from "./auth";
import { PaperExecutionEngine } from "./engines/paper";
import { LiveExecutionEngine } from "./engines/live";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";
const intentSubscriber = new Redis(redisUrl);

async function publishIntentAnalysis(client: OllamaClient, intent: any): Promise<void> {
  const content = await client.chatText({
    model: process.env.OLLAMA_MODEL || "llama3.2",
    messages: [
      {
        role: "system",
        content: "You are a trading risk analyst. Summarize the intent, identify obvious risk concerns, and never recommend bypassing deterministic risk checks. Keep the response under 120 words."
      },
      { role: "user", content: JSON.stringify(intent) }
    ],
    options: { temperature: 0.1 }
  });

  await redisPublisher.publish("dhan:execution:ai_analysis", JSON.stringify({
    intent_id: intent.intent_id,
    correlation_id: intent.correlation_id,
    model: process.env.OLLAMA_MODEL || "llama3.2",
    analysis: content,
    analyzed_at: new Date().toISOString()
  }));
}

export async function startExecutor(client: DhanClient): Promise<void> {
  const tracker = new OrderTracker();
  const monitor = new PositionMonitor();
  const skills = createSkillRegistry();

  const isLive = process.env.TRADING_MODE === "live";
  const ollama = process.env.OLLAMA_ENABLED === "true"
    ? new OllamaClient({
      baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      apiKey: process.env.OLLAMA_API_KEY,
      timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 10000,
      retries: 1
    })
    : null;
  const paperEngine = new PaperExecutionEngine(client, monitor);
  const liveEngine = new LiveExecutionEngine(client, tracker, monitor);

  // Dead until ticks are re-sourced: PositionMonitor only ever emits "exit" from its
  // onTick handler, whose only caller was the market-WS listener deleted on this branch
  // (WS collided with Rails' own Dhan WebSocket clients). This listener never fires until
  // ticks feed the monitor another way (e.g. Rails' Live::TickCache via Redis instead of
  // a direct WS subscription).
  monitor.on("exit", async (signal: any) => {
    console.log(`[PositionMonitor] Exit triggered: ${signal.reason}, PnL: ${signal.pnl}`);
    const exitPayload = {
      position_id: signal.positionId,
      correlation_id: signal.correlationId || signal.positionId,
      exit_price: signal.exitPrice,
      pnl: signal.pnl,
      reason: signal.reason,
      is_paper: !isLive,
      exited_at: new Date().toISOString()
    };
    await redisPublisher.publish("dhan:execution:exits", JSON.stringify(exitPayload));
  });

  intentSubscriber.subscribe("dhan:execution:intents", (err) => {
    if (err) console.error("[Sidecar Executor] Subscribe error:", err);
    else console.log("[Sidecar Executor] Subscribed to dhan:execution:intents");
  });

  intentSubscriber.on("message", async (channel, message) => {
    if (channel !== "dhan:execution:intents") return;

    try {
      const intent = JSON.parse(message);
      console.log(`[Sidecar Executor] Processing intent ${intent.intent_id} (${intent.strategy})`);

      if (ollama) {
        void publishIntentAnalysis(ollama, intent).catch((error) => {
          console.warn("[Sidecar Executor] Ollama analysis unavailable:", error);
        });
      }

      // Pre-trade risk pipeline check
      const pipeline = new Pipeline({
        limits: {
          maxQuantity: Number(process.env.RISK_MAX_QUANTITY) || 500,
          dailyMaxLoss: Number(process.env.RISK_DAILY_MAX_LOSS) || 10000
        }
      });
      await pipeline.run({ args: intent.params });

      // Check if intent is a defined-risk spread skill (e.g., bull_call_spread, iron_condor)
      if (intent.strategy && intent.strategy !== "buy_option" && intent.strategy !== "naked") {
        try {
          const { intent: skillIntent } = await skills.call(intent.strategy, intent.params, client);
          console.log(`[Sidecar Executor] Resolved Skill ${intent.strategy} legs:`, (skillIntent as any)?.legs);
        } catch (e) {
          console.warn(`[Sidecar Executor] Skill resolution for ${intent.strategy} skipped fallback to raw execution:`, e);
        }
      }

      if (isLive) {
        await liveEngine.placeOrder(intent);
      } else {
        await paperEngine.placeOrder(intent);
      }
    } catch (e) {
      console.error("[Sidecar Executor] Execution failed:", e);
    }
  });
}
