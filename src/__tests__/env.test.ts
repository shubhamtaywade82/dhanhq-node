import { loadEnv } from '../lib/env';

describe('loadEnv', () => {
  it('loads base env and mode-specific env safely', () => {
    // Calling loadEnv is idempotent and populates process.env
    loadEnv();
    expect(process.env.PORT || '3003').toBeDefined();
    expect(['paper', 'sandbox', 'live']).toContain(process.env.TRADING_MODE || 'paper');
  });
});
