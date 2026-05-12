/**
 * Composed-system tests for session arrivals that happen after the TUI is
 * already warming.
 */
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeTime } from '@std/testing/time';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.tsx';
import { buildJsonl, InMemoryFs, makeFakeWarmer, type WarmCall } from './harness.ts';
import type { WarmResult } from '../../src/lib/types.ts';

function CapturingTextInput(
  { defaultValue }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode },
) {
  return React.createElement('ink-text', null, `[TextInput:${defaultValue ?? ''}]`);
}

describe({
  name: 'integration: sessions arriving mid-run',
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime(new Date('2026-04-20T12:00:00Z'));
  });

  afterEach(() => {
    time.restore();
  });

  it('a session created after warming starts is eventually warmed', async () => {
    const t0 = new Date(Date.now());
    const fs = new InMemoryFs();
    fs.addFile(
      '.claude/projects/proj/existing.jsonl',
      buildJsonl({ projectDir: 'proj', sessionId: 'existing', lastAssistantAt: t0 }),
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

    r.stdin.write('\r');
    await time.tickAsync(100);

    await time.tickAsync(5 * 60 * 1000);
    const t1 = new Date(Date.now());
    fs.addFile(
      '.claude/projects/proj/new.jsonl',
      buildJsonl({ projectDir: 'proj', sessionId: 'new', lastAssistantAt: t1 }),
    );

    for (let elapsed = 0; elapsed < 2 * 60 * 60 * 1000; elapsed += 30_000) {
      await time.tickAsync(30_000);
    }

    const newCalls = calls.filter((c) => c.sessionId === 'new');
    expect(newCalls.length).toBeGreaterThanOrEqual(1);

    r.unmount();
  });

  it('a session added by refresh is not clobbered by an in-flight tick result', async () => {
    const t0 = new Date(Date.now());
    const fs = new InMemoryFs();
    fs.addFile(
      '.claude/projects/proj/a.jsonl',
      buildJsonl({
        projectDir: 'proj',
        sessionId: 'a',
        lastAssistantAt: new Date(t0.getTime() - 50 * 60 * 1000),
      }),
    );

    let resolveWarm: (value: WarmResult) => void = () => {};
    const warmFn = () =>
      new Promise<WarmResult>((resolve) => {
        resolveWarm = resolve;
      });

    const r = render(
      React.createElement(App, {
        intervalMinutes: 55,
        warmPrompt: "Reply 'ok'",
        deps: { fs, warmFn, random: () => 0, copyToClipboard: () => {}, TextInput: CapturingTextInput },
      }),
    );
    await time.tickAsync(100);

    r.stdin.write('\r');
    await time.tickAsync(50);

    await time.tickAsync(30_000);

    fs.addFile(
      '.claude/projects/proj/brand-new.jsonl',
      buildJsonl({
        projectDir: 'proj',
        sessionId: 'brand-new',
        lastAssistantAt: new Date(Date.now()),
        customTitle: 'BrandNewArrival',
      }),
    );
    await time.tickAsync(30_000);

    expect(r.lastFrame()).toContain('BrandNewArrival');

    resolveWarm({
      sessionId: 'a',
      usage: { inputTokens: 0, cacheReadInputTokens: 80_000, cacheCreationInputTokens: 1_000, outputTokens: 3 },
      model: 'claude-sonnet-4-6',
      costUsd: 0.004,
      error: null,
    });
    await time.tickAsync(100);

    expect(r.lastFrame()).toContain('BrandNewArrival');

    r.unmount();
  });
});
