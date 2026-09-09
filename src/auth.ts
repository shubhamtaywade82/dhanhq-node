import dotenv from "dotenv";
dotenv.config();
import { DhanClient, DhanAuth } from "@nemesis-oss/dhanhq-sdk";
import Redis from "ioredis";
import { moduleLogger } from "./lib/logger";

/**
 * DhanHQ client factory — TOTP or external authority only (no DHAN_ACCESS_TOKEN).
 * RenewToken is web-dashboard only; TOTP tokens must be re-generated via generateAccessToken.
 */

const IN_MEMORY_TOKEN_TTL_MS = 30_000;
const DHAN_TOTP_URL = "https://auth.dhan.co/app/generateAccessToken";
const DHAN_TOTP_COOLDOWN_MS = 120_000;
const TOTP_FAIL_COOLDOWN_MS = 120_000;
const MIN_DHAN_TOKEN_LEN = 50;

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";
const log = moduleLogger("auth");

function lazyRedis(url: string): Redis {
  const r = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 1000, 10000)),
    enableOfflineQueue: false,
  });
  r.on("error", () => { /* swallow — Redis is optional */ });
  return r;
}

export const redisPublisher: Pick<Redis, "publish" | "set" | "get" | "del" | "ping" | "info" | "ttl" | "keys"> & { status?: string } = lazyRedis(redisUrl);
export const redisSubscriber = lazyRedis(redisUrl);

