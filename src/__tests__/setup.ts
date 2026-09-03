import { setSystemState } from '../services/systemState';

// canTrade() now gates on SystemState, which defaults to 'BOOTING' until
// startCore() reaches READY. Tests that build engines/RiskEngine directly
// (not via startCore()) never reach that point, so every existing test
// exercising real order placement would otherwise see canTrade() blocked.
// A test verifying the DEGRADED/BOOTING-blocks-trading behavior itself
// calls setSystemState() to override this.
setSystemState('READY');
