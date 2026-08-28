import { Router } from 'express';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const ollama = new OllamaClient({
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  timeoutMs: 30000,
  retries: 1,
});

const MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b';

const SYSTEM_PROMPT = `You are Axis Nexus, an AI trading assistant for Indian F&O markets.
You analyze options strategies, risk metrics, and market conditions.
Be concise, data-driven, and always mention risk. Never guarantee profits.
Format responses with clear structure. Use INR for monetary values.`;

export function ollamaRoutes(): Router {
  const router = Router();

  router.post('/chat', async (req, res) => {
    try {
      const { messages, model } = req.body;

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ error: 'messages array required' });
        return;
      }

      const response = await ollama.chatText({
        model: model || MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages,
        ],
        options: { temperature: 0.3 },
      });

      res.json({ response, model: model || MODEL });
    } catch (e: any) {
      console.error('[Ollama] Chat error:', e.message);
      res.status(500).json({ error: e.message });
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
