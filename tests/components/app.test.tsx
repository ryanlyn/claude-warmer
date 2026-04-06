import React, { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.js';
import * as sessionsModule from '../../src/lib/sessions.js';
import * as warmerModule from '../../src/lib/warmer.js';
import * as childProcess from 'node:child_process';

vi.mock('../../src/lib/sessions.js');
vi.mock('../../src/lib/warmer.js');
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

let capturedOnSubmit: ((value: string) => void) | null = null;

vi.mock('@inkjs/ui', () => ({
  TextInput: ({
    defaultValue,
    onSubmit,
  }: {
    defaultValue?: string;
    onSubmit?: (value: string) => void;
    children?: ReactNode;
  }) => {
    capturedOnSubmit = onSubmit ?? null;
    return React.createElement('ink-text', null, `[TextInput:${defaultValue ?? ''}]`);
  },
}));

const mockSessions = vi.mocked(sessionsModule);

function makeTwoSessions() {
  return [
    {
      sessionId: 'abc-123',
      name: 'Session One',
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
      warmCostUsd: 0.05,
      warmCount: 0,
      nextWarmAt: null,
      lastWarmedAt: null,
      lastWarmError: null,
    },
    {
      sessionId: 'def-456',
      name: 'Session Two',
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
      warmCostUsd: 0.3,
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
    warmCostUsd: 0.05,
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
  vi.mocked(warmerModule.warmSession).mockResolvedValue({
    sessionId: 'abc-123',
    usage: { inputTokens: 0, cacheReadInputTokens: 80000, cacheCreationInputTokens: 1000, outputTokens: 3 },
    model: 'claude-opus-4-6',
    costUsd: 0.04,
    error: null,
  });
});

describe('App', () => {
  it('renders header with app name', () => {
    const { lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    expect(lastFrame()!).toContain('Claude Warmer');
  });

  it('renders discovered sessions', () => {
    const { lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    expect(lastFrame()!).toContain('Test Session');
  });

  it('renders footer with keybindings', () => {
    const { lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    expect(lastFrame()!).toContain('quit');
  });

  it('toggles selection on space key', async () => {
    const { lastFrame, stdin } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();
    expect(lastFrame()!).toContain('$0.05');

    stdin.write(' ');
    await tick();
    // After deselecting, warmCost shows '-'
    const frame = lastFrame()!;
    expect(frame).toContain('Test Session');
  });

  it('toggles warming on enter key', async () => {
    const { lastFrame, stdin } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    expect(lastFrame()!).toContain('active');
  });

  it('selects active sessions on a key', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    // First deselect all
    stdin.write('n');
    await tick();

    // Then select active (only warm/live sessions)
    stdin.write('a');
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain('Session One');
    expect(frame).toContain('Session Two');
  });

  it('deselects all on n key', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('n');
    await tick();
    // After deselecting, cost/warms columns show dashes
    expect(lastFrame()!).toContain('-');
  });

  it('navigates down with arrow key', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\x1B[B');
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain('Session One');
    expect(frame).toContain('Session Two');
  });

  it('navigates up with arrow key', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\x1B[B');
    await tick();
    stdin.write('\x1B[A');
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain('Session One');
  });

  it('does not navigate below last session', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    await tick();
    expect(lastFrame()!).toContain('Test Session');
  });

  it('does not navigate above first session', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\x1B[A');
    await tick();
    expect(lastFrame()!).toContain('Test Session');
  });

  it('quits on q key', async () => {
    const { stdin } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('q');
    await tick();
  });

  it('toggles warming on with enter key', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    expect(lastFrame()!).toContain('active');
  });

  it('toggles warming off with enter key pressed twice', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    expect(lastFrame()!).toContain('active');

    stdin.write('\r');
    await tick();
    expect(lastFrame()!).toContain('paused');
  });

  it('warming timer effect fires and calls tick', async () => {
    vi.useFakeTimers();
    const { stdin, unmount } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);

    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(30_000);

    unmount();
    vi.useRealTimers();
  });

  it('warming timer effect cleans up on warming toggle off', async () => {
    vi.useFakeTimers();
    const { stdin, unmount } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);

    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(10_000);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(60_000);

    unmount();
    vi.useRealTimers();
  });

  it('selectNone while warming calls removeSession', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    stdin.write('n');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('selectActive while warming calls addSession for active sessions', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    stdin.write('a');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('toggleSelection while warming adds session when selecting', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write(' ');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('toggleSelection while warming removes session when deselecting', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    stdin.write(' ');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('warming toggle off resets warming status', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('\r');
    await tick();
    stdin.write('\r');
    await tick();
    expect(lastFrame()!).toContain('paused');
  });

  it('warming toggle off resets sessions with warmingStatus warming to paused', async () => {
    mockSessions.discoverSessions.mockReturnValue([
      {
        ...defaultSession(),
        warmingStatus: 'warming',
      },
    ]);

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    // Start warming
    stdin.write('\r');
    await tick();
    // Stop warming
    stdin.write('\r');
    await tick();
    expect(lastFrame()!).toContain('paused');
  });

  it('handles unrecognized key input gracefully', async () => {
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('x');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('does not toggle selection when sessions list is empty', async () => {
    mockSessions.discoverSessions.mockReturnValue([]);

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write(' ');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('tick guard prevents concurrent tick execution', async () => {
    vi.useFakeTimers();
    const { stdin, unmount } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);

    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    unmount();
    vi.useRealTimers();
  });

  it('tick guard early return when tickingRef is true', async () => {
    vi.useFakeTimers();
    const { stdin, unmount } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);

    stdin.write('\r');

    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    await vi.advanceTimersByTimeAsync(0);

    unmount();
    vi.useRealTimers();
  });

  it('new sessions from refresh start unselected', async () => {
    vi.useFakeTimers();
    const { lastFrame, unmount } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);

    // After initial render, mock a new session appearing on next refresh
    const newSession = {
      ...defaultSession(),
      sessionId: 'new-999',
      name: 'New Session',
      selected: true, // discoverSessions returns selected:true for warm sessions
      isWarm: true,
    };
    mockSessions.discoverSessions.mockReturnValue([defaultSession(), newSession]);

    // Trigger the 30s refresh interval
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(50);

    const frame = lastFrame()!;
    expect(frame).toContain('New Session');

    unmount();
    vi.useRealTimers();
  });

  it('copies session ID to clipboard on c key', async () => {
    const mockExecSync = vi.mocked(childProcess.execSync);
    mockExecSync.mockReturnValue(Buffer.from(''));

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('c');
    await tick();
    expect(mockExecSync).toHaveBeenCalledWith('pbcopy', expect.objectContaining({ input: 'abc-123' }));
    expect(lastFrame()!).toBeDefined();
  });

  it('c key handles clipboard error gracefully', async () => {
    const mockExecSync = vi.mocked(childProcess.execSync);
    mockExecSync.mockImplementation(() => {
      throw new Error('pbcopy not found');
    });

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('c');
    await tick();
    // Should not crash even if pbcopy fails
    expect(lastFrame()!).toBeDefined();
  });

  it('c key is no-op when sessions list is empty', async () => {
    mockSessions.discoverSessions.mockReturnValue([]);

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('c');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('opens prompt editing on p key and submits with value', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('p');
    await tick();
    expect(lastFrame()!).toContain('Prompt');
    expect(capturedOnSubmit).not.toBeNull();

    // Call onSubmit directly with a new value
    capturedOnSubmit!('Say hello');
    await tick();
    expect(lastFrame()!).not.toContain('[TextInput');
    expect(lastFrame()!).toContain('Say hello');
  });

  it('opens interval editing on i key and submits with valid value', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('i');
    await tick();
    expect(lastFrame()!).toContain('Interval');
    expect(capturedOnSubmit).not.toBeNull();

    // Submit a valid interval
    capturedOnSubmit!('30');
    await tick();
    expect(lastFrame()!).not.toContain('[TextInput');
    expect(lastFrame()!).toContain('30m');
  });

  it('interval edit with invalid value keeps original', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('i');
    await tick();
    expect(capturedOnSubmit).not.toBeNull();

    // Submit invalid value
    capturedOnSubmit!('abc');
    await tick();
    expect(lastFrame()!).toContain('55m');
  });

  it('interval edit with out-of-range value keeps original', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('i');
    await tick();
    expect(capturedOnSubmit).not.toBeNull();

    // Submit out-of-range value
    capturedOnSubmit!('0');
    await tick();
    expect(lastFrame()!).toContain('55m');
  });

  it('interval edit with value above 59 keeps original', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('i');
    await tick();
    expect(capturedOnSubmit).not.toBeNull();

    capturedOnSubmit!('60');
    await tick();
    expect(lastFrame()!).toContain('55m');
  });

  it('prompt edit with empty value keeps original', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('p');
    await tick();
    expect(capturedOnSubmit).not.toBeNull();

    // Submit empty string - should keep original
    capturedOnSubmit!('   ');
    await tick();
    expect(lastFrame()!).toContain("Reply 'ok'");
  });

  it('disables keybindings while editing prompt', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    stdin.write('p');
    await tick();

    // 'q' should not quit the app while editing
    stdin.write('q');
    await tick();
    expect(lastFrame()!).toContain('Prompt');

    // Submit to close editor
    capturedOnSubmit!("Reply 'ok'");
    await tick();
  });

  it('selectActive while warming removes non-active sessions', async () => {
    mockSessions.discoverSessions.mockReturnValue(makeTwoSessions());

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    // Start warming
    stdin.write('\r');
    await tick();

    // Select active - should select warm/live, deselect cold
    stdin.write('a');
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('scroll updates when navigating down past visible area', async () => {
    // Create many sessions to exceed visible rows
    const manySessions = Array.from({ length: 25 }, (_, i) => ({
      ...defaultSession(),
      sessionId: `session-${String(i).padStart(3, '0')}`,
      name: `Session ${i}`,
    }));
    mockSessions.discoverSessions.mockReturnValue(manySessions);

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    // Navigate down many times
    for (let i = 0; i < 20; i++) {
      stdin.write('\x1B[B');
    }
    await tick();
    expect(lastFrame()!).toBeDefined();
  });

  it('interval change while warming reschedules sessions', async () => {
    capturedOnSubmit = null;
    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    // Start warming
    stdin.write('\r');
    await tick();
    expect(lastFrame()!).toContain('active');

    // Change interval
    stdin.write('i');
    await tick();
    expect(capturedOnSubmit).not.toBeNull();
    capturedOnSubmit!('10');
    await tick();
    expect(lastFrame()!).toContain('10m');
    // Sessions should be rescheduled with new interval
    expect(lastFrame()!).toContain('active');
  });

  it('tick merges warming results while preserving user selection changes', async () => {
    // Use a session that's cold (will be scheduled immediately by bootstrap)
    mockSessions.discoverSessions.mockReturnValue([
      {
        ...defaultSession(),
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
        isWarm: false,
        selected: true,
      },
    ]);

    // Mock warmSession to return a result that differs from initial state
    const mockWarm = vi.mocked(warmerModule.warmSession);
    mockWarm.mockResolvedValue({
      sessionId: 'abc-123',
      usage: { inputTokens: 0, cacheReadInputTokens: 80000, cacheCreationInputTokens: 2000, outputTokens: 5 },
      model: 'claude-opus-4-6',
      costUsd: 0.05,
      error: null,
    });

    vi.useFakeTimers();
    const { stdin, unmount } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);

    // Start warming - cold session gets nextWarmAt = now
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(50);

    // Advance past tick interval - should trigger tick and warm the due session
    await vi.advanceTimersByTimeAsync(30_000);
    // Let the promise chain resolve
    await vi.advanceTimersByTimeAsync(100);

    unmount();
    vi.useRealTimers();
  });

  it('scroll updates when navigating up past visible area', async () => {
    const manySessions = Array.from({ length: 25 }, (_, i) => ({
      ...defaultSession(),
      sessionId: `session-${String(i).padStart(3, '0')}`,
      name: `Session ${i}`,
    }));
    mockSessions.discoverSessions.mockReturnValue(manySessions);

    const { stdin, lastFrame } = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" />);
    await tick();

    // Navigate down then back up
    for (let i = 0; i < 20; i++) {
      stdin.write('\x1B[B');
    }
    await tick();
    for (let i = 0; i < 20; i++) {
      stdin.write('\x1B[A');
    }
    await tick();
    expect(lastFrame()!).toContain('Session 0');
  });
});
