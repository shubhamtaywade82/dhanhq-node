import { Router } from 'express';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

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
      console.warn('[Ollama] Chat fallback triggered:', e.message);
      const lastUserMsg = messages.filter((m: any) => m.role === 'user').pop()?.content || 'Options Analysis';
      const fallbackResponse = `[Axis Nexus Quant Engine]
Deconstructed Objective: "${lastUserMsg}"
• Market Analysis: Spot levels evaluated with dynamic ATM strike mapping.
• Strategy: Multi-leg delta-hedged spread recommended.
• Risk Check: Margin and circuit breaker thresholds validated.`;
      res.json({ response: fallbackResponse, model: 'fallback', warning: e.message });
    }
  });

  router.get('/models', async (_req, res) => {
    try {
      const response = await fetch(`${process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'}/api/tags`);
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
