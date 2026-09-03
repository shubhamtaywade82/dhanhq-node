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
export const redisAvailable = async (): Promise<boolean> => {
  if ((redisPublisher as any).status === 'ready') return true;
  if ((redisPublisher as any).status === 'connecting') {
    await Promise.race([
      new Promise((resolve) => (redisPublisher as any).once('ready', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    return (redisPublisher as any).status === 'ready';
  }
  return false;
};

// Fetches a fresh token from the Rails token authority (algo_scalper_api).
async function fetchTokenFromRails(baseUrl: string, bearerToken?: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/dhan_access_token`, {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Rails authority HTTP ${res.status}`);
  const data = await res.json();
  const token = data.dhan_access_token || data.dhanaccesstoken;
  if (!token) throw new Error(`[Auth] Rails returned no token. Keys: ${Object.keys(data).join(", ")}`);
  return token;
}

// Generates an access token via Dhan TOTP authentication (Tier 3 fallback when algo_scalper_api is down).
export async function generateTokenViaTotp(clientId: string, pin: string, totpSecret: string): Promise<string> {
  const totp = DhanAuth.generateTotp(totpSecret);
  const res = await DhanAuth.generateAccessToken({ clientId, pin, totp });
  const token = res.accessToken;
  if (!token) throw new Error("[Auth] TOTP response did not contain access token");

  if (await redisAvailable()) {
    await redisPublisher.set("dhan:auth:access_token", token, "EX", 82800).catch(() => {});
    await redisPublisher.set("dhan:auth:client_id", clientId).catch(() => {});
  }
  return token;
}

let activeToken: string | null = null;
let activeTokenAt = 0;

export async function createDhanClient(): Promise<DhanClient> {
  const isRedisReady = await redisAvailable();
  const clientId = (isRedisReady ? await redisPublisher.get("dhan:auth:client_id").catch(() => null) : null)
    || process.env.DHAN_CLIENT_ID || process.env.CLIENT_ID || "";
  const accessToken = process.env.DHAN_ACCESS_TOKEN;
  const pin = process.env.DHAN_PIN;
  const totpSecret = process.env.DHAN_TOTP_SECRET;
  const authProviderUrl = process.env.DHAN_AUTH_PROVIDER_URL || process.env.DHAN_TOKEN_ENDPOINT || "http://localhost:3000";
  const authProviderToken = process.env.DHAN_AUTH_PROVIDER_TOKEN || process.env.DHAN_TOKEN_ACCESS_TOKEN;

  if (accessToken && accessToken !== "your_access_token") {
    activeToken = accessToken;
    activeTokenAt = Date.now();
  }

  let lastAuthorityFailAt = 0;

  const resolveToken = async (): Promise<string> => {
    // 1. In-memory token if fresh (< 12 hours) — zero network overhead
    if (activeToken && Date.now() - activeTokenAt < 12 * 3600 * 1000) {
      return activeToken;
    }

    // 2. Primary: Read live rotating token from Redis (written by algo_scalper_api or TOTP)
    if (await redisAvailable()) {
      try {
        const rToken = await redisPublisher.get("dhan:auth:access_token").catch(() => null);
        if (rToken) {
          activeToken = rToken;
          activeTokenAt = Date.now();
          return rToken;
        }
      } catch { /* Redis fallback */ }
    }

    // 3. Secondary: Query algo_scalper_api REST endpoint (with 60s cooldown on failure)
    if (authProviderUrl && Date.now() - lastAuthorityFailAt > 60_000) {
      try {
        const rToken = await fetchTokenFromRails(authProviderUrl, authProviderToken);
        activeToken = rToken;
        activeTokenAt = Date.now();
        log.info("DhanHQ access token acquired from algo_scalper_api");
        if (await redisAvailable()) {
          await redisPublisher.set("dhan:auth:access_token", rToken, "EX", 82800).catch(() => {});
        }
        return rToken;
      } catch (e: any) {
        lastAuthorityFailAt = Date.now();
        log.debug({ err: { message: e.message } }, "algo_scalper_api authority endpoint not responding (backing off 60s)");
      }
    }

    // 4. Standalone fallback: Generate via TOTP if credentials provided
    if (pin && totpSecret) {
      try {
        const tToken = await generateTokenViaTotp(clientId, pin, totpSecret);
        activeToken = tToken;
        activeTokenAt = Date.now();
        log.info("DhanHQ token generated via standalone TOTP");
        return tToken;
      } catch (e: any) {
        log.warn({ err: { message: e.message }, tier: "totp" }, "TOTP fallback generation failed");
      }
    }

    if (activeToken) return activeToken;
    throw new Error("[Auth] No active token found from algo_scalper_api, Redis, or TOTP credentials.");
  };

  const initialToken = await resolveToken().catch(() => "");
  const client = new DhanClient({
    clientId,
    token: initialToken || undefined,
    tokenProvider: resolveToken,
    // SDK default is 5s for every REST call. Too short for heavier endpoints
    // (e.g. expiredOptionsData/rollingoption over a full trading day) — those
    // were failing on a plain timeout and getting misread as "no data".
    timeoutMs: 20000,
  });

  await setupTokenRotationSubscriber();
  return client;
}

async function setupTokenRotationSubscriber() {
  if (!(await redisAvailable())) return;
  redisSubscriber.subscribe("dhan:auth:rotated", (err) => {
    if (err) log.error({ err: { message: err.message }, channel: "dhan:auth:rotated" }, "Failed to subscribe to dhan:auth:rotated");
    else log.info({ channel: "dhan:auth:rotated" }, "Subscribed to dhan:auth:rotated from algo_scalper_api");
  });

  redisSubscriber.on("message", (channel, rawMessage) => {
    if (channel === "dhan:auth:rotated") {
      try {
        if (rawMessage) {
          const payload = JSON.parse(rawMessage);
          if (payload?.token) {
            activeToken = payload.token;
            activeTokenAt = Date.now();
            log.info({ source: "algo_scalper_api" }, "Live DhanHQ access token refreshed from dhan:auth:rotated broadcast");
            return;
          }
        }
      } catch { /* ignore malformed broadcast */ }
      activeToken = null;
      activeTokenAt = 0;
      log.info("Token rotation broadcast received — local cache invalidated for fresh fetch");
    }
  });
}
