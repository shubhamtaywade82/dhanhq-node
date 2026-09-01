import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { eventBus } from './eventBus';
import { recordErrorPattern, listErrorPatterns, ruleExistsForPattern, promoteRule } from '../db';

/**
 * Self-healing loop: watches WARN/ERROR events on the bus, and when the
 * same message recurs (>= minOccurrences) with no rule yet, asks a local
 * Ollama model to turn it into a one-line imperative rule. Promoted rules
 * are injected into AgentOrchestrator's system prompt via db.getActiveRules().
 */
export class SelfHealingService {
  private ollama: OllamaClient | null;
  private model: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private running = false;

  constructor(private minOccurrences = 2, private cycleMs = 15 * 60_000) {
    this.model = process.env.SELF_HEALING_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
    this.ollama = process.env.OLLAMA_ENABLED !== 'false'
      ? new OllamaClient({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', timeoutMs: 10_000, retries: 0 })
      : null;
  }

  start(): void {
    this.unsub = eventBus.on('log', (env) => {
      const p = env.payload || {};
      if (p.level === 'WARN' || p.level === 'ERROR') {
        void recordErrorPattern(p.level, p.source || 'unknown', String(p.message || '').slice(0, 500));
      }
    });
    this.timer = setInterval(() => void this.runHealingCycle(), this.cycleMs);
    eventBus.log('SYSTEM', `Self-healing loop started (every ${Math.round(this.cycleMs / 60000)}min, min ${this.minOccurrences} occurrences)`, 'self_healing');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.unsub) this.unsub();
  }

  async runHealingCycle(): Promise<{ scanned: number; promoted: number }> {
    if (this.running) return { scanned: 0, promoted: 0 };
    this.running = true;
    try {
      const patterns = await listErrorPatterns(this.minOccurrences);
      let promoted = 0;
      for (const p of patterns) {
        if (await ruleExistsForPattern(p.pattern)) continue;
        const rule = await this.synthesizeRule(p.pattern, p.hit_count);
        if (!rule) continue;
        await promoteRule(rule, p.pattern, p.hit_count);
        eventBus.log('SYSTEM', `Self-healing rule promoted: "${rule}" (${p.hit_count}x: ${p.pattern.slice(0, 80)})`, 'self_healing');
        promoted++;
      }
      return { scanned: patterns.length, promoted };
    } finally {
      this.running = false;
    }
  }

  private async synthesizeRule(pattern: string, hitCount: number): Promise<string> {
    const prompt = `Analyze this recurring failure (occurred ${hitCount} times):\n"${pattern}"\n\nFormulate a concise, single-sentence imperative rule to prevent or work around this. Output ONLY the rule text, no quotes or explanation.`;
    if (this.ollama) {
      try {
        const out = await this.ollama.chatText({ model: this.model, messages: [{ role: 'user', content: prompt }], options: { temperature: 0.2 } });
        const rule = out.trim().split('\n')[0].trim();
        if (rule) return rule;
      } catch { /* fall through to heuristic */ }
    }
    return `Handle recurring failure "${pattern.slice(0, 100)}" gracefully — investigate root cause before retrying.`;
  }
}