export const redisAvailable = async (): Promise<boolean> => {
  if ((redisPublisher as any).status === "ready") return true;
  if ((redisPublisher as any).status === "connecting") {
    await Promise.race([
      new Promise((resolve) => (redisPublisher as any).once("ready", resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    return (redisPublisher as any).status === "ready";
  }
  return false;
};

export function isUsableDhanToken(token: string | null | undefined): boolean {
  if (!token || token.length < MIN_DHAN_TOKEN_LEN) return false;
  if (token === "your_access_token") return false;
  return true;
}

export function resolveDhanClientId(envClientId: string, redisClientId: string | null): string {
  return envClientId || redisClientId || "";
}

export function hasTotpCredentials(): boolean {
  const clientId = process.env.DHAN_CLIENT_ID || process.env.CLIENT_ID || "";
  return !!(process.env.DHAN_PIN && process.env.DHAN_TOTP_SECRET && clientId);
}

export function hasExternalAuthProvider(): boolean {
  const url = process.env.DHAN_AUTH_PROVIDER_URL || process.env.DHAN_TOKEN_ENDPOINT;
  const token = process.env.DHAN_AUTH_PROVIDER_TOKEN || process.env.DHAN_TOKEN_ACCESS_TOKEN;
  return !!(url && token);
}

function parseDhanExpiry(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized = hasZone ? trimmed : `${trimmed.replace(" ", "T")}+05:30`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

let activeToken: string | null = null;
let activeTokenAt = 0;
let totpBlockedUntil = 0;
let totpInFlight: Promise<string> | null = null;
let lastTotpFailAt = 0;

async function cacheToken(token: string, expiresAt?: number): Promise<void> {
  activeToken = token;
  activeTokenAt = Date.now();
  if (!(await redisAvailable())) return;
  const ttlSec = expiresAt ? Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)) : 82800;
  await redisPublisher.set("dhan:auth:access_token", token, "EX", ttlSec).catch(() => {});
  if (expiresAt) {
    await redisPublisher.set("dhan:auth:expires_at", String(expiresAt), "EX", ttlSec).catch(() => {});
  }
}

async function readRedisCachedToken(): Promise<{ token: string; expiresAt?: number } | null> {
  if (!(await redisAvailable())) return null;
  const token = await redisPublisher.get("dhan:auth:access_token").catch(() => null);
  if (!isUsableDhanToken(token)) return null;
  const rawExp = await redisPublisher.get("dhan:auth:expires_at").catch(() => null);
  const expiresAt = rawExp ? Number(rawExp) : undefined;
  if (expiresAt && Date.now() >= expiresAt) return null;
  return { token: token!, expiresAt };
}

export async function generateTokenViaTotp(clientId: string, pin: string, totpSecret: string): Promise<string> {
  const now = Date.now();
  if (now < totpBlockedUntil) {
    const waitSec = Math.ceil((totpBlockedUntil - now) / 1000);
    throw new Error(`Dhan TOTP rate-limited — retry in ${waitSec}s`);
  }

  const totp = DhanAuth.generateTotp(totpSecret);
  const qs = new URLSearchParams({ dhanClientId: clientId, pin, totp });
  const res = await fetch(`${DHAN_TOTP_URL}?${qs}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  const data: Record<string, unknown> = await res.json().catch(() => ({}));
  const token = (data.accessToken ?? data.access_token) as string | undefined;

  if (isUsableDhanToken(token)) {
    totpBlockedUntil = 0;
    const expiresAt = parseDhanExpiry(data.expiryTime ?? data.expiry_time);
    await cacheToken(token!, expiresAt);
    return token!;
  }

  const dhanMsg = String(data.message ?? data.Message ?? data.errorMessage ?? "no accessToken in response");
  if (dhanMsg.toLowerCase().includes("2 minute")) {
    totpBlockedUntil = Date.now() + DHAN_TOTP_COOLDOWN_MS;
  }
  throw new Error(`Dhan TOTP failed: ${dhanMsg}`);
}

async function fetchTokenFromRails(baseUrl: string, bearerToken?: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/dhan_access_token`, {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Rails authority HTTP ${res.status}`);
  const data = await res.json();
  const token = data.dhan_access_token || data.dhanaccesstoken;
  if (!token) throw new Error(`[Auth] Rails returned no token. Keys: ${Object.keys(data).join(", ")}`);
  return token;
}

async function invalidateCachedToken(): Promise<void> {
  activeToken = null;
  activeTokenAt = 0;
  if (!(await redisAvailable())) return;
  await redisPublisher.del("dhan:auth:access_token", "dhan:auth:expires_at").catch(() => {});
}

export async function createDhanClient(): Promise<DhanClient> {
  const isRedisReady = await redisAvailable();
  const envClientId = process.env.DHAN_CLIENT_ID || process.env.CLIENT_ID || "";
  const redisClientId = isRedisReady
    ? await redisPublisher.get("dhan:auth:client_id").catch(() => null)
    : null;
  const clientId = resolveDhanClientId(envClientId, redisClientId);
  if (envClientId && redisClientId && envClientId !== redisClientId) {
    log.warn("Redis client_id mismatch — using DHAN_CLIENT_ID from .env");
  }
  const pin = process.env.DHAN_PIN;
  const totpSecret = process.env.DHAN_TOTP_SECRET;
  const totpReady = !!(pin && totpSecret && clientId);
  const authProviderUrl = process.env.DHAN_AUTH_PROVIDER_URL || process.env.DHAN_TOKEN_ENDPOINT || "http://localhost:3000";
  const authProviderToken = process.env.DHAN_AUTH_PROVIDER_TOKEN || process.env.DHAN_TOKEN_ACCESS_TOKEN;

  let lastAuthorityFailAt = 0;

  const resolveToken = async (): Promise<string> => {
    if (activeToken && Date.now() - activeTokenAt < IN_MEMORY_TOKEN_TTL_MS) {
      return activeToken;
    }

    if (totpReady) {
      const cached = await readRedisCachedToken();
      if (cached) {
        activeToken = cached.token;
        activeTokenAt = Date.now();
        log.info(
          { source: "redis", expiresInMin: cached.expiresAt ? Math.round((cached.expiresAt - Date.now()) / 60_000) : undefined },
          "DhanHQ access token reused from cache (no TOTP)",
        );
        return cached.token;
      }
      if (Date.now() - lastTotpFailAt >= TOTP_FAIL_COOLDOWN_MS && Date.now() >= totpBlockedUntil) {
        try {
          if (!totpInFlight) {
            totpInFlight = generateTokenViaTotp(clientId, pin!, totpSecret!).finally(() => {
              totpInFlight = null;
            });
          }
          const tToken = await totpInFlight;
          log.info("DhanHQ token generated via TOTP");
          return tToken;
        } catch (e: any) {
          lastTotpFailAt = Date.now();
          log.warn({ err: { message: e.message }, tier: "totp" }, "TOTP generation failed");
        }
      }
    }

    if (authProviderUrl && Date.now() - lastAuthorityFailAt > 60_000) {
      try {
        const rToken = await fetchTokenFromRails(authProviderUrl, authProviderToken);
        await cacheToken(rToken);
        log.info("DhanHQ access token acquired from algo_scalper_api");
        return rToken;
      } catch (e: any) {
        lastAuthorityFailAt = Date.now();
        log.debug({ err: { message: e.message } }, "algo_scalper_api not responding (backing off 60s)");
      }
    }

    if (await redisAvailable()) {
      const rToken = await redisPublisher.get("dhan:auth:access_token").catch(() => null);
      if (isUsableDhanToken(rToken)) {
        await cacheToken(rToken!);
        return rToken!;
      }
      if (rToken) {
        log.warn({ redisTokenLen: rToken.length }, "Ignoring invalid dhan:auth:access_token in Redis");
        await redisPublisher.del("dhan:auth:access_token", "dhan:auth:expires_at").catch(() => {});
      }
    }

    if (activeToken) return activeToken;
    throw new Error("[Auth] No active token — configure TOTP, Rails authority, or Redis token.");
  };

  const initialToken = await resolveToken().catch(() => "");
  const client = new DhanClient({
    clientId,
    token: initialToken || undefined,
    tokenProvider: resolveToken,
    onTokenExpired: () => invalidateCachedToken(),
    timeoutMs: 20000,
  });

  await setupTokenRotationSubscriber();
  return client;
}

export function createSandboxDhanClient(): DhanClient | undefined {
  const clientId = process.env.DHAN_SANDBOX_CLIENT_ID;
  const token = process.env.DHAN_SANDBOX_ACCESS_TOKEN;
  if (!clientId || !token) return undefined;

  return new DhanClient({
    clientId,
    token,
    baseURL: process.env.DHAN_SANDBOX_BASE_URL || "https://sandbox.dhan.co/v2",
    timeoutMs: 20000,
  });
}

async function setupTokenRotationSubscriber() {
  if (!(await redisAvailable())) return;
  redisSubscriber.subscribe("dhan:auth:rotated", (err) => {
    if (err) log.error({ err: { message: err.message } }, "Failed to subscribe dhan:auth:rotated");
    else log.info("Subscribed to dhan:auth:rotated");
  });
  redisSubscriber.on("message", (channel, rawMessage) => {
    if (channel !== "dhan:auth:rotated") return;
    try {
      const payload = rawMessage ? JSON.parse(rawMessage) : null;
      if (payload?.token) {
        activeToken = payload.token;
        activeTokenAt = Date.now();
        log.info({ source: "algo_scalper_api" }, "Token refreshed from dhan:auth:rotated");
        return;
      }
    } catch { /* malformed */ }
    activeToken = null;
    activeTokenAt = 0;
    log.info("Token rotation broadcast — cache invalidated");
  });
}
