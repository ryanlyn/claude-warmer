import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SessionRow } from '../../src/components/session-row.js';
import type { Session } from '../../src/lib/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'abc12345-6789',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-opus-4-6',
    lastAssistantTimestamp: Date.now() - 10 * 60 * 1000,
    isWarm: true,
    isLive: false,
    cacheReadTokens: 100000,
    cacheWriteTokens: 5000,
    expiryCostUsd: 1.05,
    selected: true,
    warmingStatus: 'idle',
    warmCostUsd: 0.05,
    warmCount: 2,
    nextWarmAt: Date.now() + 12 * 60 * 1000,
    lastWarmedAt: Date.now() - 5 * 60 * 1000,
    lastWarmError: null,
    ...overrides,
  };
}

describe('SessionRow', () => {
  it('renders session name', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('Test Session');
  });

  it('shows warm indicator for warm sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isWarm: true })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('warm');
  });

  it('shows cold indicator for cold sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isWarm: false })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('cold');
  });

  it('shows live indicator for live sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isLive: true })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('live');
  });

  it('shows model short name', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('opus-4-6');
  });

  it('shows formatted cached tokens', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('105,000');
  });

  it('shows expiry cost for warm sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isWarm: true })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('$1.05');
  });

  it('shows dash for expiry cost on cold sessions', () => {
    const session = makeSession({ isWarm: false, isLive: false });
    const { lastFrame } = render(<SessionRow session={session} highlighted={false} nameWidth={20} />);
    // Cold sessions should show '-' for expiry
    const frame = lastFrame()!;
    expect(frame).toContain('-');
  });

  it('shows expiry cost for live sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isLive: true })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('$1.05');
  });

  it('shows warm cost for selected sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('$0.05');
  });

  it('shows dash for warm cost on unselected sessions', () => {
    const session = makeSession({ selected: false });
    const { lastFrame } = render(<SessionRow session={session} highlighted={false} nameWidth={20} />);
    // unselected should show '-' for cost and warms
    const frame = lastFrame()!;
    expect(frame).toContain('-');
  });

  it('shows warm count', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ warmCount: 5 })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('5');
  });

  it('shows warming status', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ warmingStatus: 'warming' })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('warming');
  });

  it('shows error status in red', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession({ warmingStatus: 'error', lastWarmError: 'timeout' })} highlighted={false} nameWidth={20} />,
    );
    expect(lastFrame()!).toContain('error');
  });

  it('shows success status in green', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession({ warmingStatus: 'success' })} highlighted={false} nameWidth={20} />,
    );
    expect(lastFrame()!).toContain('ok');
  });

  it('shows dash for next warm when not scheduled', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ nextWarmAt: null })} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('-');
  });

  it('shows next warm countdown', () => {
    const session = makeSession({ nextWarmAt: Date.now() + 12 * 60 * 1000 });
    const { lastFrame } = render(<SessionRow session={session} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('12m');
  });

  it('shows first 8 chars of session ID', () => {
    const session = makeSession({ sessionId: 'abcdefgh-1234-5678' });
    const { lastFrame } = render(<SessionRow session={session} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('abcdefgh');
  });

  it('shows now for expired countdown', () => {
    const session = makeSession({ nextWarmAt: Date.now() - 1000 });
    const { lastFrame } = render(<SessionRow session={session} highlighted={false} nameWidth={20} />);
    expect(lastFrame()!).toContain('now');
  });
});
