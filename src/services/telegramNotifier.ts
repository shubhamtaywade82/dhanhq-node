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
 * Forwards every `log` channel event at WARN/ERROR/SYSTEM level, plus the
 * EOD square-off result specifically (it logs at TRADE level but is exactly
 * the kind of "what just happened" alert this exists for). Deliberately not
 * a full feed of every TRADE-level fill — see the alert-scope decision this
 * was built against.
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

const EOD_SUMMARY_PREFIX = 'Square-off complete:';

/** WARN/ERROR/SYSTEM always forward; the one named TRADE exception is the
 * EOD square-off result, which is otherwise the only TRADE-level line that
 * reads as a standalone "here's what happened" alert. */
export function shouldForwardLog(level: string, source: string, message: string): boolean {
  if (level === 'WARN' || level === 'ERROR' || level === 'SYSTEM') return true;
  return level === 'TRADE' && source === 'autonomy' && message.startsWith(EOD_SUMMARY_PREFIX);
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
  log.info('Telegram notifications armed (WARN/ERROR/SYSTEM + EOD summary)');
  return eventBus.on('log', (env) => {
    const { level, message, source } = env.payload || {};
    if (!shouldForwardLog(level, source, message)) return;
    void sendTelegramMessage(formatLogMessage(level, source, message));
  });
}
