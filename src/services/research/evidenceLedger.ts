import type { EvidenceItem } from './types';

/**
 * Immutable ledger of empirical facts collected during equity research.
 * Enforces evidence provenance to eliminate LLM hallucinations.
 */
export class EvidenceLedger {
  private items: EvidenceItem[] = [];
  private counter = 0;

  constructor(initialItems: EvidenceItem[] = []) {
    this.items = [...initialItems];
    this.counter = this.items.length;
  }

  /**
   * Records a verified claim with explicit source attribution and confidence.
   * Auto-assigns sequential EV-ids for audit trails.
   */
  record(params: Omit<EvidenceItem, 'id' | 'timestamp'>): EvidenceItem {
    this.counter++;
    const id = `EV-${String(this.counter).padStart(4, '0')}`;
    const item: EvidenceItem = {
      ...params,
      id,
      timestamp: Date.now(),
      confidence: Math.max(0, Math.min(1, params.confidence)),
    };
    this.items.push(item);
    return item;
  }

  list(): EvidenceItem[] {
    return [...this.items];
  }

  getByCategory(category: EvidenceItem['category']): EvidenceItem[] {
    return this.items.filter((item) => item.category === category);
  }

  findByMetric(metric: string): EvidenceItem | undefined {
    return this.items.find((item) => item.metric?.toLowerCase() === metric.toLowerCase());
  }

  count(): number {
    return this.items.length;
  }

  averageConfidence(): number {
    if (this.items.length === 0) return 0;
    const sum = this.items.reduce((acc, curr) => acc + curr.confidence, 0);
    return Number((sum / this.items.length).toFixed(2));
  }
}
