/**
 * Flagship integration test: drives the full composed system (App + reducer
 * + Scheduler + injected warmer) through 11 simulated hours and asserts
 * that a selected warm session actually gets warmed on the expected cadence.
 */
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeTime } from '@std/testing/time';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.tsx';
import { buildJsonl, InMemoryFs, makeFakeWarmer, type WarmCall } from './harness.ts';

function CapturingTextInput(
  { defaultValue }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode },
) {
  return React.createElement('ink-text', null, `[TextInput:${defaultValue ?? ''}]`);
}

describe({ name: 'integration: warming over simulated time', sanitizeOps: false, sanitizeResources: false }, () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime(new Date('2026-04-20T12:11:00Z'));
  });

  afterEach(() => {
    time.restore();
  });

  it('warms a selected warm session repeatedly across 11 simulated hours', async () => {
    const now = new Date(Date.now());
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

    const r = render(
      React.createElement(App, {
        intervalMinutes: 55,
        warmPrompt: "Reply 'ok'",
        deps: { fs, warmFn, random: () => 0, copyToClipboard: () => {}, TextInput: CapturingTextInput },
      }),
    );

    await time.tickAsync(100);
    expect(r.lastFrame()).toContain('The fd23508e session');

    r.stdin.write('\r');
    await time.tickAsync(100);

    const ELEVEN_HOURS_MS = 11 * 60 * 60 * 1000;
    const STEP_MS = 30_000;
    for (let elapsed = 0; elapsed < ELEVEN_HOURS_MS; elapsed += STEP_MS) {
      await time.tickAsync(STEP_MS);
    }

    const expectedMin = 10;
    expect(calls.length).toBeGreaterThanOrEqual(expectedMin);
    expect(calls.every((c) => c.sessionId === 'fd23508e')).toBe(true);
    for (let i = 1; i < calls.length; i++) {
      const delta = calls[i].at - calls[i - 1].at;
      expect(delta).toBeGreaterThanOrEqual(50 * 60 * 1000);
      expect(delta).toBeLessThanOrEqual(60 * 60 * 1000);
    }

    r.unmount();
  });

  it('never fires a warm when the user never toggles warming on', async () => {
    const now = new Date(Date.now());
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

    const r = render(
      React.createElement(App, {
        intervalMinutes: 55,
        warmPrompt: "Reply 'ok'",
        deps: { fs, warmFn, random: () => 0, copyToClipboard: () => {}, TextInput: CapturingTextInput },
      }),
    );

    await time.tickAsync(100);
    for (let elapsed = 0; elapsed < 11 * 60 * 60 * 1000; elapsed += 30_000) {
      await time.tickAsync(30_000);
    }

    expect(calls).toHaveLength(0);
    r.unmount();
  });
});
