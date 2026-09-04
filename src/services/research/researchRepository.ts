import { pool, dbMode } from '../../db';
import { moduleLogger } from '../../lib/logger';
import { type ScreenerCandidate, type ScreenerResult, type WatchlistItem } from './types';

const log = moduleLogger('research_repo');

// In-memory fallback caches for offline/unit-test resilience
const memWatchlist = new Map<string, WatchlistItem>();
const memScreenerRuns: ScreenerResult[] = [];

/**
 * Initializes database schemas for screener runs and monthly research watchlist.
 */
export async function initResearchRepository(): Promise<void> {
  if (dbMode() !== 'postgres') return;
  const sql = `
    CREATE TABLE IF NOT EXISTS screener_runs (
      id VARCHAR(64) PRIMARY KEY,
      universe VARCHAR(32) NOT NULL,
      preset VARCHAR(32) NOT NULL,
      total_screened INTEGER NOT NULL,
      total_passed INTEGER NOT NULL,
      top_picks JSONB NOT NULL DEFAULT '[]',
      candidates JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS research_watchlist (
      symbol VARCHAR(32) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      sector VARCHAR(64) NOT NULL,
      universe VARCHAR(32) NOT NULL,
      deterministic_score NUMERIC(5, 2) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      metrics JSONB NOT NULL DEFAULT '{}',
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_analyzed_at TIMESTAMPTZ
    );
  `;
  try {
    await pool.query(sql);
    log.info('Research persistence tables initialized successfully');
  } catch (e: any) {
    log.warn({ err: e.message }, 'Failed to initialize research schema in Postgres');
  }
}

/**
 * Persists a completed screener run.
 */
export async function saveScreenerRun(run: ScreenerResult): Promise<void> {
  memScreenerRuns.unshift(run);
  if (memScreenerRuns.length > 50) memScreenerRuns.pop();

  if (dbMode() === 'postgres') {
    const id = `scr_${Date.now()}_${run.universe.toLowerCase()}`;
    const q = `
      INSERT INTO screener_runs (id, universe, preset, total_screened, total_passed, top_picks, candidates, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING;
    `;
    try {
      await pool.query(q, [
        id, run.universe, run.preset, run.totalScreened, run.totalPassed,
        JSON.stringify(run.topPicks), JSON.stringify(run.candidates), new Date(run.screenedAt),
      ]);
    } catch (e: any) {
      log.warn({ err: e.message }, 'Failed to persist screener run in Postgres');
    }
  }
}

/**
 * Persists top screened candidates into the active monthly research watchlist.
 */
export async function saveWatchlist(candidates: ScreenerCandidate[], universe: string): Promise<void> {
  const now = Date.now();
  // Monthly expiration: 30 days ahead
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

  for (const c of candidates) {
    const item: WatchlistItem = {
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      universe,
      deterministicScore: c.deterministicScore,
      status: 'ACTIVE',
      metrics: c.metrics,
      addedAt: now,
      expiresAt,
    };
    memWatchlist.set(c.symbol, item);

    if (dbMode() === 'postgres') {
      const q = `
        INSERT INTO research_watchlist (symbol, name, sector, universe, deterministic_score, status, metrics, added_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8)
        ON CONFLICT (symbol) DO UPDATE SET
          deterministic_score = EXCLUDED.deterministic_score,
          metrics = EXCLUDED.metrics,
          expires_at = EXCLUDED.expires_at,
          status = 'ACTIVE';
      `;
      try {
        await pool.query(q, [
          item.symbol, item.name, item.sector, item.universe,
          item.deterministicScore, JSON.stringify(item.metrics), new Date(item.addedAt), new Date(item.expiresAt),
        ]);
      } catch (e: any) {
        log.warn({ symbol: c.symbol, err: e.message }, 'Failed to upsert watchlist item');
      }
    }
  }
}

/**
 * Returns all active watchlist items sorted by score descending.
 */
export async function getActiveWatchlist(): Promise<WatchlistItem[]> {
  if (dbMode() === 'postgres') {
    try {
      const q = `
        SELECT symbol, name, sector, universe, deterministic_score as "deterministicScore",
               status, metrics,
               EXTRACT(EPOCH FROM added_at)*1000 as "addedAt",
               EXTRACT(EPOCH FROM expires_at)*1000 as "expiresAt",
               EXTRACT(EPOCH FROM last_analyzed_at)*1000 as "lastAnalyzedAt"
        FROM research_watchlist
        WHERE status = 'ACTIVE' AND expires_at > NOW()
        ORDER BY deterministic_score DESC;
      `;
      const res = await pool.query(q);
      return res.rows.map((r: any) => ({
        ...r,
        deterministicScore: Number(r.deterministicScore),
        addedAt: Number(r.addedAt),
        expiresAt: Number(r.expiresAt),
        lastAnalyzedAt: r.lastAnalyzedAt ? Number(r.lastAnalyzedAt) : undefined,
      }));
    } catch { /* fallback to mem */ }
  }
  return Array.from(memWatchlist.values())
    .filter((w) => w.status === 'ACTIVE' && w.expiresAt > Date.now())
    .sort((a, b) => b.deterministicScore - a.deterministicScore);
}

/**
 * Updates last analyzed timestamp when Agentic AI finishes a deep dive.
 */
export async function updateWatchlistAnalyzed(symbol: string): Promise<void> {
  const item = memWatchlist.get(symbol.toUpperCase());
  if (item) item.lastAnalyzedAt = Date.now();

  if (dbMode() === 'postgres') {
    const q = 'UPDATE research_watchlist SET last_analyzed_at = NOW() WHERE symbol = $1';
    await pool.query(q, [symbol.toUpperCase()]).catch(() => {});
  }
}

export async function clearWatchlistForTests(): Promise<void> {
  memWatchlist.clear();
  if (dbMode() === 'postgres') {
    await pool.query('DELETE FROM research_watchlist').catch(() => {});
  }
}

