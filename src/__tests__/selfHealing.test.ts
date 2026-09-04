import { SelfHealingService } from '../services/selfHealing';

// auth.ts's dotenv.config() (transitively imported) fills in whatever real
// OLLAMA_API_KEY_N values are in .env — clear the whole numbered range to a
// blank slate per test, same reasoning as agent.ts's equivalent tests.
function withCloudKeys<T>(keys: string[], fn: () => T): T {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (/^OLLAMA_API_KEY_\d+$/.test(key)) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  }
  keys.forEach((k, i) => { process.env[`OLLAMA_API_KEY_${i + 1}`] = k; });
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (/^OLLAMA_API_KEY_\d+$/.test(key) && !(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

describe('SelfHealingService — Ollama Cloud wiring', () => {
  it('uses the local model when no cloud keys are configured', () => {
    withCloudKeys([], () => {
      const priorModel = process.env.SELF_HEALING_MODEL;
      delete process.env.SELF_HEALING_MODEL;
      try {
        const svc = new SelfHealingService();
        expect((svc as any).model).toBe(process.env.OLLAMA_MODEL || 'qwen2.5:0.5b');
      } finally {
        if (priorModel === undefined) delete process.env.SELF_HEALING_MODEL; else process.env.SELF_HEALING_MODEL = priorModel;
      }
    });
  });

  it('uses OLLAMA_CLOUD_MODEL and binds every configured key when cloud keys are present — the exact bug found live (fell through to the hardcoded fallback because this client only ever dialed local)', () => {
    withCloudKeys(['fake-key-1', 'fake-key-2'], () => {
      const priorModel = process.env.SELF_HEALING_MODEL;
      const priorCloudModel = process.env.OLLAMA_CLOUD_MODEL;
      delete process.env.SELF_HEALING_MODEL;
      process.env.OLLAMA_CLOUD_MODEL = 'gemma4:31b';
      try {
        const svc = new SelfHealingService();
        expect((svc as any).model).toBe('gemma4:31b');
        const ollama = (svc as any).ollama;
        expect(ollama).not.toBeNull();
        // credentials/modelBindings are private to the SDK client, but
        // endpointStatus() reports one row per bound credential — the same
        // way agent.ts's ollamaKeyStatus() verifies this.
        const status = ollama.endpointStatus();
        expect(status.map((s: any) => s.endpoint.name).sort()).toEqual(['credential:cloud-1', 'credential:cloud-2']);
      } finally {
        if (priorModel === undefined) delete process.env.SELF_HEALING_MODEL; else process.env.SELF_HEALING_MODEL = priorModel;
        if (priorCloudModel === undefined) delete process.env.OLLAMA_CLOUD_MODEL; else process.env.OLLAMA_CLOUD_MODEL = priorCloudModel;
      }
    });
  });

  it('SELF_HEALING_MODEL still overrides the auto-selected model when set', () => {
    withCloudKeys(['fake-key-1'], () => {
      const priorModel = process.env.SELF_HEALING_MODEL;
      process.env.SELF_HEALING_MODEL = 'custom-model:latest';
      try {
        const svc = new SelfHealingService();
        expect((svc as any).model).toBe('custom-model:latest');
      } finally {
        if (priorModel === undefined) delete process.env.SELF_HEALING_MODEL; else process.env.SELF_HEALING_MODEL = priorModel;
      }
    });
  });
});
