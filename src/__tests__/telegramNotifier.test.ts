import { splitIntoChunks, shouldForwardLog, formatLogMessage, throttleRepeat } from '../services/telegramNotifier';

describe('Telegram notifier', () => {
  it('does not split messages under the limit', () => {
    expect(splitIntoChunks('short message', 4000)).toEqual(['short message']);
  });

  it('splits long messages on line boundaries without breaking a line mid-way', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(20));
    const text = lines.join('\n');
    const chunks = splitIntoChunks(text, 500);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    // Reassembling every chunk's lines must reproduce the original lines in order.
    expect(chunks.join('\n').split('\n')).toEqual(text.split('\n'));
  });

  it('hard-splits a single line longer than the limit', () => {
    const longLine = 'x'.repeat(1200);
    const chunks = splitIntoChunks(longLine, 500);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.join('')).toBe(longLine);
  });

  it('drops WARN, ERROR, and SYSTEM — those stay in the system logger, not Telegram', () => {
    expect(shouldForwardLog('WARN', 'risk_engine', 'anything')).toBe(false);
    expect(shouldForwardLog('ERROR', 'paper_engine', 'anything')).toBe(false);
    expect(shouldForwardLog('SYSTEM', 'core', 'anything')).toBe(false);
  });

  it('drops INFO and TRADE except the autonomy EOD summary line', () => {
    expect(shouldForwardLog('INFO', 'core', 'Core stack online')).toBe(false);
    expect(shouldForwardLog('TRADE', 'paper_engine', 'Paper fill BUY 75 NIFTY @ ₹100')).toBe(false);
    expect(shouldForwardLog('TRADE', 'autonomy', 'Square-off complete: 3 position(s) closed')).toBe(true);
    // Same prefix, wrong source — must not accidentally match.
    expect(shouldForwardLog('TRADE', 'paper_engine', 'Square-off complete: 3 position(s) closed')).toBe(false);
  });

  it('forwards autonomy auto-exit events too, not just the EOD summary', () => {
    expect(shouldForwardLog('TRADE', 'autonomy', 'Auto-exit NIFTY24050CE: TRADED @ ₹18.50 (stop_loss)')).toBe(true);
  });

  it('throttleRepeat sends the first occurrence, suppresses immediate repeats of the same root cause', () => {
    const t0 = 1_000_000;
    expect(throttleRepeat('WARN', 'paper_engine', 'Paper order REJECTED for strat_orb_abc123_CE_57200: Insufficient margin: need ₹136815.00 more, ₹83819.79 available', t0)).not.toBeNull();
    // Different strategy id, different amounts — same root cause after normalization — suppressed.
    expect(throttleRepeat('WARN', 'paper_engine', 'Paper order REJECTED for strat_orb_xyz789_CE_57100: Insufficient margin: need ₹144885.00 more, ₹83819.79 available', t0 + 60_000)).toBeNull();
    expect(throttleRepeat('WARN', 'paper_engine', 'Paper order REJECTED for strat_orb_qqq111_CE_57200: Insufficient margin: need ₹137032.50 more, ₹83819.79 available', t0 + 5 * 60_000)).toBeNull();
  });

  it('throttleRepeat sends a count-annotated reminder after the reminder interval', () => {
    const t0 = 2_000_000;
    expect(throttleRepeat('WARN', 'market_data', 'Index quote poll rate-limited — backing off 10s', t0)).not.toBeNull();
    expect(throttleRepeat('WARN', 'market_data', 'Index quote poll rate-limited — backing off 20s', t0 + 60_000)).toBeNull();
    const reminder = throttleRepeat('WARN', 'market_data', 'Index quote poll rate-limited — backing off 40s', t0 + 31 * 60_000);
    expect(reminder).toContain('recurring');
    expect(reminder).toContain('suppressed');
  });

  it('throttleRepeat never suppresses ERROR or TRADE, only WARN/SYSTEM', () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 5; i++) {
      expect(throttleRepeat('ERROR', 'risk_engine', 'KILL SWITCH ENGAGED: daily loss', t0 + i * 1000)).not.toBeNull();
      expect(throttleRepeat('TRADE', 'autonomy', 'Auto-exit NIFTY24050CE: TRADED @ ₹18.50 (stop_loss)', t0 + i * 1000)).not.toBeNull();
    }
  });

  it('formats an ERROR as an emoji-headed HTML card with context and a time footer', () => {
    const at = new Date('2026-09-02T04:30:15.000Z'); // 10:00:15 IST
    const msg = formatLogMessage('ERROR', 'risk_engine', 'Kill switch engaged', at);
    expect(msg).toBe('🚨 <b>ERROR</b>\n<b>Context:</b> risk_engine\n\nKill switch engaged\n\n⏰ 10:00:15');
  });

  it('gives WARNING, SYSTEM, and the EOD summary their own emoji/label', () => {
    const at = new Date('2026-09-02T04:30:15.000Z');
    expect(formatLogMessage('WARN', 'market', 'Tick feed stale', at)).toContain('⚠️ <b>WARNING</b>');
    expect(formatLogMessage('SYSTEM', 'core', 'Boot complete', at)).toContain('ℹ️ <b>SYSTEM</b>');
    expect(formatLogMessage('TRADE', 'autonomy', 'Square-off complete: 3 position(s) closed', at)).toContain('🏁 <b>EOD SQUARE-OFF</b>');
  });

  it('HTML-escapes the message and source so a stray <, >, or & never breaks parse_mode', () => {
    const at = new Date('2026-09-02T04:30:15.000Z');
    const msg = formatLogMessage('ERROR', 'risk<engine>', 'loss > 50000 & rising', at);
    expect(msg).toContain('loss &gt; 50000 &amp; rising');
    expect(msg).toContain('risk&lt;engine&gt;');
  });
});
