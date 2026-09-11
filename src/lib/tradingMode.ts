import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';

export type TradingMode = 'paper' | 'sandbox' | 'live';

/** Single source of truth for runtime trading mode. */
export function getTradingMode(): TradingMode {
  const raw = process.env.TRADING_MODE || 'paper';
  if (raw === 'sandbox' || raw === 'live') return raw;
  return 'paper';
}

export function isPaperMode(): boolean {
  return getTradingMode() === 'paper';
}

export function isSandboxMode(): boolean {
  return getTradingMode() === 'sandbox';
}

export function isLiveMode(): boolean {
  return getTradingMode() === 'live';
}

/** Sandbox and live read/write the broker account; paper uses the local ledger. */
export function isBrokerMode(): boolean {
  return isSandboxMode() || isLiveMode();
}

export function brokerJournalMode(): 'sandbox' | 'live' {
  return isSandboxMode() ? 'sandbox' : 'live';
}

/** Account/order API client: sandbox credentials in sandbox mode, production otherwise. */
export function executionBrokerClient(main: DhanClient, sandbox?: DhanClient): DhanClient {
  return isSandboxMode() && sandbox ? sandbox : main;
}

/** Human-readable mode contract logged at boot. */
export function describeModeContract(): string {
  if (isPaperMode()) {
    return 'paper execution + paper ledger; market data from real DhanHQ (REST/WS)';
  }
  if (isSandboxMode()) {
    return 'DhanHQ sandbox execution + sandbox account; market data from real DhanHQ (REST/WS)';
  }
  return 'live DhanHQ execution + live account + order-update WS; market data from real DhanHQ (REST/WS)';
}
