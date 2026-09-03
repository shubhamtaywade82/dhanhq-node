import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setSystemState } from '../services/systemState';

// canTrade() now gates on SystemState, which defaults to 'BOOTING' until
// startCore() reaches READY. Tests that build engines/RiskEngine directly
// (not via startCore()) never reach that point, so every existing test
// exercising real order placement would otherwise see canTrade() blocked.
// A test verifying the DEGRADED/BOOTING-blocks-trading behavior itself
// calls setSystemState() to override this.
setSystemState('READY');

// Isolate journal writes during tests so test fills and kill-switch events
// never pollute the runtime .journal directory.
const testJournalDir = mkdtempSync(join(tmpdir(), 'dhanhq-test-journal-'));
process.env.JOURNAL_DIR = testJournalDir;


