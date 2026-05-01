import { describe, expect, it } from 'vitest';
import { canWarmSession, markSessionUnwarmable } from '../../src/lib/session-policy.js';
import type { Session } from '../../src/lib/types.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'id-1',
    name: 'Test',
    projectDir: 'proj',
    cwd: '/proj',
    model: 'claude-sonnet-4-6',
    lastAssistantTimestamp: 0,
    isWarm: true,
    isLive: false,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    expiryCostUsd: 0,
    selected: false,
    warmStatus: 'idle',
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
    ...overrides,
  };
}

describe('canWarmSession', () => {
  it('allows live sessions to be warmed', () => {
    expect(canWarmSession({ isLive: true })).toBe(true);
  });

  it('blocks closed sessions from being warmed even when they are warm by timestamp', () => {
    expect(canWarmSession({ isLive: false })).toBe(false);
  });
});

describe('markSessionUnwarmable', () => {
  it('returns already inert sessions by reference', () => {
    const inert = session();
    expect(markSessionUnwarmable(inert)).toBe(inert);
  });

  it('clears selection, schedule, and in-flight status', () => {
    expect(markSessionUnwarmable(session({ selected: true, nextWarmAt: 1234, warmStatus: 'warming' }))).toMatchObject({
      selected: false,
      nextWarmAt: null,
      warmStatus: 'idle',
    });
  });
});
