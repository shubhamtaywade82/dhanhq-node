import { classifyDispatchRegime, classifyObjectiveIntent, matchIndexSymbol } from '../services/agent';

// Regression coverage: synthesizeStrategy's regime dispatcher used to
// compare analytics.regime against 'THETA_DECAY', 'RANGE_BOUND' and
// 'GAMMA_BLAST' — none of which classifyRegime() (optionsAnalytics.ts)
// ever actually produces (its real values are HIGH_IV_RANGE | LOW_IV_TREND
// | EXPIRY_GAMMA | NEUTRAL). Those three comparisons could never be true;
// only the vix<13.5 / vix>=15.5 fallbacks ever drove dispatch. Mapped here
// to the real values by matching strategy intent (see classifyDispatchRegime's
// own docstring for the reasoning), as an additional, independent trigger
// alongside the vix fallbacks — not a replacement for them.
describe('classifyDispatchRegime', () => {
  it('selects RANGE_BOUND_THETA when the analytics regime is HIGH_IV_RANGE, regardless of vix', () => {
    expect(classifyDispatchRegime('HIGH_IV_RANGE', 20)).toBe('RANGE_BOUND_THETA');
  });

  it('selects RANGE_BOUND_THETA via the vix<13.5 fallback with no regime match', () => {
    expect(classifyDispatchRegime('NEUTRAL', 12)).toBe('RANGE_BOUND_THETA');
  });

  it('selects BREAKOUT_MOMENTUM via LOW_IV_TREND alone, at a vix that satisfies neither fallback threshold', () => {
    // vix=14 sits in the gap between the two vix fallbacks (13.5 and 15.5)
    // — only the regime string can be driving this, not either heuristic.
    expect(classifyDispatchRegime('LOW_IV_TREND', 14)).toBe('BREAKOUT_MOMENTUM');
  });

  it('selects BREAKOUT_MOMENTUM via the vix>=15.5 fallback with no regime match', () => {
    expect(classifyDispatchRegime('NEUTRAL', 16)).toBe('BREAKOUT_MOMENTUM');
  });

  it('selects EXPIRY_GAMMA when nothing higher-priority matched first', () => {
    expect(classifyDispatchRegime('EXPIRY_GAMMA', 14)).toBe('EXPIRY_GAMMA');
  });

  it('RANGE_BOUND_THETA still takes priority over EXPIRY_GAMMA when vix is also low — preserves the original branch order', () => {
    expect(classifyDispatchRegime('EXPIRY_GAMMA', 12)).toBe('RANGE_BOUND_THETA');
  });

  it('BREAKOUT_MOMENTUM still takes priority over EXPIRY_GAMMA when vix is also high — preserves the original branch order', () => {
    expect(classifyDispatchRegime('EXPIRY_GAMMA', 16)).toBe('BREAKOUT_MOMENTUM');
  });

  it('falls through to TRENDING_DRIFT when nothing matches', () => {
    expect(classifyDispatchRegime('NEUTRAL', 14)).toBe('TRENDING_DRIFT');
  });

  it('the old dead literals no longer match anything — confirms the original bug is actually gone', () => {
    expect(classifyDispatchRegime('THETA_DECAY', 14)).toBe('TRENDING_DRIFT');
    expect(classifyDispatchRegime('RANGE_BOUND', 14)).toBe('TRENDING_DRIFT');
    expect(classifyDispatchRegime('GAMMA_BLAST', 14)).toBe('TRENDING_DRIFT');
  });
});

describe('classifyObjectiveIntent', () => {
  it('classifies informational and lot size questions as QUERY', () => {
    expect(classifyObjectiveIntent('What is the lot size of options for SENSEX currently')).toBe('QUERY');
    expect(classifyObjectiveIntent('what is the lot size of NIFTY?')).toBe('QUERY');
    expect(classifyObjectiveIntent('What are my open positions?')).toBe('QUERY');
    expect(classifyObjectiveIntent('What is the current margin available?')).toBe('QUERY');
    expect(classifyObjectiveIntent('Show open positions')).toBe('QUERY');
    expect(classifyObjectiveIntent('Is the market open right now?')).toBe('QUERY');
    expect(classifyObjectiveIntent('Explain how Iron Condor works')).toBe('QUERY');
  });

  it('classifies trade execution directives as TRADE', () => {
    expect(classifyObjectiveIntent('Deploy Iron Condor on NIFTY')).toBe('TRADE');
    expect(classifyObjectiveIntent('Buy 1 lot ATM call on BANKNIFTY')).toBe('TRADE');
    expect(classifyObjectiveIntent('Sell OTM put on SENSEX')).toBe('TRADE');
    expect(classifyObjectiveIntent('Execute breakout strategy on NIFTY')).toBe('TRADE');
    expect(classifyObjectiveIntent('Scan watchlist and find highest probability trade')).toBe('TRADE');
  });
});

describe('matchIndexSymbol', () => {
  it('correctly matches compound index symbols and avoids NIFTY substring collision', () => {
    expect(matchIndexSymbol('What is the lot size of options for BANKNIFTY currently')).toBe('BANKNIFTY');
    expect(matchIndexSymbol('What is the lot size of options for BANK NIFTY currently')).toBe('BANKNIFTY');
    expect(matchIndexSymbol('What is the lot size of options for BNF currently')).toBe('BANKNIFTY');
    expect(matchIndexSymbol('What is the lot size of options for FINNIFTY currently')).toBe('FINNIFTY');
    expect(matchIndexSymbol('What is the lot size of options for FIN NIFTY currently')).toBe('FINNIFTY');
    expect(matchIndexSymbol('What is the lot size of options for MIDCPNIFTY currently')).toBe('MIDCPNIFTY');
    expect(matchIndexSymbol('What is the lot size of options for MIDCAP NIFTY currently')).toBe('MIDCPNIFTY');
    expect(matchIndexSymbol('What is the lot size of options for SENSEX currently')).toBe('SENSEX');
    expect(matchIndexSymbol('What is the lot size of options for BSE SENSEX currently')).toBe('SENSEX');
    expect(matchIndexSymbol('What is India VIX right now?')).toBe('INDIAVIX');
    expect(matchIndexSymbol('What is the lot size of options for NIFTY currently')).toBe('NIFTY');
    expect(matchIndexSymbol('What is the lot size of options for NIFTY 50 currently')).toBe('NIFTY');
    expect(matchIndexSymbol('What are my open positions?')).toBeNull();
  });
});

