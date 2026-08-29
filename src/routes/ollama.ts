import { Router } from 'express';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

/**
 * Ollama LLM routes.
 *
 * When Ollama is unreachable the routes return an explicit
 * { status: 'unreachable' } error — the previous version fabricated a
 * fake "Quant Engine" analysis paragraph, which was indistinguishable
 * from real model output. Real errors, never fake analysis.
 */

const ollama = new OllamaClient({
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  timeoutMs: 60000,
  retries: 1,
});

const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

const SYSTEM_PROMPT = `You are Axis Nexus, an AI trading assistant for Indian F&O markets.
You analyze options strategies, risk metrics, and market conditions.
Be concise, data-driven, and always mention risk. Never guarantee profits.
Format responses with clear structure. Use INR for monetary values.`;

export function ollamaRoutes(): Router {
  const router = Router();

  router.post('/chat', async (req, res) => {
    const { messages, model } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    try {
      const userAndAssistantMsgs = messages.filter((m: any) => m.role !== 'system');
      const customSysMsg = messages.find((m: any) => m.role === 'system')?.content || SYSTEM_PROMPT;
      const finalMessages = [{ role: 'system', content: customSysMsg }, ...userAndAssistantMsgs];

      const response = await ollama.chatText({
        model: model || MODEL,
        messages: finalMessages,
        options: { temperature: 0.3 },
      });

      res.json({ response, model: model || MODEL });
    } catch (e: any) {
      // Honest failure — no fabricated analysis text.
      res.status(503).json({
        error: `Ollama unreachable: ${e.message}`,
        hint: 'Start Ollama locally (ollama serve) or set OLLAMA_BASE_URL. The trading system runs normally without it; agent runs fall back to deterministic mode.',
        model: model || MODEL,
      });
    }
  });

  router.get('/models', async (_req, res) => {
    try {
      const response = await fetch(`${process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(503).json({ error: `Ollama unreachable: ${e.message}`, models: [] });
    }
  });

  router.get('/health', async (_req, res) => {
    try {
      const version = await ollama.version();
      res.json({ status: 'ok', ...version });
    } catch (e: any) {
      res.json({ status: 'unreachable', error: e.message });
    }
  });

  return router;
}
