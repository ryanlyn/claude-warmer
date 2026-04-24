/**
 * Composed-system regression tests for B1 (refresh strips auto-selection)
 * and B3 (long tick clobbers refresh updates). These drive
 * App+Scheduler+reducer together through real-ish timer sequences so
 * regressions in the glue layer break them, not just unit-level reducer
 * changes.
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

describe('integration: documented bug reproducers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('B1: a session created mid-run is eventually warmed', async () => {
    // User launches the TUI with one existing warm session, turns warming on,
    // then starts a NEW claude session a few minutes later. With B1 fixed,
    // mergeRefresh preserves discovery's `selected: isWarm`, so the new
    // session joins the schedule and gets warmed during the 2-hour window.
    const t0 = new Date('2026-04-20T12:00:00Z');
    vi.setSystemTime(t0);

    const fs = new InMemoryFs();
    fs.addFile(
      '.claude/projects/proj/existing.jsonl',
      buildJsonl({ projectDir: 'proj', sessionId: 'existing', lastAssistantAt: t0 }),
    );

    const calls: WarmCall[] = [];
    const warmFn = makeFakeWarmer({ onCall: (c) => calls.push(c), getClockNow: () => Date.now() });

    const { stdin, unmount } = render(
      React.createElement(App, {
        intervalMinutes: 55,
        warmPrompt: "Reply 'ok'",
        deps: { fs, warmFn, random: () => 0 },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);

    stdin.write('\r'); // start warming — only `existing` is currently selected
    await vi.advanceTimersByTimeAsync(100);

    // After 5 min, a fresh session appears on the next refresh.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const t1 = new Date(Date.now());
    fs.addFile(
      '.claude/projects/proj/new.jsonl',
      buildJsonl({ projectDir: 'proj', sessionId: 'new', lastAssistantAt: t1 }),
    );

    // Walk 2h so the new session would have been warmed twice if selected.
    for (let elapsed = 0; elapsed < 2 * 60 * 60 * 1000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    // Expected correct behavior: 'new' is warmed at least once.
    // Actual: zero warms against 'new'.
    const newCalls = calls.filter((c) => c.sessionId === 'new');
    expect(newCalls.length).toBeGreaterThanOrEqual(1);

    unmount();
  }, 20_000);

  it('B3: a new session arriving mid-tick survives the tick result', async () => {
    // Tick fires, warmFn is in flight for many seconds, refresh adds a new
    // session during that window. With B3 fixed, TICK_RESULT merges by
    // sessionId so the refresh-added session survives the tick result.
    const t0 = new Date('2026-04-20T12:00:00Z');
    vi.setSystemTime(t0);

    const fs = new InMemoryFs();
    // Existing session warm (so it's auto-selected on discovery) but with a
    // cold enough anchor that bootstrap schedules it for immediate warming.
    fs.addFile(
      '.claude/projects/proj/a.jsonl',
      buildJsonl({
        projectDir: 'proj',
        sessionId: 'a',
        lastAssistantAt: new Date(t0.getTime() - 30 * 60 * 1000),
      }),
    );

    let resolveWarm: (value: {
      sessionId: string;
      usage: {
        inputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        outputTokens: number;
      };
      model: string;
      costUsd: number;
      error: string | null;
    }) => void = () => {};
    const warmFn = async () =>
      new Promise<{
        sessionId: string;
        usage: {
          inputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          outputTokens: number;
        };
        model: string;
        costUsd: number;
        error: string | null;
      }>((resolve) => {
        resolveWarm = resolve;
      });

    const { stdin, lastFrame, unmount } = render(
      React.createElement(App, {
        intervalMinutes: 55,
        warmPrompt: "Reply 'ok'",
        // random:0 — bootstrap picks the earliest slot in [now, windowEnd].
        deps: { fs, warmFn, random: () => 0 },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);

    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(50);

    // Walk forward enough for 'a' to be due AND the tick to fire.
    // Bootstrap set nextWarmAt to roughly now; first tick fires at t+30s.
    await vi.advanceTimersByTimeAsync(30_000);

    // A new session now appears on the next refresh, while the first warm
    // is still in flight.
    fs.addFile(
      '.claude/projects/proj/brand-new.jsonl',
      buildJsonl({
        projectDir: 'proj',
        sessionId: 'brand-new',
        lastAssistantAt: new Date(Date.now()),
        customTitle: 'BrandNewArrival',
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000); // refresh fires, picks up new

    // Sanity: at this point brand-new has been rendered via refresh.
    expect(lastFrame()).toContain('BrandNewArrival');

    // Resolve the in-flight warm. TICK_RESULT replaces the sessions list
    // with the stale-snapshot-derived `updated` that only contained 'a'.
    resolveWarm({
      sessionId: 'a',
      usage: { inputTokens: 0, cacheReadInputTokens: 80_000, cacheCreationInputTokens: 1_000, outputTokens: 3 },
      model: 'claude-sonnet-4-6',
      costUsd: 0.004,
      error: null,
    });
    await vi.advanceTimersByTimeAsync(100);

    // Expected correct behavior: BrandNewArrival still rendered.
    // Under B3 it is clobbered and this assertion fails.
    expect(lastFrame()).toContain('BrandNewArrival');

    unmount();
  }, 20_000);
});
