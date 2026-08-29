import { DhanClient, DhanAuth } from "@nemesis-oss/dhanhq-sdk";
import Redis from "ioredis";
import axios from "axios";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";
export const redisSubscriber = new Redis(redisUrl);
export const redisPublisher = new Redis(redisUrl);

// Fetches a fresh token from the Rails token authority (Tier 2).
async function fetchTokenFromRails(baseUrl: string, bearerToken: string): Promise<string> {
  const { data } = await axios.get(`${baseUrl}/api/dhan_access_token`, {
    headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    timeout: 5000,
  });
  const token = data.dhan_access_token || data.dhanaccesstoken;
  if (!token) throw new Error(`[Auth] Rails returned no token. Keys: ${Object.keys(data).join(", ")}`);
  return token;
}

// Generates an access token via Dhan TOTP authentication (Tier 3 fallback).
export async function generateTokenViaTotp(clientId: string, pin: string, totpSecret: string): Promise<string> {
  const totp = DhanAuth.generateTotp(totpSecret);
  const authBaseUrl = process.env.DHAN_AUTH_BASE_URL || process.env.DHANHQ_BASE_URL || "https://auth.dhan.co";
  const axiosInstance = axios.create({ baseURL: authBaseUrl, timeout: 5000 });
  const res = await DhanAuth.generateAccessToken({ clientId, pin, totp }, { axiosInstance });
  const token = res.accessToken;
  if (!token) throw new Error("[Auth] TOTP response did not contain access token");

  await redisPublisher.set("dhan:auth:access_token", token, "EX", 82800).catch(() => {});
  await redisPublisher.set("dhan:auth:client_id", clientId).catch(() => {});
  return token;
}

export async function createDhanClient(): Promise<DhanClient> {
  const clientId = (await redisPublisher.get("dhan:auth:client_id")) || process.env.DHAN_CLIENT_ID || process.env.CLIENT_ID || "";
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
      const token = await redisPublisher.get("dhan:auth:access_token");
      if (token) return token;
      if (pin && totpSecret) return generateTokenViaTotp(clientId, pin, totpSecret);
      throw new Error("[Sidecar] Token missing in Redis and no TOTP credentials configured.");
    },
  });

  setupTokenRotationSubscriber();
  return client;
}

function setupTokenRotationSubscriber() {
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
