import { shouldEmitAlert, shouldEmitBusLog, shouldEmitKeyedLog } from '../lib/logPolicy';

describe('logPolicy', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env, LOG_VERBOSE: undefined };
  });

  afterAll(() => {
    process.env = env;
  });

  describe('shouldEmitBusLog', () => {
    it('allows the first emit and blocks an identical repeat inside the window', () => {
      expect(shouldEmitBusLog('INFO', 'autonomy', 'cycle tick')).toBe(true);
      expect(shouldEmitBusLog('INFO', 'autonomy', 'cycle tick')).toBe(false);
    });

    it('treats different messages independently', () => {
      expect(shouldEmitBusLog('WARN', 'market_data', 'WS closed')).toBe(true);
      expect(shouldEmitBusLog('WARN', 'market_data', 'poll failed')).toBe(true);
    });

    it('bypasses dedupe when LOG_VERBOSE is true', () => {
      process.env.LOG_VERBOSE = 'true';
      expect(shouldEmitBusLog('INFO', 'test', 'same')).toBe(true);
      expect(shouldEmitBusLog('INFO', 'test', 'same')).toBe(true);
    });
  });

  describe('shouldEmitKeyedLog', () => {
    it('dedupes by arbitrary key', () => {
      expect(shouldEmitKeyedLog('reconcile:untrack:NSE_FNO:123', 1000)).toBe(true);
      expect(shouldEmitKeyedLog('reconcile:untrack:NSE_FNO:123', 1000)).toBe(false);
      expect(shouldEmitKeyedLog('reconcile:untrack:NSE_FNO:456', 1000)).toBe(true);
    });
  });

  describe('shouldEmitAlert', () => {
    it('treats alerts with different current readings as the same transition', () => {
      const a = 'Margin Utilization: OK → WARN (current 51.3%, threshold 70%). Action: Block';
      const b = 'Margin Utilization: OK → WARN (current 52.1%, threshold 70%). Action: Block';
      expect(shouldEmitAlert('WARN', 'risk_engine', a)).toBe(true);
      expect(shouldEmitAlert('WARN', 'risk_engine', b)).toBe(false);
    });
  });
});
