import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

let envLoaded = false;

/**
 * Layers environment configuration:
 * 1. Base .env provides shared infrastructure and market data credentials.
 * 2. Mode-specific .env.<mode> (paper, sandbox, live) overrides runtime settings.
 */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;

  const root = process.cwd();
  dotenv.config({ path: resolve(root, '.env') });

  const mode = process.env.TRADING_MODE || 'paper';
  const modeFile = resolve(root, `.env.${mode}`);
  if (existsSync(modeFile)) {
    dotenv.config({ path: modeFile, override: true });
  }
}

// Executes on import so any entry point importing this module gets layered env immediately.
loadEnv();
