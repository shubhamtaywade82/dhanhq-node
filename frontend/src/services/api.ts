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

  quote: (securityId: string, exchange = 'NSE_FNO') => request<any>(`/api/market/quote/${securityId}?exchange=${exchange}`),

  positions: () => request<any[]>('/api/portfolio/positions'),
  orders: () => request<any[]>('/api/portfolio/orders'),
  trades: () => request<any[]>('/api/portfolio/trades'),
  funds: () => request<any>('/api/portfolio/funds'),
  holdings: () => request<any[]>('/api/portfolio/holdings'),
  profile: () => request<any>('/api/portfolio/profile'),

  ollamaChat: (messages: Array<{ role: string; content: string }>, model?: string) =>
    request<{ response: string; model: string }>('/api/ollama/chat', {
      method: 'POST',
      body: JSON.stringify({ messages, model }),
    }),

  ollamaHealth: () => request<{ status: string }>('/api/ollama/health'),
  ollamaModels: () => request<any>('/api/ollama/models'),
};
