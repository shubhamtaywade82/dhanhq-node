import { EvidenceLedger } from '../services/research/evidenceLedger';

describe('EvidenceLedger', () => {
  it('should auto-assign sequential EV-xxxx IDs and timestamps', () => {
    const ledger = new EvidenceLedger();
    const item1 = ledger.record({
      category: 'financial',
      claim: 'Revenue grew 18% YoY',
      metric: 'revenue_growth',
      value: 18,
      source: 'annual_report',
      confidence: 0.95,
    });

    const item2 = ledger.record({
      category: 'moat',
      claim: 'Strong pricing power',
      source: 'channel_checks',
      confidence: 0.85,
    });

    expect(item1.id).toBe('EV-0001');
    expect(item2.id).toBe('EV-0002');
    expect(item1.timestamp).toBeGreaterThan(0);
    expect(ledger.count()).toBe(2);
  });

  it('should filter items by category', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ category: 'financial', claim: 'PAT rose 20%', source: 'report', confidence: 1.0 });
    ledger.record({ category: 'business', claim: 'Expanding retail stores', source: 'filing', confidence: 0.9 });
    ledger.record({ category: 'financial', claim: 'FCF conversion 80%', source: 'calc', confidence: 0.95 });

    const finItems = ledger.getByCategory('financial');
    expect(finItems.length).toBe(2);
    expect(ledger.getByCategory('business').length).toBe(1);
    expect(ledger.getByCategory('risk').length).toBe(0);
  });

  it('should find items by metric case-insensitively', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ category: 'financial', claim: 'CFO/PAT is 1.2x', metric: 'cfo_to_pat_ratio', value: 1.2, source: 'report', confidence: 0.95 });

    const found = ledger.findByMetric('CFO_TO_PAT_RATIO');
    expect(found).toBeDefined();
    expect(found?.value).toBe(1.2);
  });

  it('should compute average confidence correctly and clamp between 0 and 1', () => {
    const ledger = new EvidenceLedger();
    expect(ledger.averageConfidence()).toBe(0);

    ledger.record({ category: 'risk', claim: 'Regulatory risk', source: 'news', confidence: 1.5 }); // clamped to 1.0
    ledger.record({ category: 'growth', claim: 'TAM growth', source: 'study', confidence: 0.6 });

    expect(ledger.averageConfidence()).toBe(0.8);
  });
});
