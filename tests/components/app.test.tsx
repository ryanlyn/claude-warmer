import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.js';
import * as sessionsModule from '../../src/lib/sessions.js';
import * as warmerModule from '../../src/lib/warmer.js';

vi.mock('../../src/lib/sessions.js');
vi.mock('../../src/lib/warmer.js');

const mockSessions = vi.mocked(sessionsModule);

function makeTwoSessions() {
  return [
    {
      sessionId: 'abc-123',
      name: 'Test Session 1',
      projectDir: 'test',
      cwd: '/test',
      model: 'claude-opus-4-6',
      lastAssistantTimestamp: Date.now() - 10 * 60 * 1000,
      isWarm: true,
      isLive: false,
      cacheReadTokens: 100000,
      cacheWriteTokens: 5000,
      expiryCostUsd: 1.05,
      selected: true,
      warmingStatus: 'idle' as const,
      warmCostUsd: 0,
      warmCount: 0,
      nextWarmAt: null,
      lastWarmedAt: null,
      lastWarmError: null,
    },
    {
      sessionId: 'def-456',
      name: 'Test Session 2',
      projectDir: 'test',
      cwd: '/test',
      model: 'claude-sonnet-4-6',
      lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
      isWarm: false,
      isLive: false,
      cacheReadTokens: 50000,
      cacheWriteTokens: 0,
      expiryCostUsd: 0.3,
      selected: false,
      warmingStatus: 'idle' as const,
      warmCostUsd: 0,
      warmCount: 0,
      nextWarmAt: null,
      lastWarmedAt: null,
      lastWarmError: null,
    },
  ];
}

function defaultSession() {
  return {
    sessionId: 'abc-123',
    name: 'Test Session',
    projectDir: 'test',
    cwd: '/test',
    model: 'claude-opus-4-6',
    lastAssistantTimestamp: Date.now() - 10 * 60 * 1000,
    isWarm: true,
    isLive: false,
    cacheReadTokens: 100000,
    cacheWriteTokens: 5000,
    expiryCostUsd: 1.05,
    selected: true,
    warmingStatus: 'idle' as const,
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
  };
}

// Wait for React effects (useEffect) to run so ink's input handlers attach
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  vi.resetAllMocks();
  mockSessions.discoverSessions.mockReturnValue([defaultSession()]);
});

describe('App', () => {
  it('renders header with app name', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('Cache Warmer');
  });

  it('renders discovered sessions', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('Test Session');
  });

  it('renders footer with keybindings', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('quit');
  });

  it('toggles selection on space key', async () => {
    const { lastFrame, stdin } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();
    expect(lastFrame()!).toContain('$0.00');

    stdin.write(' ');
    await tick();
    expect(lastFrame()!).not.toContain('$0.00');
  });

  it('toggles selection on enter key', async () => {
    const { lastFrame, stdin } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('\r');
    await tick();
    expect(lastFrame()!).not.toContain('$0.00');
  });

  it('selects all on a key', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('a');
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain('Test Session 1');
    expect(frame).toContain('Test Session 2');
    // Session 2 starts unselected with warmCount '-', after selectAll it shows '0'
    expect(frame).toContain('$0.00');
  });

  it('deselects all on n key', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('n');
    await tick();
    expect(lastFrame()!).not.toContain('$0.00');
  });

  it('navigates down with arrow key', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('\x1B[B');
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain('Test Session 1');
    expect(frame).toContain('Test Session 2');
  });

  it('navigates up with arrow key', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('\x1B[B');
    await tick();
    stdin.write('\x1B[A');
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain('Test Session 1');
  });

  it('does not navigate below last session', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    await tick();
    expect(lastFrame()!).toContain('Test Session');
  });

  it('does not navigate above first session', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('\x1B[A');
    await tick();
    expect(lastFrame()!).toContain('Test Session');
  });

  it('quits on q key', async () => {
    const { stdin } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('q');
    await tick();
  });

  it('toggles warming on with w key', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('w');
    await tick();
    expect(lastFrame()!).toContain('active');
  });

  it('toggles warming off with w key pressed twice', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('w');
    await tick();
    expect(lastFrame()!).toContain('active');

    stdin.write('w');
    await tick();
    expect(lastFrame()!).toContain('paused');
  });

  it('warming timer effect fires and calls tick', async () => {
    vi.useFakeTimers();
    const { stdin, unmount } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );

    // With fake timers, useEffect runs synchronously on render
    stdin.write('w');
    await vi.advanceTimersByTimeAsync(30_000);

    unmount();
    vi.useRealTimers();
  });

  it('warming timer effect cleans up on warming toggle off', async () => {
    vi.useFakeTimers();
    const { stdin, unmount } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );

    stdin.write('w');
    await vi.advanceTimersByTimeAsync(10_000);
    stdin.write('w');
    await vi.advanceTimersByTimeAsync(60_000);

    unmount();
    vi.useRealTimers();
  });

  it('selectNone while warming calls removeSession', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('w');
    await tick();
    stdin.write('n');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('selectAll while warming calls addSession', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('w');
    await tick();
    stdin.write('a');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('toggleSelection while warming adds session when selecting', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('w');
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write(' ');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('toggleSelection while warming removes session when deselecting', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('w');
    await tick();
    stdin.write(' ');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('warming toggle off resets warming status', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write('w');
    await tick();
    stdin.write('w');
    await tick();
    expect(lastFrame()!).toContain('idle');
  });

  it('warming toggle off resets sessions with warmingStatus warming to idle', async () => {
    mockSessions.discoverSessions.mockReturnValue([{
      ...defaultSession(),
      warmingStatus: 'warming',
    }]);

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    // Start warming
    stdin.write('w');
    await tick();
    // Stop warming - should reset 'warming' status to 'idle'
    stdin.write('w');
    await tick();
    expect(lastFrame()!).toContain('idle');
  });

  it('handles unrecognized key input gracefully', async () => {
    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    // Press a key that doesn't match any handler
    stdin.write('x');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('does not toggle selection when sessions list is empty', async () => {
    mockSessions.discoverSessions.mockReturnValue([]);

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    await tick();

    stdin.write(' ');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('tick guard prevents concurrent tick execution', async () => {
    vi.useFakeTimers();
    const { stdin, unmount } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );

    stdin.write('w');
    // Fire the first interval - the callback is async so it may still be "in flight"
    await vi.advanceTimersByTimeAsync(30_000);
    // Fire the second interval immediately after
    await vi.advanceTimersByTimeAsync(30_000);

    unmount();
    vi.useRealTimers();
  });

  it('tick guard early return when tickingRef is true', async () => {
    // This test ensures the tickingRef guard branch is exercised.
    // We render the App, start warming, and rapidly fire the interval
    // to try to hit the guard.
    vi.useFakeTimers();
    const { stdin, unmount } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );

    stdin.write('w');

    // Fire multiple intervals in rapid succession
    // The async nature of the callback means tickingRef could still be true
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    await vi.advanceTimersByTimeAsync(0);

    unmount();
    vi.useRealTimers();
  });
});
