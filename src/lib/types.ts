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
}

export interface WarmResult {
  sessionId: string;
  usage: SessionUsage;
  model: string;
  costUsd: number;
  error: string | null;
}

export interface AppConfig {
  intervalMinutes: number;
  warmPrompt: string;
  defaultModel: string;
}

export const WARM_THRESHOLD_MS = 55 * 60 * 1000;
