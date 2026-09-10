import { eventBus } from './eventBus';

// Split out of core.ts so RiskEngine can read it without a circular import
// (core.ts already imports RiskEngine to build the Core object).
export type SystemState = 'BOOTING' | 'SYNCING' | 'RECONCILING' | 'READY' | 'DEGRADED';

let currentSystemState: SystemState = 'BOOTING';

export function getSystemState(): SystemState {
  return currentSystemState;
}

export function setSystemState(state: SystemState, reason?: string): void {
  currentSystemState = state;
  eventBus.emit('system', { type: 'state_change', state, reason });
  eventBus.log('SYSTEM', `System state transitioned to ${state}${reason ? ` (${reason})` : ''}`, 'core');
}
