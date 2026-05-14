import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  calcEstimatedWarmCost,
  calcExpiryCost,
  calcWarmCost,
  formatUsd,
  getModelPricing,
  shortenModelName,
} from '../../src/lib/pricing.ts';

describe('getModelPricing', () => {
  it('returns opus 4.6 pricing', () => {
    const p = getModelPricing('claude-opus-4-6');
    expect(p.baseInputPerM).toBe(5);
    expect(p.outputPerM).toBe(25);
  });

  it('returns opus 4.5 pricing', () => {
    const p = getModelPricing('claude-opus-4-5');
    expect(p.baseInputPerM).toBe(5);
    expect(p.outputPerM).toBe(25);
  });

  it('returns sonnet 4.6 pricing', () => {
    const p = getModelPricing('claude-sonnet-4-6');
    expect(p.baseInputPerM).toBe(3);
    expect(p.outputPerM).toBe(15);
  });

  it('returns sonnet 4.5 pricing', () => {
    const p = getModelPricing('claude-sonnet-4-5');
    expect(p.baseInputPerM).toBe(3);
  });

  it('returns sonnet 4 pricing', () => {
    const p = getModelPricing('claude-sonnet-4-20250514');
    expect(p.baseInputPerM).toBe(3);
  });

  it('returns haiku 4.5 pricing', () => {
    const p = getModelPricing('claude-haiku-4-5-20251001');
    expect(p.baseInputPerM).toBe(1);
    expect(p.outputPerM).toBe(5);
  });

  it('falls back to sonnet pricing for unknown models', () => {
    const p = getModelPricing('claude-unknown-99');
    expect(p.baseInputPerM).toBe(3);
  });
});

describe('calcExpiryCost', () => {
  it('computes 1h cache write cost for opus', () => {
    const cost = calcExpiryCost(100_000, 'claude-opus-4-6');
    expect(cost).toBeCloseTo(1.0);
  });

  it('computes 1h cache write cost for sonnet', () => {
    const cost = calcExpiryCost(100_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(0.6);
  });

  it('returns 0 for 0 tokens', () => {
    expect(calcExpiryCost(0, 'claude-opus-4-6')).toBe(0);
  });
});

describe('calcWarmCost', () => {
  it('computes cost for a warm session (cache reads only)', () => {
    const cost = calcWarmCost(
      { inputTokens: 0, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 0, outputTokens: 10 },
      'claude-opus-4-6',
    );
    expect(cost).toBeCloseTo(0.05025);
  });

  it('computes cost for a cold session (cache write)', () => {
    const cost = calcWarmCost(
      { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 100_000, outputTokens: 10 },
      'claude-opus-4-6',
    );
    expect(cost).toBeCloseTo(1.00025);
  });

  it('computes mixed read/write cost', () => {
    const cost = calcWarmCost(
      { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 10_000, outputTokens: 5 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.075075);
  });
});

describe('calcEstimatedWarmCost', () => {
  it('computes cache read cost for warm sessions', () => {
    const cost = calcEstimatedWarmCost(100_000, true, 'claude-opus-4-6');
    expect(cost).toBeCloseTo(0.05);
  });

  it('computes cache write cost for cold sessions', () => {
    const cost = calcEstimatedWarmCost(100_000, false, 'claude-opus-4-6');
    expect(cost).toBeCloseTo(1.0);
  });

  it('uses sonnet pricing', () => {
    const cost = calcEstimatedWarmCost(100_000, true, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(0.03);
  });

  it('returns 0 for 0 tokens', () => {
    expect(calcEstimatedWarmCost(0, true, 'claude-opus-4-6')).toBe(0);
    expect(calcEstimatedWarmCost(0, false, 'claude-opus-4-6')).toBe(0);
  });
});

describe('formatUsd', () => {
  it('formats small amounts', () => {
    expect(formatUsd(0.05)).toBe('$0.05');
  });

  it('formats zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('formats larger amounts', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});

describe('shortenModelName', () => {
  it('strips claude- prefix', () => {
    expect(shortenModelName('claude-opus-4-6')).toBe('opus-4-6');
  });

  it('strips date suffix', () => {
    expect(shortenModelName('claude-sonnet-4-20250514')).toBe('sonnet-4');
  });

  it('strips claude- prefix and date suffix', () => {
    expect(shortenModelName('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
  });

  it('returns as-is if no prefix', () => {
    expect(shortenModelName('unknown-model')).toBe('unknown-model');
  });
});
