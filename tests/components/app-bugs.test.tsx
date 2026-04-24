/**
 * Reproducer tests for hypothesized app-level bugs that can cause
 * sessions to drop out of state / warms to be skipped.
 */
import React, { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.js';
import * as sessionsModule from '../../src/lib/sessions.js';
import * as warmerModule from '../../src/lib/warmer.js';

vi.mock('../../src/lib/sessions.js');
vi.mock('../../src/lib/warmer.js');
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

vi.mock('@inkjs/ui', () => ({
  TextInput: ({ defaultValue }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode }) =>
    React.createElement('ink-text', null, `[TextInput:${defaultValue ?? ''}]`),
}));

const mockSessions = vi.mocked(sessionsModule);

function coldSelectedSession(id: string, name: string) {
  return {
    sessionId: id,
    name,
    projectDir: 'test',
    cwd: '/test',
    model: 'claude-opus-4-6',
    lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
    isWarm: false,
    isLive: false,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    expiryCostUsd: 0,
    selected: true,
    warmingStatus: 'idle' as const,
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('App bug reproducers', () => {
  /**
   * H2: During the `await schedulerRef.current.tick(snapshot, ...)` that can
   * run for minutes, the 30s refresh interval fires and writes fresh
   * sessions via `setSessions(fresh...)`. When tick resolves, app.tsx
   * line 194 calls `setSessions(updated)` using the pre-tick snapshot,
   * overwriting any new sessions or refreshed fields added in the meantime.
   *
   * Reproducer strategy:
   *   - warmSession takes a long time (blocking tick's await)
   *   - during that await, the 30s refresh returns a NEW session
   *   - when tick finishes, the new session must still be present
   */
  // B3 regression test: when a long tick resolves, the merge keeps any
  // sessions that the 30s refresh added while the warm was in flight,
  // rather than clobbering them with the stale pre-tick snapshot.
  it('H2: long tick preserves session added by refresh during its await', async () => {
    vi.useFakeTimers();

    // Start with one cold, selected session - it will be due immediately
    const s1 = coldSelectedSession('s1', 'Session One');
    mockSessions.discoverSessions.mockReturnValue([s1]);

    // Make warmSession take 5 minutes (blocks the tick await)
    let resolveWarm: (v: unknown) => void = () => {};
    vi.mocked(warmerModule.warmSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWarm = resolve;
        }),
    );

    const { lastFrame, stdin, unmount } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await vi.advanceTimersByTimeAsync(50);

    // Turn warming on. Bootstrap makes s1 (cold) due at `now`.
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(50);

    // Advance 30s to hit first tick. This triggers warmFn, which hangs.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10);

    // While tick is still awaiting warmFn, refresh fires (at ~30s intervals)
    // and adds a new session. Swap discoverSessions result BEFORE advancing.
    const s2 = coldSelectedSession('s2', 'Brand New Session');
    mockSessions.discoverSessions.mockReturnValue([s1, s2]);

    // Trigger the refresh interval
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10);

    // At this point, the new session should be visible (refresh wrote it).
    expect(lastFrame()!).toContain('Brand New Session');

    // Now let the tick's warmFn resolve. tick calls setSessions(updated)
    // with its snapshot that predates s2 - s2 should get clobbered.
    resolveWarm({
      sessionId: 's1',
      usage: { inputTokens: 0, cacheReadInputTokens: 80_000, cacheCreationInputTokens: 1_000, outputTokens: 3 },
      model: 'claude-opus-4-6',
      costUsd: 0.04,
      error: null,
    });
    await vi.advanceTimersByTimeAsync(50);

    // BUG: brand new session should still be visible, but tick clobbered it.
    expect(lastFrame()!).toContain('Brand New Session');

    unmount();
    vi.useRealTimers();
  });
});
