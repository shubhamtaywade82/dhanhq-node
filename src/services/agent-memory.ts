// @ts-ignore
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.AGENT_DB_PATH || path.resolve(__dirname, "../../../../../local-agent-stack/db/shared-agent-memory.db");

// Ensure directory exists before connecting
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec("PRAGMA journal_mode = WAL;");
    dbInstance.exec("PRAGMA synchronous = NORMAL;");
    dbInstance.exec("PRAGMA busy_timeout = 5000;");
  }
  return dbInstance;
}

export interface MemoryRecord {
  id: number;
  topic: string;
  fact: string;
  source: string;
  created_at: string;
}

export interface SystemRuleRecord {
  id: number;
  rule: string;
  pattern: string;
  hit_count: number;
}

/**
 * Searches shared memory database for relevant domain context.
 */
export function searchMemories(query: string, limit = 5): MemoryRecord[] {
  const words = query.replace(/[^\w\s]/gi, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const ftsQuery = words.map((w) => `${w}*`).join(" OR ");
  const stmt = getDb().prepare(`
    SELECT m.id, m.topic, m.fact, m.source, m.created_at
    FROM memories_fts fts
    JOIN memories m ON fts.rowid = m.id
    WHERE memories_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(ftsQuery, limit) as unknown as MemoryRecord[];
}

/**
 * Loads active rules promoted through self-healing loops.
 */
export function loadActiveRules(): SystemRuleRecord[] {
  const stmt = getDb().prepare(`
    SELECT id, rule, pattern, hit_count 
    FROM system_rules 
    ORDER BY id ASC
  `);
  return stmt.all() as unknown as SystemRuleRecord[];
}

/**
 * Streams DhanHQ runtime errors into central audit logs.
 */
export function logDhanError(source: string, error: unknown, metadata: Record<string, unknown> = {}): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const payload = JSON.stringify({
    error: errorMessage,
    bot: "dhanhq-node",
    source,
    ...metadata,
  });

  const stmt = getDb().prepare(`
    INSERT INTO audit_logs (session_id, event_type, payload)
    VALUES (?, 'error', ?)
  `);
  stmt.run(`dhanhq-node-${Date.now()}`, payload);
}
