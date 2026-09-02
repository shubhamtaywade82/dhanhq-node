import { eventBus } from './eventBus';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('telegram');

/**
 * Telegram alerting — a dependency-free port of algo_scalper_api's
 * Notifications::Telegram::Client (plain HTTPS POST to the Bot API, same
 * TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID env vars, same chunking/plain-text
 * fallback behavior) wired onto this app's eventBus instead of Rails
 * service call sites.
 *
 * Forwards `log` channel events at WARN/ERROR/SYSTEM level, plus TRADE
 * events from `autonomy` specifically (auto-exit on SL/target/trailing, and
 * the EOD square-off summary) — standalone "what just happened" alerts.
 * Deliberately not a full feed of every fill — a multi-leg strategy deploy
 * would otherwise ping once per leg.
 *
 * WARN/SYSTEM are repeat-throttled (see throttleRepeat): the same root
 * cause recurring every scanner cycle sends once, then a count-annotated
 * reminder at most every 30 minutes, not once per occurrence. ERROR and
 * TRADE always send immediately — never throttle a kill switch or an
 * actual fill/exit.
 */

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4000; // margin below Telegram's 4096 cap

export function isTelegramEnabled(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** Splits on line boundaries so a chunk break never lands mid-line; a single
 * line longer than the limit is hard-split into consecutive full chunks. */
export function splitIntoChunks(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > maxLen) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
      continue;
    }
    const withNewline = current ? `${current}\n${line}` : line;
    if (withNewline.length > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = withNewline;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** WARN/ERROR/SYSTEM forward (subject to the repeat throttle below); TRADE
 * only forwards from `autonomy` — Auto-exit (SL/target/trailing hit) and
 * Square-off complete are standalone "here's what happened" events a trader
 * wants pushed. Per-leg fills (paper_engine/live_engine/portfolio deploy)
 * stay excluded — a 4-leg strategy would otherwise ping 4 times per entry. */
export function shouldForwardLog(level: string, source: string, _message: string): boolean {
  if (level === 'WARN' || level === 'ERROR' || level === 'SYSTEM') return true;
  return level === 'TRADE' && source === 'autonomy';
}

// ── Repeat throttle ──────────────────────────────────────────────────────
// The autonomous scanner can hit the exact same failure (e.g. a sizing bug
// rejecting every attempt) every cycle for 30+ minutes straight. A trader
// wants to know once, not 35 times. WARN/SYSTEM dedupe by a normalized key
// (strategy ids and rupee amounts stripped, so the same root cause matches
// regardless of which specific attempt or number); ERROR and TRADE always
// send immediately — never throttle a kill-switch or an actual fill/exit.
const REMINDER_INTERVAL_MS = 30 * 60 * 1000;
const recentAlertKeys = new Map<string, { count: number; firstAt: number; lastSentAt: number }>();

function normalizeForDedup(source: string, message: string): string {
  return `${source}:${message
    .replace(/strat_[a-z0-9_]+/gi, '<id>')
    .replace(/₹[\d,]+(\.\d+)?/g, '<amt>')
    .replace(/\d+(\.\d+)?/g, '<n>')}`;
}

/** Returns the message to actually send (possibly annotated with a repeat
 * count), or null if this occurrence should be suppressed. */
export function throttleRepeat(level: string, source: string, message: string, now = Date.now()): string | null {
  if (level !== 'WARN' && level !== 'SYSTEM') return message;
  const key = normalizeForDedup(source, message);
  const entry = recentAlertKeys.get(key);
  if (!entry) {
    recentAlertKeys.set(key, { count: 1, firstAt: now, lastSentAt: now });
    return message;
  }
  entry.count++;
  if (now - entry.lastSentAt >= REMINDER_INTERVAL_MS) {
    const suppressed = entry.count - 1;
    entry.lastSentAt = now;
    entry.count = 1;
    entry.firstAt = now;
    return `${message}\n\n(recurring — ${suppressed} more occurrence(s) suppressed since last notice)`;
  }
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LEVEL_STYLE: Record<string, { emoji: string; label: string }> = {
  WARN: { emoji: '⚠️', label: 'WARNING' },
  ERROR: { emoji: '🚨', label: 'ERROR' },
  SYSTEM: { emoji: 'ℹ️', label: 'SYSTEM' },
  TRADE: { emoji: '🏁', label: 'EOD SQUARE-OFF' },
};

/** Same visual shape as algo_scalper_api's notify_error/notify_warning/
 * notify_status: emoji + bold level header, a Context line, the escaped
 * body, and an IST time footer — HTML parse_mode. */
export function formatLogMessage(level: string, source: string, message: string, now: Date = new Date()): string {
  const style = LEVEL_STYLE[level] || { emoji: 'ℹ️', label: level };
  const time = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' });
  return (
    `${style.emoji} <b>${style.label}</b>\n` +
    `<b>Context:</b> ${escapeHtml(source)}\n\n` +
    `${escapeHtml(message)}\n\n` +
    `⏰ ${time}`
  );
}

/** Sends one message, retrying once as plain text if HTML parsing is
 * rejected (stray &lt;/&gt;/&amp; in a dynamic message shouldn't drop it). */
async function sendChunk(token: string, chatId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const attempt = async (parseMode?: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
    });
    return res;
  };

  const res = await attempt('HTML');
  if (res.ok) return;
  const retryRes = await attempt();
  if (!retryRes.ok) {
    const body = await retryRes.text().catch(() => '');
    log.warn({ status: retryRes.status, body }, 'Telegram sendMessage failed');
  }
}

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!isTelegramEnabled()) return;
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;
  for (const chunk of splitIntoChunks(text)) {
    try {
      await sendChunk(token, chatId, chunk);
    } catch (e: any) {
      log.warn({ err: { message: e.message } }, 'Telegram request failed');
    }
  }
}

export function startTelegramNotifier(): () => void {
  if (!isTelegramEnabled()) {
    log.info('Telegram notifications disabled (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set)');
    return () => {};
  }
  log.info('Telegram notifications armed (WARN/ERROR/SYSTEM + trade exits, repeat-throttled)');
  return eventBus.on('log', (env) => {
    const { level, message, source } = env.payload || {};
    if (!shouldForwardLog(level, source, message)) return;
    const toSend = throttleRepeat(level, source, message);
    if (toSend === null) return;
    void sendTelegramMessage(formatLogMessage(level, source, toSend));
  });
}
