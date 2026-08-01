/**
 * Unit tests for the cost model used by per-app token/cost attribution.
 */
import {
  MODEL_RATES,
  DEFAULT_RATE,
  resolveRate,
  computeCost,
  microUsdToUsd,
} from '../cost-model';

describe('resolveRate', () => {
  test('returns the exact rate for a known model', () => {
    const { rate, usedFallbackRate } = resolveRate('anthropic.claude-3-5-sonnet');
    expect(rate).toEqual(MODEL_RATES['anthropic.claude-3-5-sonnet']);
    expect(usedFallbackRate).toBe(false);
  });

  test('falls back for an unknown model', () => {
    const { rate, usedFallbackRate } = resolveRate('some.unlisted-model');
    expect(rate).toEqual(DEFAULT_RATE);
    expect(usedFallbackRate).toBe(true);
  });

  test('falls back for undefined model', () => {
    const { rate, usedFallbackRate } = resolveRate(undefined);
    expect(rate).toEqual(DEFAULT_RATE);
    expect(usedFallbackRate).toBe(true);
  });

  test('does not treat inherited Object properties as known models', () => {
    const { usedFallbackRate } = resolveRate('toString');
    expect(usedFallbackRate).toBe(true);
  });
});

describe('computeCost', () => {
  test('computes cost in micro-USD for a known model', () => {
    // sonnet: $3/1M input, $15/1M output. 1000 in + 500 out:
    //   1000*3 + 500*15 = 3000 + 7500 = 10500 micro-USD
    const { costMicroUsd, usedFallbackRate } = computeCost(
      'anthropic.claude-3-5-sonnet',
      1000,
      500,
    );
    expect(costMicroUsd).toBe(10500);
    expect(usedFallbackRate).toBe(false);
    expect(microUsdToUsd(costMicroUsd)).toBeCloseTo(0.0105, 6);
  });

  test('uses the fallback rate for an unknown model and flags it', () => {
    const { costMicroUsd, usedFallbackRate } = computeCost('mystery.model', 1_000_000, 0);
    // default input rate $3/1M => 1,000,000 * 3 = 3,000,000 micro-USD = $3
    expect(costMicroUsd).toBe(3_000_000);
    expect(usedFallbackRate).toBe(true);
  });

  test('returns zero cost for zero tokens', () => {
    expect(computeCost('anthropic.claude-3-opus', 0, 0).costMicroUsd).toBe(0);
  });

  test('clamps negative and non-finite token counts to zero', () => {
    expect(computeCost('anthropic.claude-3-5-sonnet', -100, -5).costMicroUsd).toBe(0);
    expect(computeCost('anthropic.claude-3-5-sonnet', NaN, Infinity).costMicroUsd).toBe(0);
  });

  test('floors fractional token counts before pricing', () => {
    // haiku: $0.25/1M input. 4 input tokens (from 4.9) => round(4*0.25)=1 micro-USD
    const { costMicroUsd } = computeCost('anthropic.claude-3-haiku', 4.9, 0);
    expect(costMicroUsd).toBe(1);
  });

  test('result is always an integer (safe for DynamoDB ADD counters)', () => {
    const { costMicroUsd } = computeCost('anthropic.claude-3-haiku', 7, 3);
    expect(Number.isInteger(costMicroUsd)).toBe(true);
  });
});
