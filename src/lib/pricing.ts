import type { SessionUsage } from './types.js';

interface ModelPricing {
  baseInputPerM: number;
  outputPerM: number;
}

const PRICING: { pattern: RegExp; pricing: ModelPricing }[] = [
  { pattern: /opus-4-[56]/, pricing: { baseInputPerM: 5, outputPerM: 25 } },
  { pattern: /opus-4(?:-|$)/, pricing: { baseInputPerM: 15, outputPerM: 75 } },
  { pattern: /sonnet/, pricing: { baseInputPerM: 3, outputPerM: 15 } },
  { pattern: /haiku-4-5/, pricing: { baseInputPerM: 1, outputPerM: 5 } },
  { pattern: /haiku-3-5/, pricing: { baseInputPerM: 0.8, outputPerM: 4 } },
  { pattern: /haiku/, pricing: { baseInputPerM: 1, outputPerM: 5 } },
];

const DEFAULT_PRICING: ModelPricing = { baseInputPerM: 3, outputPerM: 15 };

export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const CACHE_READ_MULTIPLIER = 0.1;

export function getModelPricing(model: string): ModelPricing {
  for (const entry of PRICING) {
    if (entry.pattern.test(model)) {
      return entry.pricing;
    }
  }
  return DEFAULT_PRICING;
}

export function calcExpiryCost(cachedTokens: number, model: string): number {
  const { baseInputPerM } = getModelPricing(model);
  return (cachedTokens * baseInputPerM * CACHE_WRITE_1H_MULTIPLIER) / 1_000_000;
}

export function calcWarmCost(usage: SessionUsage, model: string): number {
  const { baseInputPerM, outputPerM } = getModelPricing(model);
  const readCost = (usage.cacheReadInputTokens * baseInputPerM * CACHE_READ_MULTIPLIER) / 1_000_000;
  const writeCost = (usage.cacheCreationInputTokens * baseInputPerM * CACHE_WRITE_1H_MULTIPLIER) / 1_000_000;
  const outputCost = (usage.outputTokens * outputPerM) / 1_000_000;
  return readCost + writeCost + outputCost;
}

export function calcEstimatedWarmCost(cachedTokens: number, isWarm: boolean, model: string): number {
  const { baseInputPerM } = getModelPricing(model);
  if (isWarm) {
    return (cachedTokens * baseInputPerM * CACHE_READ_MULTIPLIER) / 1_000_000;
  }
  return (cachedTokens * baseInputPerM * CACHE_WRITE_1H_MULTIPLIER) / 1_000_000;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function shortenModelName(model: string): string {
  let short = model.replace(/^claude-/, '');
  short = short.replace(/-\d{8}$/, '');
  return short;
}
