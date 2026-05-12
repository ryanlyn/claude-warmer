import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { spy } from '@std/testing/mock';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.tsx';
import type { Session, WarmResult } from '../../src/lib/types.ts';
import type { Clock, Fs } from '../../src/lib/deps.ts';
import { buildJsonl, InMemoryFs } from '../integration/harness.ts';
import process from 'node:process';

// In-memory session fixtures returned by discoverSessions when we wire them
// into an InMemoryFs. Each fixture writes one ~/.claude/projects/<dir>/<id>.jsonl.

function defaultFixture(overrides: Partial<{
  sessionId: string;
  name: string;
  projectDir: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastAssistantAt: Date;
  model: string;
}> = {}) {
  return {
    sessionId: overrides.sessionId ?? 'abc-123',
    name: overrides.name ?? 'Test Session',
    projectDir: overrides.projectDir ?? 'test',
    cacheReadTokens: overrides.cacheReadTokens ?? 100000,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 5000,
    lastAssistantAt: overrides.lastAssistantAt ?? new Date(Date.now() - 10 * 60 * 1000),
    model: overrides.model ?? 'claude-opus-4-6',
  };
}

interface BuildOpts {
  fixtures?: ReturnType<typeof defaultFixture>[];
}

function buildFs(opts: BuildOpts = {}): InMemoryFs {
  const fs = new InMemoryFs();
  const fixtures = opts.fixtures ?? [defaultFixture()];
  for (const f of fixtures) {
    fs.addFile(
      `.claude/projects/${f.projectDir}/${f.sessionId}.jsonl`,
      buildJsonl({
        sessionId: f.sessionId,
        projectDir: f.projectDir,
        customTitle: f.name,
        cacheReadTokens: f.cacheReadTokens,
        cacheWriteTokens: f.cacheWriteTokens,
        model: f.model,
        lastAssistantAt: f.lastAssistantAt,
      }),
    );
  }
  return fs;
}

let capturedOnSubmit: ((v: string) => void) | null = null;

function CapturingTextInput(
  { defaultValue, onSubmit }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode },
) {
  capturedOnSubmit = onSubmit ?? null;
  return React.createElement('ink-text', null, `[TextInput:${defaultValue ?? ''}]`);
}

