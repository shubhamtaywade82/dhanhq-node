import { DhanClient } from "@nemesis-oss/dhanhq-sdk";
import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";
export const redisSubscriber = new Redis(redisUrl);
export const redisPublisher = new Redis(redisUrl);

export async function createDhanClient(): Promise<DhanClient> {
  const clientId = (await redisPublisher.get("dhan:auth:client_id")) || process.env.DHAN_CLIENT_ID || "";
  const accessToken = process.env.DHAN_ACCESS_TOKEN;
  const authProviderUrl = process.env.DHAN_AUTH_PROVIDER_URL || process.env.DHAN_TOKEN_ENDPOINT;
  const authProviderToken = process.env.DHAN_AUTH_PROVIDER_TOKEN || process.env.DHAN_TOKEN_ACCESS_TOKEN;

  if (accessToken && accessToken !== "your_access_token") {
    return new DhanClient({ clientId, token: accessToken });
  }

  if (authProviderUrl && authProviderToken) {
    return DhanClient.fromTokenEndpoint({
      endpointBaseUrl: authProviderUrl,
      bearerToken: authProviderToken,
    });
  }

  const client = new DhanClient({
    clientId,
    tokenProvider: async () => {
      const token = await redisPublisher.get("dhan:auth:access_token");
      if (!token) {
        throw new Error("[Sidecar] Token missing in Redis key dhan:auth:access_token. Token Authority (Rails) must refresh token.");
      }
      return token;
    }
  });

  redisSubscriber.subscribe("dhan:auth:rotated", (err) => {
    if (err) {
      console.error("[Sidecar] Failed to subscribe to dhan:auth:rotated channel:", err);
    } else {
      console.log("[Sidecar] Subscribed to dhan:auth:rotated channel from Token Authority (Rails).");
    }
  });

  // Guardrail: Rails' Live::MarketFeedHub and Live::OrderUpdateHub are the only Dhan
  // WebSocket clients this system should ever run. A second client authenticating with
  // the same credentials causes 429 handshake errors — that collision is the whole reason
  // this branch exists (see the other commits). Don't open a WS here to react to rotation.
  redisSubscriber.on("message", (channel) => {
    if (channel === "dhan:auth:rotated") {
      console.log("[Sidecar] Token rotated notification received from Rails. tokenProvider will pick up the new token on next use.");
    }
  });

  return client;
}
