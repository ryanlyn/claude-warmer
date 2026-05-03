/**
 * Composed-system tests for session arrivals that happen after the TUI is
 * already warming. Drives App + Scheduler + reducer together through real-ish
 * timer sequences so regressions in the glue layer break here, not just at the
 * unit-reducer level.
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

describe('integration: sessions arriving mid-run', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('a session created after warming starts is eventually warmed', async () => {
    // User launches the TUI with one existing warm session, turns warming on,
    // then starts a NEW claude session a few minutes later. The discovery
    // refresh must preserve `selected: isWarm` for the new session so it joins
    // the schedule and gets warmed within the 2-hour window.
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

    stdin.write('\r'); // start warming - only `existing` is currently selected
    await vi.advanceTimersByTimeAsync(100);

    // After 5 min, a fresh session appears on the next refresh.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const t1 = new Date(Date.now());
    fs.addFile(
      '.claude/projects/proj/new.jsonl',
      buildJsonl({ projectDir: 'proj', sessionId: 'new', lastAssistantAt: t1 }),
    );

    // Walk 2h so the new session would have been warmed at least once if selected.
    for (let elapsed = 0; elapsed < 2 * 60 * 60 * 1000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    const newCalls = calls.filter((c) => c.sessionId === 'new');
    expect(newCalls.length).toBeGreaterThanOrEqual(1);

    unmount();
  }, 20_000);

  it('a session added by refresh is not clobbered by an in-flight tick result', async () => {
    // Tick fires, warmFn is in flight for many seconds, refresh adds a new
    // session during that window. The warm result must apply narrow patches to
    // the warmed session so the refresh-added session survives.
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
        // random:0 - bootstrap picks the earliest slot in [now, windowEnd].
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

    // Resolve the in-flight warm. Warm patches should update 'a' without
    // replacing the full session list that now also contains the new session.
    resolveWarm({
      sessionId: 'a',
      usage: { inputTokens: 0, cacheReadInputTokens: 80_000, cacheCreationInputTokens: 1_000, outputTokens: 3 },
      model: 'claude-sonnet-4-6',
      costUsd: 0.004,
      error: null,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(lastFrame()).toContain('BrandNewArrival');

    unmount();
  }, 20_000);
});
