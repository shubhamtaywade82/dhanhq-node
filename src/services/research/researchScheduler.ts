import { marketClock, istParts } from '../marketHours';
import { sendTelegramMessage, isTelegramEnabled } from '../telegramNotifier';
import { eventBus } from '../eventBus';
import { moduleLogger } from '../../lib/logger';
import { type ResearchOrchestrator } from './researchOrchestrator';
import { getActiveWatchlist, saveWatchlist, updateWatchlistAnalyzed } from './researchRepository';
import { type MarketPhase, type SchedulerStatus, type WatchlistItem, type ResearchRun } from './types';

const log = moduleLogger('research_scheduler');

export class ResearchScheduler {
  private timer: NodeJS.Timeout | null = null;
  private enabled = true;
  private lastDates = { preMarket: '', postMarket: '', month: '', hoursSlot: '' };
  private lastRunTimestamps: Record<string, number> = {};

  constructor(
    private orchestrator: ResearchOrchestrator,
  ) {}

  async start(): Promise<void> {
    log.info('ResearchScheduler starting — market lifecycle intelligence armed');
    // Run an initial quick check after 2 seconds
    setTimeout(() => void this.evaluateCycle(), 2000);
    this.timer = setInterval(() => void this.evaluateCycle(), 60000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async evaluateCycle(): Promise<void> {
    if (!this.enabled) return;
    const clock = marketClock();
    const { hours, minutes, dateStr } = istParts();
    const monthKey = dateStr.slice(0, 7); // YYYY-MM

    try {
      // 1. Monthly Screener Refresh (1st of month, 06:00-08:00 IST)
      if (dateStr.endsWith('-01') && hours >= 6 && this.lastDates.month !== monthKey) {
        this.lastDates.month = monthKey;
        await this.runMonthlyScreen();
      }

      if (!clock.isTradingDay) return;

      // 2. Pre-Market Briefing (08:45-09:10 IST)
      if (clock.minutesOfDay >= 525 && clock.minutesOfDay < 550 && this.lastDates.preMarket !== dateStr) {
        this.lastDates.preMarket = dateStr;
        await this.runPreMarketBrief();
      }

      // 3. Live Market Hours Surveillance (Slots at 11:30 and 14:00 IST)
      const isSlot1 = clock.minutesOfDay >= 690 && clock.minutesOfDay <= 700; // 11:30-11:40
      const isSlot2 = clock.minutesOfDay >= 840 && clock.minutesOfDay <= 850; // 14:00-14:10
      const slotKey = `${dateStr}_${isSlot1 ? '1130' : '1400'}`;
      if ((isSlot1 || isSlot2) && this.lastDates.hoursSlot !== slotKey) {
        this.lastDates.hoursSlot = slotKey;
        await this.runMarketHoursAlert();
      }

      // 4. Post-Market EOD Deep Dive (15:50-16:30 IST)
      if (clock.minutesOfDay >= 950 && clock.minutesOfDay < 990 && this.lastDates.postMarket !== dateStr) {
        this.lastDates.postMarket = dateStr;
        await this.runPostMarketDossier();
      }
    } catch (e: any) {
      log.error({ err: e.message }, 'Error in ResearchScheduler cycle');
    }
  }

  async runMonthlyScreen(): Promise<void> {
    log.info('Executing automated monthly research screening');
    this.lastRunTimestamps.monthlyScreen = Date.now();
    const res = await this.orchestrator.screen('FNO_HEAVYWEIGHTS', 'QUALITY_COMPOUNDERS');
    const passing = res.candidates.filter((c) => c.passed);
    await saveWatchlist(passing, 'FNO_HEAVYWEIGHTS');

    const msg = `📅 *MONTHLY RESEARCH WATCHLIST REFRESHED*\nScreened: ${res.totalScreened} stocks | Passed: ${res.totalPassed}\n⭐ Top Picks: ${res.topPicks.join(', ')}`;
    await sendTelegramMessage(msg);
    eventBus.log('SYSTEM', msg, 'research_scheduler');
  }

  async runPreMarketBrief(): Promise<string> {
    log.info('Generating Pre-Market Institutional Briefing');
    this.lastRunTimestamps.preMarketBrief = Date.now();
    const watchlist = await getActiveWatchlist();
    if (watchlist.length === 0) return 'No active watchlist';

    const lines = [
      '🌅 *PRE-MARKET INSTITUTIONAL BRIEFING*',
      `📅 ${istParts().dateStr} | Indian Equities Focus`,
      `🔍 Active Watchlist (${watchlist.length} stocks):`,
      '',
    ];

    for (const w of watchlist.slice(0, 5)) {
      lines.push(`• *${w.symbol}* (${w.sector})`);
      lines.push(`  Score: ${w.deterministicScore}/100 | Supertrend: ${w.metrics.supertrend} | RSI: ${w.metrics.rsi14}`);
    }

    lines.push('\n_Autonomous surveillance armed for market open._');
    const msg = lines.join('\n');
    await sendTelegramMessage(msg);
    eventBus.log('SYSTEM', msg, 'research_scheduler');
    return msg;
  }

  async runMarketHoursAlert(): Promise<void> {
    log.info('Running Market-Hours Option Chain Surveillance');
    this.lastRunTimestamps.marketHoursAlert = Date.now();
    const watchlist = await getActiveWatchlist();

    for (const w of watchlist.slice(0, 3)) {
      const sig = this.orchestrator.getSignal(w.symbol);
      if (sig && sig.conviction >= 65) {
        const msg = `⚡ *INTRADAY RESEARCH SIGNAL: ${sig.symbol}*\nBias: *${sig.bias}* (Conviction: ${sig.conviction}/100)\nHorizon: ${sig.horizon}\nSetup: ${sig.suggestedStructures.join(', ')}`;
        await sendTelegramMessage(msg);
        eventBus.log('SYSTEM', msg, 'research_scheduler');
      }
    }
  }

  async runPostMarketDossier(): Promise<string> {
    log.info('Executing Post-Market Agentic AI Deep Dive');
    this.lastRunTimestamps.postMarketDossier = Date.now();
    const watchlist = await getActiveWatchlist();
    const topTargets = watchlist.slice(0, 3);
    const runs: ResearchRun[] = [];

    for (const item of topTargets) {
      const run = await this.orchestrator.analyze(item.symbol);
      await updateWatchlistAnalyzed(item.symbol);
      runs.push(run);
    }

    const lines = [
      '📊 *POST-MARKET INSTITUTIONAL DOSSIER*',
      `📅 ${istParts().dateStr} EOD Agentic Analysis`,
      '',
    ];

    for (const r of runs) {
      const v = r.verdict;
      lines.push(`🏆 *${r.symbol}*: Stance *${v?.stance || 'HOLD'}*`);
      lines.push(`  Quality: ${v?.qualityScore}/100 | Valuation: ${v?.valuationScore}/100`);
      lines.push(`  Base DCF: ₹${v?.fairValue.base} (MoS: ${v?.marginOfSafetyPct}%)`);
      lines.push(`  Top Catalyst: ${v?.keyCatalysts?.[0] || 'Operational execution'}`);
      lines.push('');
    }

    const msg = lines.join('\n');
    await sendTelegramMessage(msg);
    eventBus.log('SYSTEM', msg, 'research_scheduler');
    return msg;
  }

  async triggerPhase(phase: 'pre_market' | 'market_hours' | 'post_market' | 'monthly_screen'): Promise<any> {
    if (phase === 'pre_market') return { result: await this.runPreMarketBrief() };
    if (phase === 'post_market') return { result: await this.runPostMarketDossier() };
    if (phase === 'monthly_screen') {
      await this.runMonthlyScreen();
      return { result: 'Monthly screener refresh completed' };
    }
    await this.runMarketHoursAlert();
    return { result: 'Market hours alert evaluated' };
  }

  getStatus(): SchedulerStatus {
    const clock = marketClock();
    const phase: MarketPhase = clock.isMarketOpen
      ? 'MARKET_HOURS'
      : clock.isPreOpen || (clock.minutesOfDay >= 510 && clock.minutesOfDay < 555)
      ? 'PRE_MARKET'
      : clock.isPostClose && clock.minutesOfDay < 1020
      ? 'POST_MARKET'
      : 'CLOSED';

    const { hours, minutes } = istParts();
    const nextJob = clock.minutesOfDay < 525 ? 'Pre-Market Brief (08:45 IST)'
      : clock.minutesOfDay < 690 ? 'Mid-Day Option Flow (11:30 IST)'
      : clock.minutesOfDay < 840 ? 'Afternoon Option Flow (14:00 IST)'
      : clock.minutesOfDay < 950 ? 'Post-Market EOD Dossier (15:50 IST)'
      : 'Pre-Market Brief Tomorrow (08:45 IST)';

    return {
      enabled: this.enabled,
      marketPhase: phase,
      nextScheduledJob: nextJob,
      nextJobTimeIst: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} IST`,
      telegramEnabled: isTelegramEnabled(),
      activeWatchlistCount: 0, // Populated by caller
      lastRunTimes: this.lastRunTimestamps,
    };
  }
}
