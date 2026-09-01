export interface IndexData {
  ltp: number;
  change: number;
  pct: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  spot?: number;
}

export interface OptionLeg {
  instrument: string;
  side: 'BUY' | 'SELL';
  qty: number;
  bAvg: number;
  sAvg: number;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface Strategy {
  id: string;
  name: string;
  symbol: string;
  type: string;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  pnl: number;
  lots: number;
  entryTime: string;
  legs: OptionLeg[];
}

export interface Fill {
  time: string;
  instrument: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  corr: string;
  strategy: string;
  status: string;
}

export interface Order {
  id: string;
  corr: string;
  time: string;
  instrument: string;
  type: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  filled: number;
  avg: number;
  leg: string;
  status: string;
  jid: string;
  latency: string;
}

export interface CircuitBreaker {
  rule: string;
  threshold: string;
  current: string;
  state: 'OK' | 'WARN' | 'ERROR';
  action: string;
}

export interface Alert {
  id: number;
  time: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
  read: boolean;
}

export interface SidekiqWorker {
  jid: string;
  w: string;
  q: string;
  started: string;
  args: string;
  el: string;
}

export interface SidekiqRetry {
  jid: string;
  w: string;
  q: string;
  err: string;
  ret: number;
  next: string;
}

export interface MultiMarginRow {
  seg: string;
  tx: string;
  sec: string;
  qty: number;
  prod: string;
  px: string;
}

export interface AgentPersona {
  name: string;
  color: string;
}

export interface AgentStatus {
  status: 'idle' | 'active';
  steps: number;
}

export interface TelemetryEvent {
  id: string;
  agent: string;
  type: string;
  time: string;
  summary?: string;
  tool?: string;
  response?: string;
  duration?: number;
}

export interface ToolCatalogItem {
  name: string;
  desc: string;
  type: string;
  params: string[];
}

export interface LongTermMemory {
  date: string;
  note: string;
  sim: number;
}

export interface LogEntry {
  id: number;
  time: string;
  level: string;
  message: string;
  source: string;
  reqId: string;
}

export interface AppState {
  live: boolean;
  killed: boolean;
  uptimeSeconds: number;
  latency: number;
  indices: Record<string, IndexData>;
  strategies: Strategy[];
  recentFills: Fill[];
  orders: Order[];
  positions: any[];
  funds: Record<string, any>;
  circuitBreakers: CircuitBreaker[];
  alerts: Alert[];
  skWorkers: SidekiqWorker[];
  skRetries: SidekiqRetry[];
  mmRows: MultiMarginRow[];
  agentRunning: boolean;
  agentStepNum: number;
  agentStartTime: number;
  agentTokens: number;
  agentDhanCalls: number;
  eventFilter: string;
  telemetryEvents: TelemetryEvent[];
  agentStatus: Record<string, AgentStatus>;
  ltmMemories: LongTermMemory[];
  logs: LogEntry[];
  logIdCounter: number;
  alertIdCounter: number;
  pnlHistory: number[];
  rateLimitHistory: { orders: number; data: number }[];
  logFilter: string;
  marketSource: string;
  marketWsConnected: boolean;
  marketTickAgeSec: number | null;
  llmMode: string;
  persistence: string;
}

export type ToastType = 'success' | 'error' | 'warning';
