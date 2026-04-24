export interface SessionUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

export type WarmingStatus = 'idle' | 'warming' | 'success' | 'error';

export interface Session {
  sessionId: string;
  name: string;
  projectDir: string;
  cwd: string;
  model: string;
  lastAssistantTimestamp: number;
  isWarm: boolean;
  isLive: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  expiryCostUsd: number;
  selected: boolean;
  warmingStatus: WarmingStatus;
  warmCostUsd: number;
  warmCount: number;
  nextWarmAt: number | null;
  lastWarmedAt: number | null;
  lastWarmError: string | null;
  // Number of consecutive warm failures since the last success. Optional so
  // discovery code paths (sessions.ts) and existing fixtures don't have to
  // be updated in lockstep — readers MUST treat undefined as 0.
  consecutiveErrors?: number;
}

export interface WarmResult {
  sessionId: string;
  usage: SessionUsage;
  model: string;
  costUsd: number;
  error: string | null;
}

export type WarmFn = (sessionId: string, prompt: string, cwd?: string, projectDir?: string) => Promise<WarmResult>;

export const WARM_THRESHOLD_MS = 55 * 60 * 1000;

// Per-session headroom subtracted from the cache TTL to absorb cumulative
// serial-warm latency for ~5-10 selected sessions. With ~80s per warm, 10
// sessions back-to-back take ~13min, so 5min is conservative for the typical
// 5-session case while still leaving the user-visible interval close to
// WARM_THRESHOLD_MS.
export const SAFETY_MARGIN_MS = 5 * 60 * 1000;

// Bounded retry backoff for transient warm failures. Indexed by
// `consecutiveErrors`; values past the end saturate at the last entry.
// Capped further by `intervalMs` so extremely-short user intervals still
// dominate the schedule.
export const BACKOFF_SCHEDULE_MS: readonly number[] = [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
