import dotenv from "dotenv";
dotenv.config();
import { DhanClient, DhanAuth } from "@nemesis-oss/dhanhq-sdk";
import Redis from "ioredis";
import { moduleLogger } from "./lib/logger";

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

const log = moduleLogger("auth");

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
  const pin = process.env.DHAN_PIN;
  const totpSecret = process.env.DHAN_TOTP_SECRET;
  const authProviderUrl = process.env.DHAN_AUTH_PROVIDER_URL || process.env.DHAN_TOKEN_ENDPOINT;
  const authProviderToken = process.env.DHAN_AUTH_PROVIDER_TOKEN || process.env.DHAN_TOKEN_ACCESS_TOKEN;

  let memoryToken = (accessToken && accessToken !== "your_access_token") ? accessToken : null;
  let memoryTokenAt = memoryToken ? Date.now() : 0;

  const resolveToken = async (): Promise<string> => {
    // 1. Check in-memory token (valid for up to 12 hours)
    if (memoryToken && Date.now() - memoryTokenAt < 12 * 3600 * 1000) {
      return memoryToken;
    }
    // 2. Check Redis cached rotating token
    try {
      const rToken = await redisPublisher.get("dhan:auth:access_token").catch(() => null);
      if (rToken) {
        memoryToken = rToken;
        memoryTokenAt = Date.now();
        return rToken;
      }
    } catch { /* Redis optional */ }
    // 3. Fallback to Rails authority if configured
    if (authProviderUrl && authProviderToken) {
      try {
        const rToken = await fetchTokenFromRails(authProviderUrl, authProviderToken);
        memoryToken = rToken;
        memoryTokenAt = Date.now();
        log.info("DhanHQ token fetched from Rails authority");
        return rToken;
      } catch (e: any) {
        log.warn({ err: { message: e.message }, tier: "rails-authority" }, "Token authority unreachable — falling back to TOTP");
      }
    }
    // 4. Fallback to TOTP generation
    if (pin && totpSecret) {
      try {
        const tToken = await generateTokenViaTotp(clientId, pin, totpSecret);
        memoryToken = tToken;
        memoryTokenAt = Date.now();
        log.info("DhanHQ token generated via TOTP");
        return tToken;
      } catch (e: any) {
        log.warn({ err: { message: e.message }, tier: "totp" }, "TOTP generation failed");
      }
    }
    if (memoryToken) return memoryToken;
    throw new Error("[Sidecar] No DhanHQ credentials configured (set DHAN_ACCESS_TOKEN, TOTP secrets, or Redis token).");
  };

  const initialToken = await resolveToken().catch(() => "");
  const client = new DhanClient({
    clientId,
    token: initialToken || undefined,
    tokenProvider: resolveToken,
  });

  setupTokenRotationSubscriber();
  return client;
}

function setupTokenRotationSubscriber() {
  if (!redisAvailable()) return;
  redisSubscriber.subscribe("dhan:auth:rotated", (err) => {
    if (err) log.error({ err: { message: err.message }, channel: "dhan:auth:rotated" }, "Failed to subscribe to token rotation channel");
    else log.info({ channel: "dhan:auth:rotated" }, "Subscribed to token rotation channel");
  });

  redisSubscriber.on("message", (channel) => {
    if (channel === "dhan:auth:rotated") {
      log.info("Token rotated notification received — new token picked up on next request");
    }
  });
}
