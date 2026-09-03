import * as fs from 'fs';
import * as path from 'path';
import { AdaptiveParameterAI, DEFAULT_ACTIONS } from '../services/adaptiveSupertrend/parameterAi';
import type { MarketFeatures } from '../services/adaptiveSupertrend/types';

function readQTable(tmpFile: string, ai: AdaptiveParameterAI): Record<string, number[]> {
  ai.saveMemory(tmpFile); // learn() already saves on every call, but be explicit
  return JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
}

const features: MarketFeatures = {
  volatility: 'high', trendStrength: 'strong', momentum: 'overbought',
  adx: 40, bandWidth: 0.08, rsi: 75, macdHist: 1, volumeRatio: 1, atr: 10,
};

describe('adaptive supertrend parameter Q-learning', () => {
  it('chooseAction is deterministic with epsilon forced to 0 (always exploits)', () => {
    const ai = new AdaptiveParameterAI({ epsilon: 0 });
    const first = ai.chooseAction(features);
    const second = ai.chooseAction(features);
    expect(first.actionIndex).toBe(second.actionIndex);
    expect(first.params).toEqual(DEFAULT_ACTIONS[first.actionIndex]);
  });

  it('learn() applies the Bellman update arithmetically (reward only, no nextState)', () => {
    const tmpFile = path.join('/tmp', `qtable_bellman_${Date.now()}.json`);
    const ai = new AdaptiveParameterAI({ epsilon: 0, learningRate: 0.15, discountFactor: 0.85, persistencePath: tmpFile });
    const { state, actionIndex } = ai.chooseAction(features);
    const qBefore = readQTable(tmpFile, ai)[state]?.[actionIndex] ?? 0.1; // heuristic seed floor
    ai.learn(state, actionIndex, 1.0); // no nextState -> maxNextQ=0
    const qAfter = readQTable(tmpFile, ai)[state]![actionIndex]!;
    const expected = Math.round((qBefore + 0.15 * (1.0 - qBefore)) * 1000) / 1000;
    expect(qAfter).toBeCloseTo(expected, 3);
    fs.unlinkSync(tmpFile);
  });

  it('learn() bootstraps off nextState Q-values, never off state itself', () => {
    const tmpFile = path.join('/tmp', `qtable_bootstrap_${Date.now()}.json`);
    const ai = new AdaptiveParameterAI({ epsilon: 0, learningRate: 0.15, discountFactor: 0.85, persistencePath: tmpFile });
    const { state, actionIndex } = ai.chooseAction(features);

    const otherFeatures: MarketFeatures = { ...features, volatility: 'low', trendStrength: 'weak' };
    const next = ai.chooseAction(otherFeatures);
    ai.learn(next.state, next.actionIndex, 1.0); // pump nextState's Q-value up first

    ai.learn(state, actionIndex, 0, next.state); // reward=0, bootstraps off next.state
    const withNextState = readQTable(tmpFile, ai)[state]![actionIndex]!;

    // Same starting point, reward 0, but WITHOUT a nextState -> maxNextQ=0,
    // so the update must be strictly smaller than the bootstrapped version.
    const tmpFile2 = path.join('/tmp', `qtable_no_bootstrap_${Date.now()}.json`);
    const ai2 = new AdaptiveParameterAI({ epsilon: 0, learningRate: 0.15, discountFactor: 0.85, persistencePath: tmpFile2 });
    ai2.chooseAction(features);
    ai2.learn(state, actionIndex, 0);
    const withoutNextState = readQTable(tmpFile2, ai2)[state]![actionIndex]!;

    expect(withNextState).toBeGreaterThan(withoutNextState);
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(tmpFile2);
  });

  it('saveMemory/loadMemory round-trip via a temp path', () => {
    const tmpFile = path.join('/tmp', `adaptive_supertrend_qtable_test_${Date.now()}.json`);
    const ai = new AdaptiveParameterAI({ epsilon: 0 });
    const { state, actionIndex } = ai.chooseAction(features);
    ai.learn(state, actionIndex, 0.7);
    ai.saveMemory(tmpFile);

    const reloaded = new AdaptiveParameterAI({ epsilon: 0, persistencePath: tmpFile });
    expect(reloaded.getLearnedStatesCount()).toBe(ai.getLearnedStatesCount());
    fs.unlinkSync(tmpFile);
  });
});
