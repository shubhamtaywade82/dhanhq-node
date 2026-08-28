const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3003';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

export const api = {
  health: () => request<{ status: string; mode: string; uptime: number }>('/api/health'),

  indices: () => request<Record<string, { ltp: number; change: number; pct: number; high: number; low: number; open: number; prevClose: number }>>('/api/market/indices'),

  optionChain: (symbol: string) => request<{ strikes: Array<{ strike: number; ce: any; pe: any }>; underlying: string }>(`/api/market/option-chain/${symbol}`),

  optionsAnalysis: (params?: { symbol?: string; days?: number; interval?: string; expiryFlag?: string }) => {
    const q = new URLSearchParams();
    if (params?.symbol) q.set('symbol', params.symbol);
    if (params?.days) q.set('days', String(params.days));
    if (params?.interval) q.set('interval', params.interval);
    if (params?.expiryFlag) q.set('expiryFlag', params.expiryFlag);
    return request<any>(`/api/market/options-analysis?${q.toString()}`);
  },

  quote: (securityId: string, exchange = 'NSE_FNO') => request<any>(`/api/market/quote/${securityId}?exchange=${exchange}`),

  positions: () => request<any[]>('/api/portfolio/positions'),
  orders: () => request<any[]>('/api/portfolio/orders'),
  trades: () => request<any[]>('/api/portfolio/trades'),
  funds: () => request<any>('/api/portfolio/funds'),
  holdings: () => request<any[]>('/api/portfolio/holdings'),
  profile: () => request<any>('/api/portfolio/profile'),

  strategies: () => request<any[]>('/api/portfolio/strategies'),
  deployStrategy: (strat: any) => request<any>('/api/portfolio/paper/strategy/deploy', { method: 'POST', body: JSON.stringify(strat) }),
  updateStrategyStatus: (id: string, status: string) => request<any>('/api/portfolio/paper/strategy/status', { method: 'POST', body: JSON.stringify({ id, status }) }),
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

  resetPaperWallet: (initialBalance = 1000000) =>
    request<any>('/api/portfolio/paper/wallet/reset', {
      method: 'POST',
      body: JSON.stringify({ initialBalance }),
    }),

  ollamaChat: (messages: Array<{ role: string; content: string }>, model?: string) =>
    request<{ response: string; model: string }>('/api/ollama/chat', {
      method: 'POST',
      body: JSON.stringify({ messages, model }),
    }),

  ollamaHealth: () => request<{ status: string }>('/api/ollama/health'),
  ollamaModels: () => request<any>('/api/ollama/models'),
};
