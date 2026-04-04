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
      <SessionTable sessions={[]} highlightedIndex={0} scrollOffset={0} nameWidth={20} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Session Name');
    expect(frame).toContain('Model');
    expect(frame).toContain('Cached');
    expect(frame).toContain('Expiry');
    expect(frame).toContain('Est. Cost');
    expect(frame).toContain('Warms');
    expect(frame).toContain('Next');
    expect(frame).toContain('Status');
    expect(frame).toContain('ID');
  });

  it('renders session rows', () => {
    const sessions = [
      makeSession({ sessionId: 'aaaaaaaa-1', name: 'Session Alpha' }),
      makeSession({ sessionId: 'bbbbbbbb-2', name: 'Session Beta' }),
    ];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} highlightedIndex={0} scrollOffset={0} nameWidth={20} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Session Alpha');
    expect(frame).toContain('Session Beta');
  });

  it('shows empty state when no sessions', () => {
    const { lastFrame } = render(
      <SessionTable sessions={[]} highlightedIndex={0} scrollOffset={0} nameWidth={20} />,
    );
    expect(lastFrame()!).toContain('No sessions found');
  });

  it('respects scrollOffset and shows visible slice', () => {
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession({ sessionId: `session-${String(i).padStart(3, '0')}`, name: `Session ${i}` }),
    );
    const { lastFrame } = render(
      <SessionTable sessions={sessions} highlightedIndex={5} scrollOffset={5} nameWidth={20} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Session 5');
  });

  it('highlights the correct row based on highlightedIndex vs scrollOffset', () => {
    const sessions = [
      makeSession({ sessionId: 'aaaa0001', name: 'First' }),
      makeSession({ sessionId: 'bbbb0002', name: 'Second' }),
    ];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} highlightedIndex={1} scrollOffset={0} nameWidth={20} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('First');
    expect(frame).toContain('Second');
  });
});
