/**
 * Flagship integration test: drives the full composed system (App + reducer
 * + Scheduler + injected warmer) through 11 simulated hours and asserts
 * that a selected warm session actually gets warmed on the expected cadence.
 *
 * Had a test of this shape existed when `fd23508e` was being debugged, the
 * "11-hour silent miss" bug would have failed CI immediately — the whole
 * point of this tier.
 */
import React, { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.js';
import { InMemoryFs, buildJsonl, makeFakeWarmer, type WarmCall } from './harness.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('@inkjs/ui', () => ({
  TextInput: ({ defaultValue }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode }) =>
    React.createElement('ink-text', null, `[TextInput:${defaultValue ?? ''}]`),
}));

describe('integration: warming over simulated time', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('warms a selected warm session repeatedly across 11 simulated hours', async () => {
    // Seed the in-memory fs with a single warm session whose most recent
    // assistant message is 1 minute old — so `discoverSessions` marks
    // `isWarm:true` and `selected:true`.
    const now = new Date('2026-04-20T12:11:00Z');
    vi.setSystemTime(now);
    const fs = new InMemoryFs();
    fs.addFile(
      '.claude/projects/-Users-ryan-dev/fd23508e.jsonl',
      buildJsonl({
        projectDir: '-Users-ryan-dev',
        sessionId: 'fd23508e',
        cacheReadTokens: 38_000,
        cacheWriteTokens: 0,
        lastAssistantAt: now,
        customTitle: 'The fd23508e session',
      }),
    );

    const calls: WarmCall[] = [];
    const warmFn = makeFakeWarmer({
      onCall: (c) => calls.push(c),
      getClockNow: () => Date.now(),
    });

    const { stdin, lastFrame, unmount } = render(
      React.createElement(App, {
        intervalMinutes: 55,
        warmPrompt: "Reply 'ok'",
        deps: { fs, warmFn, random: () => 0 }, // random:0 → warms at earliest slot
      }),
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(lastFrame()).toContain('The fd23508e session');

    // Turn warming on.
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(100);

    // Advance 11 hours in ~30s steps so every refresh AND every tick fires.
    const ELEVEN_HOURS_MS = 11 * 60 * 60 * 1000;
    const STEP_MS = 30_000;
    for (let elapsed = 0; elapsed < ELEVEN_HOURS_MS; elapsed += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
    }

    // Baseline expectation: 11h @ 55min interval ≈ 12 warms. Allow a small
    // slack for boundary rounding. Zero warms (the fd23508e symptom) fails
    // loudly.
    const expectedMin = 10;
    expect(calls.length).toBeGreaterThanOrEqual(expectedMin);
    expect(calls.every((c) => c.sessionId === 'fd23508e')).toBe(true);
    // Each subsequent warm should fire ~55 min after the previous one.
    for (let i = 1; i < calls.length; i++) {
      const delta = calls[i].at - calls[i - 1].at;
      expect(delta).toBeGreaterThanOrEqual(50 * 60 * 1000);
      expect(delta).toBeLessThanOrEqual(60 * 60 * 1000);
    }

    unmount();
  }, 20_000);

  it('never fires a warm when the user never toggles warming on (fd23508e failure mode)', async () => {
    // Same seed, but DON'T press Enter. Confirms the fd23508e-style
    // "TUI was up but warming was off" scenario produces zero warms.
    const now = new Date('2026-04-20T12:11:00Z');
    vi.setSystemTime(now);
    const fs = new InMemoryFs();
    fs.addFile(
      '.claude/projects/-Users-ryan-dev/fd23508e.jsonl',
      buildJsonl({
        projectDir: '-Users-ryan-dev',
        sessionId: 'fd23508e',
        lastAssistantAt: now,
      }),
    );
    const calls: WarmCall[] = [];
    const warmFn = makeFakeWarmer({ onCall: (c) => calls.push(c), getClockNow: () => Date.now() });

    const { unmount } = render(
      React.createElement(App, {
        intervalMinutes: 55,
        warmPrompt: "Reply 'ok'",
        deps: { fs, warmFn, random: () => 0 },
      }),
    );

    await vi.advanceTimersByTimeAsync(100);
    // Walk 11h without starting warming.
    for (let elapsed = 0; elapsed < 11 * 60 * 60 * 1000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(calls).toHaveLength(0);
    unmount();
  }, 20_000);
});
