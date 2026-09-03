import { log } from './logger';

const defaultHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const API_BASE = import.meta.env.VITE_API_URL || `http://${defaultHost}:3003`;

/**
 * Central API client.
 *
 * Every request carries an `x-request-id` (UUID) — the backend echoes
 * it in logs AND on the response, so a failed order can be traced from
 * the UI click through every backend log line. Failed requests are
 * reported to the client-log ingest with endpoint, status, duration
 * and the correlation id.
 */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
        ...(options?.headers ?? {}),
      },
    });
  } catch (e) {
    // Network-level failure (backend down / DNS / CORS) — no response exists.
    log.error('API unreachable', {
      endpoint: path,
      method: options?.method ?? 'GET',
      durationMs: Math.round(performance.now() - started),
      kind: 'network-error',
    }, requestId);
    throw e instanceof Error ? e : new Error(`Network error calling ${path}`);
  }

  const durationMs = Math.round(performance.now() - started);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    log.error('API request failed', {
      endpoint: path,
      method: options?.method ?? 'GET',
      status: res.status,
      statusText: res.statusText,
      durationMs,
      serverError: body?.error,
    }, requestId);
    throw new Error(body.error || `API ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  health: () => request<{ status: string; mode: string; persistence: string; killed: boolean; autonomy: boolean; marketSource: string; uptime: number }>('/api/health'),

  indices: () => request<{ indices: Record<string, { ltp: number; change: number; pct: number; high: number; low: number; open: number; prevClose: number; updatedAt?: number } | null>; stale: boolean; source: string; error: string | null }>('/api/market/indices'),

  optionChain: (symbol: string, expiry?: string) => request<{ strikes: Array<{ strike: number; ce: any; pe: any }>; underlying: string; expiry: string }>(`/api/market/option-chain/${symbol}${expiry ? `?expiry=${expiry}` : ''}`),

  expiries: (symbol: string) => request<{ expiries: string[]; underlying: string }>(`/api/market/expiries/${symbol}`),

  greeks: (symbol: string) => request<{ symbol: string; spot: number; expiry: string; strikes: Array<{ strike: number; ce: any; pe: any }> }>(`/api/market/greeks?symbol=${symbol}`),

  optionsAnalysis: (params?: { symbol?: string; days?: number; interval?: string; expiryFlag?: string }) => {
    const q = new URLSearchParams();
    if (params?.symbol) q.set('symbol', params.symbol);
    if (params?.days) q.set('days', String(params.days));
    if (params?.interval) q.set('interval', params.interval);
    if (params?.expiryFlag) q.set('expiryFlag', params.expiryFlag);
    return request<any>(`/api/market/options-analysis?${q.toString()}`);
  },

  quote: (securityId: string, exchange = 'NSE_FNO') => request<any>(`/api/market/quote/${securityId}?exchange=${exchange}`),

  portfolioSummary: () => request<any>('/api/portfolio/summary'),
  positions: () => request<any[]>('/api/portfolio/positions'),
  orders: () => request<any[]>('/api/portfolio/orders'),
  trades: () => request<any[]>('/api/portfolio/trades'),
  funds: () => request<any>('/api/portfolio/funds'),
  holdings: () => request<any[]>('/api/portfolio/holdings'),
  profile: () => request<any>('/api/portfolio/profile'),

  strategies: () => request<any[]>('/api/portfolio/strategies'),
  deployStrategy: (strat: any) => request<any>('/api/portfolio/paper/strategy/deploy', { method: 'POST', body: JSON.stringify(strat) }),
  updateStrategyStatus: (id: string, status: string) => request<any>('/api/portfolio/paper/strategy/status', { method: 'POST', body: JSON.stringify({ id, status }) }),
  executeStrategy: (id: string) => request<any>('/api/portfolio/paper/strategy/execute', { method: 'POST', body: JSON.stringify({ id }) }),
  closeStrategy: (id: string) => request<any>('/api/portfolio/paper/strategy/close', { method: 'POST', body: JSON.stringify({ id }) }),
  calculateMargin: (items: any[]) => request<any>('/api/portfolio/margin/calculate', { method: 'POST', body: JSON.stringify({ items }) }),

  placePaperOrder: (order: { symbol: string; quantity: number; transactionType: 'BUY' | 'SELL'; price?: number; orderType?: string; productType?: string; securityId?: string }) =>
    request<any>('/api/portfolio/paper/order', {
      method: 'POST',
      body: JSON.stringify(order),
    }),

  closePaperPosition: (symbol: string, ltp?: number) =>
    request<any>('/api/portfolio/paper/positions/close', {
      method: 'POST',
      body: JSON.stringify({ symbol, ltp }),
    }),

  resetPaperWallet: (initialBalance = 100000) =>
    request<any>('/api/portfolio/paper/wallet/reset', {
      method: 'POST',
      body: JSON.stringify({ initialBalance }),
    }),

  // ── control plane ─────────────────────────────────────────────────
  controlState: () => request<any>('/api/control/state'),

  armKillSwitch: (reason?: string) =>
    request<any>('/api/control/kill', { method: 'POST', body: JSON.stringify({ confirm: 'CONFIRM', reason }) }),

  disarmKillSwitch: () =>
    request<any>('/api/control/kill/reset', { method: 'POST', body: JSON.stringify({}) }),

  setAutonomy: (enabled: boolean) =>
    request<any>('/api/control/autonomy', { method: 'POST', body: JSON.stringify({ enabled }) }),

  squareOffAll: () =>
    request<any>('/api/control/square-off', { method: 'POST', body: JSON.stringify({ reason: 'Manual square-off from control plane' }) }),

  longOptionPolicy: () =>
    request<{ enabled: boolean; positions: Array<{ tradingSymbol: string; remainingQuantity: number; peakNet: number; floorNet: number; captureRatioSoFar: number | null; partialTaken: boolean }> }>('/api/control/long-option-policy'),

  setLongOptionPolicy: (enabled: boolean) =>
    request<any>('/api/control/long-option-policy', { method: 'POST', body: JSON.stringify({ enabled }) }),

  getRiskLimits: () => request<any>('/api/control/risk-limits'),

  setRiskLimits: (patch: any) =>
    request<any>('/api/control/risk-limits', { method: 'POST', body: JSON.stringify(patch) }),

  // ── agent ─────────────────────────────────────────────────────────
  runAgent: (objective: string) =>
    request<{ runId: string; status: string }>('/api/control/agent/run', { method: 'POST', body: JSON.stringify({ objective }) }),

  agentStatus: () => request<any>('/api/control/agent/status'),

  agentEvents: (limit = 100) => request<any[]>(`/api/control/agent/events?limit=${limit}`),

  agentTools: () => request<any[]>('/api/control/agent/tools'),

  alerts: (limit = 100) => request<any[]>(`/api/control/alerts?limit=${limit}`),

  infraStats: () => request<any>('/api/infra/stats'),

  ollamaChat: (messages: Array<{ role: string; content: string }>, model?: string) =>
    request<{ response: string; model: string }>('/api/ollama/chat', {
      method: 'POST',
      body: JSON.stringify({ messages, model }),
    }),

  backtestStrategy: (params: { symbol?: string; type?: string; days?: number; entryType?: string; targetPct?: number; slPct?: number; timeExit?: string; lots?: number; side?: string }) =>
    request<any>('/api/control/strategy/backtest', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  ollamaHealth: () => request<{ status: string }>('/api/ollama/health'),
  ollamaModels: () => request<any>('/api/ollama/models'),
};
