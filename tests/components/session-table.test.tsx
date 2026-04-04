import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SessionTable } from '../../src/components/session-table.js';
import type { Session } from '../../src/lib/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'abc-123',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-opus-4-6',
    lastAssistantTimestamp: Date.now(),
    isWarm: true,
    isLive: false,
    cacheReadTokens: 50000,
    cacheWriteTokens: 1000,
    expiryCostUsd: 0.5,
    selected: true,
    warmingStatus: 'idle',
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
    ...overrides,
  };
}

describe('SessionTable', () => {
  it('renders column headers', () => {
    const { lastFrame } = render(
      <SessionTable sessions={[]} highlightedIndex={0} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Session Name');
    expect(frame).toContain('Model');
    expect(frame).toContain('Cached');
    expect(frame).toContain('Expiry Cost');
    expect(frame).toContain('Warm Cost');
    expect(frame).toContain('Warms');
    expect(frame).toContain('Next Warm');
    expect(frame).toContain('Status');
  });

  it('renders session rows', () => {
    const sessions = [
      makeSession({ sessionId: 'a', name: 'Session Alpha' }),
      makeSession({ sessionId: 'b', name: 'Session Beta' }),
    ];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} highlightedIndex={0} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Session Alpha');
    expect(frame).toContain('Session Beta');
  });

  it('shows empty state when no sessions', () => {
    const { lastFrame } = render(
      <SessionTable sessions={[]} highlightedIndex={0} />,
    );
    expect(lastFrame()!).toContain('No sessions found');
  });
});
