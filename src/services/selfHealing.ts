import { OllamaClient, type Logger as OllamaLogger } from '@nemesis-oss/ollama-sdk';
import { eventBus } from './eventBus';
import { moduleLogger } from '../lib/logger';
import { recordErrorPattern, listErrorPatterns, ruleExistsForPattern, promoteRule } from '../db';
import { readOllamaCloudKeys } from './agent';

const selfHealingOllamaLog = moduleLogger('self_healing_ollama');
/** Same SDK Logger adapter as agent.ts's — see that file for why: without
 * it the SDK's own per-credential attempt/failure lines are silently
 * dropped (defaults to a no-op logger). */
const selfHealingOllamaSdkLogger: OllamaLogger = {
  debug: (msg, ctx) => selfHealingOllamaLog.debug(ctx || {}, msg),
  info: (msg, ctx) => selfHealingOllamaLog.info(ctx || {}, msg),
  warn: (msg, ctx) => selfHealingOllamaLog.warn(ctx || {}, msg),
  error: (msg, ctx) => selfHealingOllamaLog.error(ctx || {}, msg),
};

/**
 * Self-healing loop: watches WARN/ERROR events on the bus, and when the
 * same message recurs (>= minOccurrences) with no rule yet, asks an Ollama
 * model to turn it into a one-line imperative rule. Promoted rules are
 * injected into AgentOrchestrator's system prompt via db.getActiveRules().
 *
 * Previously always dialed a LOCAL Ollama daemon regardless of whether
 * agent.ts's own client had moved to Ollama Cloud — with no local daemon
 * running, every synthesizeRule() call failed silently and fell through to
 * the hardcoded fallback string below, every time. Uses the same
 * OLLAMA_API_KEY_N / OLLAMA_CLOUD_MODEL config as agent.ts now, so the two
 * clients agree on where the LLM actually lives.
 */
export class SelfHealingService {
  private ollama: OllamaClient | null;
  private model: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private running = false;

  constructor(private minOccurrences = 2, private cycleMs = 15 * 60_000) {
    const cloudKeys = readOllamaCloudKeys();
    const cloudModel = process.env.OLLAMA_CLOUD_MODEL || 'gemma4:31b';
    this.model = process.env.SELF_HEALING_MODEL || (cloudKeys.length > 0 ? cloudModel : (process.env.OLLAMA_MODEL || 'qwen2.5:0.5b'));
    this.ollama = process.env.OLLAMA_ENABLED === 'false'
      ? null
      : cloudKeys.length > 0
        ? new OllamaClient({
            baseUrl: process.env.OLLAMA_CLOUD_BASE_URL || 'https://ollama.com',
            credentials: Object.fromEntries(cloudKeys.map((apiKey, i) => [`cloud-${i + 1}`, { apiKey }])),
            modelBindings: { [this.model]: cloudKeys.map((_, i) => `cloud-${i + 1}`) },
            logger: selfHealingOllamaSdkLogger,
            timeoutMs: 10_000,
            retries: 0,
          })
        : new OllamaClient({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', timeoutMs: 10_000, retries: 0 });
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