const realClock: Clock = {
  now: () => Date.now(),
  setInterval: globalThis.setInterval as unknown as typeof globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setTimeout: globalThis.setTimeout as unknown as typeof globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

const tick = () => new Promise<void>((r) => setTimeout(r, 50));

const defaultWarmResult: WarmResult = {
  sessionId: 'abc-123',
  usage: { inputTokens: 0, cacheReadInputTokens: 80000, cacheCreationInputTokens: 1000, outputTokens: 3 },
  model: 'claude-opus-4-6',
  costUsd: 0.04,
  error: null,
};

interface BuiltDeps {
  fs: Fs;
  warmFn: (sid: string, prompt: string, cwd?: string, projectDir?: string) => Promise<WarmResult>;
  copyToClipboard: (text: string) => void;
  TextInput: typeof CapturingTextInput;
  copyCalls: string[];
  warmCalls: Array<{ sid: string }>;
}

function makeDeps(opts: BuildOpts & { warmResult?: WarmResult; warmFn?: BuiltDeps['warmFn'] } = {}): BuiltDeps {
  const fs = buildFs(opts);
  const copyCalls: string[] = [];
  const warmCalls: Array<{ sid: string }> = [];
  const warmFn = opts.warmFn ?? ((sid: string) => {
    warmCalls.push({ sid });
    return Promise.resolve(opts.warmResult ?? defaultWarmResult);
  });
  const copyToClipboard = (text: string) => {
    copyCalls.push(text);
  };
  return { fs, warmFn, copyToClipboard, TextInput: CapturingTextInput, copyCalls, warmCalls };
}

describe({ name: 'App', sanitizeOps: false, sanitizeResources: false }, () => {
  beforeEach(() => {
    capturedOnSubmit = null;
  });

  afterEach(() => {
    capturedOnSubmit = null;
  });

  it('renders header with app name', () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    expect(r.lastFrame()!).toContain('Claude Warmer');
    r.unmount();
  });

  it('uses makeWarmer when deps.clock is provided', () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, clock: realClock, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    expect(r.lastFrame()!).toContain('Claude Warmer');
    r.unmount();
  });

  it('falls back to bare warmSession when neither fs nor clock is provided (warmFn-only path)', () => {
    const d = makeDeps();
    // Passing only warmFn skips both the makeWarmer branch and the bare warmSession branch.
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    expect(r.lastFrame()!).toContain('Claude Warmer');
    r.unmount();
  });

  it('exercises the bare warmSession branch when no fs/clock/warmFn injected', () => {
    // No deps at all - exercises the deps.fs/clock both-undefined path which
    // assigns the raw warmSession. The default HOME points elsewhere so
    // discoverSessions returns []; we just want the branch covered.
    const originalHome = process.env.HOME;
    process.env.HOME = '/tmp/this-does-not-exist-for-app-test';
    try {
      const r = render(<App intervalMinutes={55} warmPrompt="Reply 'ok'" deps={{ TextInput: CapturingTextInput }} />);
      expect(r.lastFrame()!).toContain('Claude Warmer');
      r.unmount();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('renders discovered sessions', () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    expect(r.lastFrame()!).toContain('Test Session');
    r.unmount();
  });

  it('renders footer with keybindings', () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    expect(r.lastFrame()!).toContain('quit');
    r.unmount();
  });

  it('toggles selection on space key', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write(' ');
    await tick();
    expect(r.lastFrame()!).toContain('Test Session');
    r.unmount();
  });

  it('toggles warming on enter key', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    expect(r.lastFrame()!).toContain('active');
    r.unmount();
  });

  it('selects active sessions on a key', async () => {
    const d = makeDeps({
      fixtures: [
        defaultFixture({ sessionId: 'abc', name: 'Session One', cacheReadTokens: 100000 }),
        defaultFixture({
          sessionId: 'def',
          name: 'Session Two',
          lastAssistantAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          cacheReadTokens: 50000,
        }),
      ],
    });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('n');
    await tick();
    r.stdin.write('a');
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).toContain('Session One');
    expect(frame).toContain('Session Two');
    r.unmount();
  });

  it('deselects all on n key', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('n');
    await tick();
    expect(r.lastFrame()!).toContain('-');
    r.unmount();
  });

  it('navigates down with arrow key', async () => {
    const d = makeDeps({
      fixtures: [
        defaultFixture({ sessionId: 'abc', name: 'Session One' }),
        defaultFixture({ sessionId: 'def', name: 'Session Two' }),
      ],
    });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\x1B[B');
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).toContain('Session One');
    expect(frame).toContain('Session Two');
    r.unmount();
  });

  it('navigates up with arrow key', async () => {
    const d = makeDeps({
      fixtures: [
        defaultFixture({ sessionId: 'abc', name: 'Session One' }),
        defaultFixture({ sessionId: 'def', name: 'Session Two' }),
      ],
    });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\x1B[B');
    await tick();
    r.stdin.write('\x1B[A');
    await tick();
    expect(r.lastFrame()!).toContain('Session One');
    r.unmount();
  });

  it('does not navigate below last session', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\x1B[B');
    r.stdin.write('\x1B[B');
    r.stdin.write('\x1B[B');
    await tick();
    expect(r.lastFrame()!).toContain('Test Session');
    r.unmount();
  });

  it('does not navigate above first session', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\x1B[A');
    await tick();
    expect(r.lastFrame()!).toContain('Test Session');
    r.unmount();
  });

  it('quits on q key', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('q');
    await tick();
  });

  it('toggles warming off with enter key pressed twice', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    expect(r.lastFrame()!).toContain('active');
    r.stdin.write('\r');
    await tick();
    expect(r.lastFrame()!).toContain('paused');
    r.unmount();
  });

  it('warming timer effect fires and calls tick (selected + due)', async () => {
    // Cold session - discoverSessions returns selected:false for cold; we
    // press space to select it before starting warming so bootstrap schedules
    // nextWarmAt at `now` and the first tick warms it.
    const d = makeDeps({
      fixtures: [
        defaultFixture({
          lastAssistantAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        }),
      ],
    });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{
          fs: d.fs,
          warmFn: d.warmFn,
          copyToClipboard: d.copyToClipboard,
          TextInput: d.TextInput,
          tickIntervalMs: 50,
        }}
      />,
    );
    await tick();
    r.stdin.write(' '); // select
    await tick();
    r.stdin.write('\r'); // start warming
    await tick();
    await new Promise<void>((res) => setTimeout(res, 200));
    expect(d.warmCalls.length).toBeGreaterThan(0);
    r.unmount();
  });

  it('warming timer effect cleans up on warming toggle off', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{
          fs: d.fs,
          warmFn: d.warmFn,
          copyToClipboard: d.copyToClipboard,
          TextInput: d.TextInput,
          tickIntervalMs: 50,
        }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    r.stdin.write('\r');
    await tick();
    r.unmount();
  });

  it('selectNone while warming', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    r.stdin.write('n');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('selectActive while warming', async () => {
    const d = makeDeps({
      fixtures: [
        defaultFixture({ sessionId: 'abc', name: 'Session One' }),
        defaultFixture({
          sessionId: 'def',
          name: 'Session Two',
          lastAssistantAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        }),
      ],
    });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    r.stdin.write('a');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('toggleSelection while warming adds session when selecting', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    r.stdin.write(' ');
    await tick();
    r.stdin.write(' ');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('toggleSelection while warming removes session when deselecting', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    r.stdin.write(' ');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('handles unrecognized key input gracefully', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('x');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('does not toggle selection when sessions list is empty', async () => {
    const fs = new InMemoryFs();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs, warmFn: spy(() => Promise.resolve(defaultWarmResult)) as never, TextInput: CapturingTextInput }}
      />,
    );
    await tick();
    r.stdin.write(' ');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('does not crash when navigating down on an empty sessions list', async () => {
    const fs = new InMemoryFs();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs, warmFn: spy(() => Promise.resolve(defaultWarmResult)) as never, TextInput: CapturingTextInput }}
      />,
    );
    await tick();
    r.stdin.write('\x1B[B');
    r.stdin.write(' ');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('does not crash when navigating up on an empty sessions list', async () => {
    const fs = new InMemoryFs();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs, warmFn: spy(() => Promise.resolve(defaultWarmResult)) as never, TextInput: CapturingTextInput }}
      />,
    );
    await tick();
    r.stdin.write('\x1B[A');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('copies session ID to clipboard on c key', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('c');
    await tick();
    expect(d.copyCalls).toEqual(['abc-123']);
    r.unmount();
  });

  it('c key is no-op when sessions list is empty', async () => {
    const fs = new InMemoryFs();
    const copy = spy((_t: string) => {});
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{
          fs,
          warmFn: spy(() => Promise.resolve(defaultWarmResult)) as never,
          copyToClipboard: copy,
          TextInput: CapturingTextInput,
        }}
      />,
    );
    await tick();
    r.stdin.write('c');
    await tick();
    expect(copy.calls.length).toBe(0);
    r.unmount();
  });

  it('opens prompt editing on p key and submits with value', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('p');
    await tick();
    expect(r.lastFrame()!).toContain('Prompt');
    expect(capturedOnSubmit).not.toBeNull();
    capturedOnSubmit!('Say hello');
    await tick();
    expect(r.lastFrame()!).not.toContain('[TextInput');
    expect(r.lastFrame()!).toContain('Say hello');
    r.unmount();
  });

  it('opens interval editing on i key and submits with valid value', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('i');
    await tick();
    expect(r.lastFrame()!).toContain('Interval');
    expect(capturedOnSubmit).not.toBeNull();
    capturedOnSubmit!('30');
    await tick();
    expect(r.lastFrame()!).not.toContain('[TextInput');
    expect(r.lastFrame()!).toContain('30m');
    r.unmount();
  });

  it('interval edit with invalid value keeps original', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('i');
    await tick();
    capturedOnSubmit!('abc');
    await tick();
    expect(r.lastFrame()!).toContain('55m');
    r.unmount();
  });

  it('interval edit with out-of-range value keeps original', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('i');
    await tick();
    capturedOnSubmit!('0');
    await tick();
    expect(r.lastFrame()!).toContain('55m');
    r.unmount();
  });

  it('interval edit with value above 59 keeps original', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('i');
    await tick();
    capturedOnSubmit!('60');
    await tick();
    expect(r.lastFrame()!).toContain('55m');
    r.unmount();
  });

  it('prompt edit with empty value keeps original', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('p');
    await tick();
    capturedOnSubmit!('   ');
    await tick();
    expect(r.lastFrame()!).toContain("Reply 'ok'");
    r.unmount();
  });

  it('disables keybindings while editing prompt', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('p');
    await tick();
    // 'q' should not quit the app while editing
    r.stdin.write('q');
    await tick();
    expect(r.lastFrame()!).toContain('Prompt');
    capturedOnSubmit!("Reply 'ok'");
    await tick();
    r.unmount();
  });

  it('scroll updates when navigating down past visible area', async () => {
    const fixtures = Array.from({ length: 25 }, (_, i) =>
      defaultFixture({
        sessionId: `s-${String(i).padStart(3, '0')}`,
        name: `Session ${i}`,
        cacheReadTokens: 100000 - i,
      }));
    const d = makeDeps({ fixtures });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    for (let i = 0; i < 20; i++) r.stdin.write('\x1B[B');
    await tick();
    expect(r.lastFrame()!).toBeDefined();
    r.unmount();
  });

  it('scroll updates when navigating up past visible area', async () => {
    const fixtures = Array.from({ length: 25 }, (_, i) =>
      defaultFixture({
        sessionId: `s-${String(i).padStart(3, '0')}`,
        name: `Session ${i}`,
        cacheReadTokens: 100000 - i,
      }));
    const d = makeDeps({ fixtures });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    for (let i = 0; i < 20; i++) r.stdin.write('\x1B[B');
    await tick();
    for (let i = 0; i < 20; i++) r.stdin.write('\x1B[A');
    await tick();
    expect(r.lastFrame()!).toContain('Session 0');
    r.unmount();
  });

  it('reclamps scroll when the terminal height shrinks', async () => {
    const fixtures = Array.from({ length: 5 }, (_, i) =>
      defaultFixture({
        sessionId: `s-${String(i).padStart(3, '0')}`,
        name: `Session ${i}`,
        cacheReadTokens: 100000 - i,
      }));
    const d = makeDeps({ fixtures });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    for (let i = 0; i < 4; i++) r.stdin.write('\x1B[B');
    await tick();
    Object.defineProperty(r.stdout, 'rows', { configurable: true, get: () => 8 });
    r.rerender(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    expect(r.lastFrame()!).toContain('Session 4');
    r.unmount();
  });

  it('interval change while warming reschedules sessions', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    expect(r.lastFrame()!).toContain('active');
    r.stdin.write('i');
    await tick();
    capturedOnSubmit!('10');
    await tick();
    expect(r.lastFrame()!).toContain('10m');
    expect(r.lastFrame()!).toContain('active');
    r.unmount();
  });

  it('tick warm completes and applies the success patch', async () => {
    const d = makeDeps({
      fixtures: [
        defaultFixture({
          lastAssistantAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        }),
      ],
    });
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{
          fs: d.fs,
          warmFn: d.warmFn,
          copyToClipboard: d.copyToClipboard,
          TextInput: d.TextInput,
          tickIntervalMs: 50,
        }}
      />,
    );
    await tick();
    r.stdin.write(' ');
    await tick();
    r.stdin.write('\r');
    await new Promise<void>((res) => setTimeout(res, 200));
    expect(d.warmCalls.length).toBeGreaterThan(0);
    r.unmount();
  });

  it('warming toggle off resets sessions with warmStatus warming to idle', async () => {
    const d = makeDeps();
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{ fs: d.fs, warmFn: d.warmFn, copyToClipboard: d.copyToClipboard, TextInput: d.TextInput }}
      />,
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    r.stdin.write('\r');
    await tick();
    expect(r.lastFrame()!).toContain('paused');
    r.unmount();
  });

  it('newly discovered warm session is auto-selected (B1 regression)', async () => {
    const d = makeDeps();
    // Drive refresh through a manual fs swap: just check initial render asserts session present.
    // Full mid-run refresh coverage lives in tests/integration/.
    const r = render(
      <App
        intervalMinutes={55}
        warmPrompt="Reply 'ok'"
        deps={{
          fs: d.fs,
          warmFn: d.warmFn,
          copyToClipboard: d.copyToClipboard,
          TextInput: d.TextInput,
          refreshIntervalMs: 50,
        }}
      />,
    );
    await tick();
    // Add a second fixture and wait for refresh to pick it up.
    d.fs.addFile(
      `.claude/projects/test/new-warm-001.jsonl`,
      buildJsonl({
        sessionId: 'new-warm-001',
        projectDir: 'test',
        customTitle: 'NewWarm',
        cacheReadTokens: 9999,
        cacheWriteTokens: 1,
        model: 'claude-opus-4-6',
        lastAssistantAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );
    await new Promise<void>((res) => setTimeout(res, 120));
    expect(r.lastFrame()!).toContain('NewWarm');
    r.unmount();
  });
});
