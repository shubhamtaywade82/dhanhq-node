import { DhanClient, DhanAuth } from "@nemesis-oss/dhanhq-sdk";
import Redis from "ioredis";

/**
 * DhanHQ client factory.
 *
 * Token resolution order:
 *   1. DHAN_ACCESS_TOKEN (direct)
 *   2. Rails token authority (DHAN_AUTH_PROVIDER_URL + token)
 *   3. Dhan TOTP (DHAN_CLIENT_ID + DHAN_PIN + DHAN_TOTP_SECRET)
 *   4. Redis-held rotating token (dhan:auth:access_token)
 *
 * Redis is OPTIONAL: when unreachable the system still boots and trades
 * with the token from steps 1-3 (pub/sub events become no-ops).
 * NOTE: uses native fetch — axios was never a declared dependency.
 */

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";

function lazyRedis(url: string): Redis {
  const r = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 1000, 10000)),
    enableOfflineQueue: false,
  });
  r.on('error', (e) => { /* swallow — Redis is optional */ });
  return r;
}

export const redisPublisher: Pick<Redis, 'publish' | 'set' | 'get' | 'ping' | 'info' | 'ttl' | 'keys'> & { status?: string } = lazyRedis(redisUrl);
export const redisSubscriber = lazyRedis(redisUrl);
export const redisAvailable = () => (redisPublisher as any).status === 'ready';

// Fetches a fresh token from the Rails token authority (Tier 2).
async function fetchTokenFromRails(baseUrl: string, bearerToken: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/dhan_access_token`, {
    headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Rails authority HTTP ${res.status}`);
  const data = await res.json();
  const token = data.dhan_access_token || data.dhanaccesstoken;
  if (!token) throw new Error(`[Auth] Rails returned no token. Keys: ${Object.keys(data).join(", ")}`);
  return token;
}

// Generates an access token via Dhan TOTP authentication (Tier 3 fallback).
export async function generateTokenViaTotp(clientId: string, pin: string, totpSecret: string): Promise<string> {
  const totp = DhanAuth.generateTotp(totpSecret);
  const authBaseUrl = process.env.DHAN_AUTH_BASE_URL || process.env.DHANHQ_BASE_URL || "https://auth.dhan.co";
  const res = await DhanAuth.generateAccessToken({ clientId, pin, totp });
  const token = res.accessToken;
  if (!token) throw new Error("[Auth] TOTP response did not contain access token");

  if (redisAvailable()) {
    await redisPublisher.set("dhan:auth:access_token", token, "EX", 82800).catch(() => {});
    await redisPublisher.set("dhan:auth:client_id", clientId).catch(() => {});
  }
  return token;
}

export async function createDhanClient(): Promise<DhanClient> {
  const clientId = (redisAvailable() ? await redisPublisher.get("dhan:auth:client_id").catch(() => null) : null)
    || process.env.DHAN_CLIENT_ID || process.env.CLIENT_ID || "";
  const accessToken = process.env.DHAN_ACCESS_TOKEN;
  const authProviderUrl = process.env.DHAN_AUTH_PROVIDER_URL || process.env.DHAN_TOKEN_ENDPOINT;
  const authProviderToken = process.env.DHAN_AUTH_PROVIDER_TOKEN || process.env.DHAN_TOKEN_ACCESS_TOKEN;
  const pin = process.env.DHAN_PIN;
  const totpSecret = process.env.DHAN_TOTP_SECRET;

  if (accessToken && accessToken !== "your_access_token") {
    return new DhanClient({ clientId, token: accessToken });
  }

  if (authProviderUrl && authProviderToken) {
    try {
      const token = await fetchTokenFromRails(authProviderUrl, authProviderToken);
      console.log("[Auth] Token fetched from Rails authority successfully.");
      return new DhanClient({ clientId, token });
    } catch (e: any) {
      console.warn(`[Auth] Token authority unreachable (${e.message}). Falling back to TOTP/Redis...`);
    }
  }

  if (pin && totpSecret) {
    try {
      const token = await generateTokenViaTotp(clientId, pin, totpSecret);
      console.log("[Auth] Token generated via Dhan TOTP successfully.");
      return new DhanClient({
        clientId,
        token,
        tokenProvider: () => generateTokenViaTotp(clientId, pin, totpSecret),
      });
    } catch (e: any) {
      console.warn(`[Auth] TOTP generation failed (${e.message}). Falling back to Redis token...`);
    }
  }

  const client = new DhanClient({
    clientId,
    tokenProvider: async () => {
      if (redisAvailable()) {
        const token = await redisPublisher.get("dhan:auth:access_token").catch(() => null);
        if (token) return token;
      }
      if (pin && totpSecret) return generateTokenViaTotp(clientId, pin, totpSecret);
      throw new Error("[Sidecar] No DhanHQ credentials configured (set DHAN_ACCESS_TOKEN, TOTP secrets, or Redis token).");
    },
  });

  setupTokenRotationSubscriber();
  return client;
}

function setupTokenRotationSubscriber() {
  if (!redisAvailable()) return;
  redisSubscriber.subscribe("dhan:auth:rotated", (err) => {
    if (err) console.error("[Sidecar] Failed to subscribe to dhan:auth:rotated:", err);
    else console.log("[Sidecar] Subscribed to dhan:auth:rotated channel.");
  });

  redisSubscriber.on("message", (channel) => {
    if (channel === "dhan:auth:rotated") {
      console.log("[Sidecar] Token rotated notification received. New token will be picked up on next request.");
    }
  });
}
