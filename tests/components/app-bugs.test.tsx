/**
 * Reproducer tests for hypothesized app-level bugs that can cause
 * sessions to drop out of state / warms to be skipped.
 */
import React, { type ReactNode } from 'react';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.tsx';
import type { WarmResult } from '../../src/lib/types.ts';
import { buildJsonl, InMemoryFs } from '../integration/harness.ts';

function CapturingTextInput(
  { defaultValue }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode },
) {
  return React.createElement('ink-text', null, `[TextInput:${defaultValue ?? ''}]`);
}

const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

describe({ name: 'App bug reproducers', sanitizeOps: false, sanitizeResources: false }, () => {
  it('B3: long tick preserves session added by refresh during its await', async () => {
    // Start with one cold, selected session.
    const fs = new InMemoryFs();
    fs.addFile(
      `.claude/projects/test/s1.jsonl`,
      buildJsonl({
        sessionId: 's1',
        projectDir: 'test',
        customTitle: 'Session One',
        cacheReadTokens: 80_000,
        cacheWriteTokens: 1_000,
        lastAssistantAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      }),
    );

    // Hanging warmFn that we resolve manually later.
    let resolveWarm: (v: WarmResult) => void = () => {};
    const warmFn = () =>
      new Promise<WarmResult>((resolve) => {
        resolveWarm = resolve;
      });

    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{
          fs,
          warmFn,
          copyToClipboard: () => {},
          TextInput: CapturingTextInput,
          tickIntervalMs: 50,
          refreshIntervalMs: 50,
        }}
      />,
    );
    await tick();

    // Select the cold session and start warming.
    r.stdin.write(' ');
    await tick();
    r.stdin.write('\r');
    await tick();
    // Wait for tick to fire and call warmFn (which will hang).
    await tick(100);

    // While warmFn hangs, simulate refresh discovering a new session.
    fs.addFile(
      `.claude/projects/test/s2.jsonl`,
      buildJsonl({
        sessionId: 's2',
        projectDir: 'test',
        customTitle: 'Brand New Session',
        cacheReadTokens: 50_000,
        cacheWriteTokens: 0,
        lastAssistantAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      }),
    );
    // Wait for the next refresh cycle.
    await tick(120);

    expect(r.lastFrame()!).toContain('Brand New Session');

    // Resolve warmFn. With the patch-merge fix, s2 should survive.
    resolveWarm({
      sessionId: 's1',
      usage: { inputTokens: 0, cacheReadInputTokens: 80_000, cacheCreationInputTokens: 1_000, outputTokens: 3 },
      model: 'claude-opus-4-6',
      costUsd: 0.04,
      error: null,
    });
    await tick(80);

    expect(r.lastFrame()!).toContain('Brand New Session');
    r.unmount();
  });
});
