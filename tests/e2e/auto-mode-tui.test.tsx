/**
 * Live TUI acceptance tests for auto mode. These tests intentionally use
 * real Claude Code sessions and the real `warmSession` PTY path. The proof is
 * JSONL growth for live sessions and no JSONL growth for closed sessions.
 */
import React, { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from '../../src/app.js';
import { parseCliArgs } from '../../src/lib/cli.js';
import { extractUsageFromNewLines, getClaudePath, getJsonlPath, resetClaudePath } from '../../src/lib/warmer.js';
import { realFs, type Fs } from '../../src/lib/deps.js';

const CWD = process.cwd();
const PROJECT_DIR = '-' + CWD.replace(/\//g, '-').slice(1);
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects', PROJECT_DIR);
const SESSIONS_ROOT = path.join(os.homedir(), '.claude', 'sessions');
const PROMPT = "Reply 'ok'";
const REPL_READY_MS = 12_000;
const RESPONSE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 420_000;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: () => Buffer.from('') };
});

vi.mock('@inkjs/ui', () => ({
  TextInput: ({ defaultValue }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode }) =>
    React.createElement('ink-text', null, `[input:${defaultValue ?? ''}]`),
}));

interface SeedSession {
  sessionId: string;
  pid: number;
  proc?: pty.IPty;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function listProjectSessionIds(): string[] {
  try {
    return fs
      .readdirSync(PROJECTS_ROOT)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

function jsonlPath(sessionId: string): string {
  return getJsonlPath(PROJECT_DIR, sessionId);
}

function jsonlSize(sessionId: string): number {
  try {
    return fs.statSync(jsonlPath(sessionId)).size;
  } catch (error) {
    if (isMissingPath(error)) return 0;
    throw error;
  }
}

interface AssistantJsonlState {
  hasUsage: boolean;
  apiError: string | null;
}

function readAssistantJsonlState(sessionId: string): AssistantJsonlState {
  let content: string;
  try {
    content = fs.readFileSync(jsonlPath(sessionId), 'utf-8');
  } catch (error) {
    if (isMissingPath(error)) return { hasUsage: false, apiError: null };
    throw error;
  }

  const parsed = extractUsageFromNewLines(content);
  if (!parsed.error && parsed.usage.cacheReadInputTokens + parsed.usage.cacheCreationInputTokens > 0) {
    return { hasUsage: true, apiError: null };
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as {
        isApiErrorMessage?: boolean;
        apiErrorStatus?: number;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (record.isApiErrorMessage || record.apiErrorStatus) {
        const text = record.message?.content?.find((part) => part.type === 'text')?.text;
        return {
          hasUsage: false,
          apiError: text ?? `Claude API error ${record.apiErrorStatus ?? 'unknown'}`,
        };
      }
    } catch {
      continue;
    }
  }
  return { hasUsage: false, apiError: null };
}

function pidFileName(seed: SeedSession): string {
  return `${seed.sessionId}.json`;
}

function scopedFs(seeds: SeedSession[]): Fs {
  const allowedJsonls = new Set(seeds.map((seed) => `${seed.sessionId}.jsonl`));
  const pidFiles = new Map(
    seeds.map((seed) => [
      pidFileName(seed),
      JSON.stringify({
        pid: seed.pid,
        sessionId: seed.sessionId,
        cwd: CWD,
        startedAt: Date.now(),
        kind: 'claude-code',
      }),
    ]),
  );

  return {
    ...realFs,
    existsSync: ((p: fs.PathLike) => {
      const key = p.toString();
      if (key === path.join(os.homedir(), '.claude', 'projects')) return true;
      if (key === PROJECTS_ROOT) return true;
      if (key === SESSIONS_ROOT) return true;
      if (key.startsWith(SESSIONS_ROOT + path.sep)) {
        return pidFiles.has(path.basename(key));
      }
      return realFs.existsSync(p);
    }) as Fs['existsSync'],
    readdirSync: ((p: fs.PathLike) => {
      const key = p.toString();
      if (key === path.join(os.homedir(), '.claude', 'projects')) {
        return [PROJECT_DIR] as unknown as fs.Dirent[];
      }
      if (key === PROJECTS_ROOT) {
        return [...allowedJsonls] as unknown as fs.Dirent[];
      }
      if (key === SESSIONS_ROOT) {
        return [...pidFiles.keys()] as unknown as fs.Dirent[];
      }
      return realFs.readdirSync(p) as unknown as fs.Dirent[];
    }) as Fs['readdirSync'],
    readFileSync: ((p: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof p !== 'number') {
        const key = p.toString();
        if (key.startsWith(SESSIONS_ROOT + path.sep)) {
          const content = pidFiles.get(path.basename(key));
          if (content !== undefined) return content;
        }
      }
      return realFs.readFileSync(p, options as never);
    }) as Fs['readFileSync'],
  };
}

async function waitForSessionId(outputRef: () => string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const banner = stripAnsi(outputRef()).match(/claude --resume ([a-f0-9-]{36})/);
    const candidate = banner?.[1] ?? listProjectSessionIds().find((id) => !before.has(id));
    if (candidate) {
      const state = readAssistantJsonlState(candidate);
      if (state.hasUsage) return candidate;
      if (state.apiError) throw new Error(`Claude seed session failed before auto-mode TUI test: ${state.apiError}`);
    }
    await wait(1000);
  }
  throw new Error('timed out waiting for Claude session JSONL with assistant usage');
}

async function createSeedSession(keepAlive: boolean): Promise<SeedSession> {
  const before = new Set(listProjectSessionIds());
  const proc = pty.spawn(getClaudePath(), [], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: CWD,
    env: process.env as Record<string, string>,
  });

  let output = '';
  const outputSubscription = proc.onData((chunk: string) => {
    output += chunk;
  });

  await wait(REPL_READY_MS);
  proc.write(PROMPT + '\r');
  let sessionId: string;
  try {
    sessionId = await waitForSessionId(() => output, before);
  } catch (error) {
    outputSubscription.dispose();
    try {
      proc.kill();
    } catch {
      // already exited
    }
    throw error;
  }
  outputSubscription.dispose();

  const seed: SeedSession = { sessionId, pid: proc.pid, proc };
  if (keepAlive) return seed;

  try {
    await shutdownSession(seed);
  } catch (error) {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    throw error;
  }
  return seed;
}

async function shutdownSession(seed: SeedSession): Promise<void> {
  const proc = seed.proc;
  if (!proc) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let exitSubscription: ReturnType<typeof proc.onExit> | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      exitSubscription?.dispose();
      seed.proc = undefined;
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      exitSubscription?.dispose();
      reject(error);
    };

    exitSubscription = proc.onExit(cleanup);
    killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, 10_000);
    timeoutTimer = setTimeout(
      () => fail(new Error(`timed out waiting for Claude seed session ${seed.sessionId} to exit`)),
      20_000,
    );
    try {
      proc.write('/exit\r');
    } catch (error) {
      fail(error as Error);
    }
  });
}

async function waitForGrowth(sessionId: string, baseline: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = jsonlSize(sessionId);
    if (size > baseline) return size;
    await wait(1000);
  }
  throw new Error(`timed out waiting for ${sessionId} JSONL to grow past ${baseline}B`);
}

async function expectNoGrowth(sessionId: string, baseline: number, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    expect(jsonlSize(sessionId)).toBe(baseline);
    await wait(1000);
  }
}

describe('e2e: TUI auto mode against live Claude sessions', () => {
  it(
    'default auto mode warms a live session, ignores a closed session, and stops after the live session closes',
    async () => {
      delete process.env.CLAUDE_PATH;
      resetClaudePath();

      const closed = await createSeedSession(false);
      const live = await createSeedSession(true);
      let unmount: (() => void) | undefined;

      try {
        const closedInitial = jsonlSize(closed.sessionId);
        const liveInitial = jsonlSize(live.sessionId);
        const cliDefaults = parseCliArgs([]);

        const app = render(
          React.createElement(App, {
            intervalMinutes: 0.2,
            warmPrompt: PROMPT,
            initialAutoEnabled: cliDefaults.initialAutoEnabled,
            initialWarmingEnabled: cliDefaults.initialWarmingEnabled,
            deps: {
              fs: scopedFs([closed, live]),
              random: () => 0,
              tickIntervalMs: 2_000,
              refreshIntervalMs: 4_000,
            },
          }),
        );
        unmount = app.unmount;

        await wait(1000);
        const frame = stripAnsi(app.lastFrame() ?? '');
        expect(frame).toContain('active');
        expect(frame).toContain('auto');

        await waitForGrowth(live.sessionId, liveInitial, RESPONSE_TIMEOUT_MS);
        expect(jsonlSize(closed.sessionId)).toBe(closedInitial);

        await shutdownSession(live);
        await wait(10_000);
        const afterClose = jsonlSize(live.sessionId);
        await expectNoGrowth(live.sessionId, afterClose, 25_000);
        expect(jsonlSize(closed.sessionId)).toBe(closedInitial);
      } finally {
        unmount?.();
        await shutdownSession(live);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'm hotkey starts auto warming for a live session without pressing Enter',
    async () => {
      delete process.env.CLAUDE_PATH;
      resetClaudePath();

      const live = await createSeedSession(true);
      let unmount: (() => void) | undefined;

      try {
        const liveInitial = jsonlSize(live.sessionId);
        const app = render(
          React.createElement(App, {
            intervalMinutes: 0.2,
            warmPrompt: PROMPT,
            initialAutoEnabled: false,
            initialWarmingEnabled: false,
            deps: {
              fs: scopedFs([live]),
              random: () => 0,
              tickIntervalMs: 2_000,
              refreshIntervalMs: 4_000,
            },
          }),
        );
        unmount = app.unmount;

        await wait(1000);
        expect(stripAnsi(app.lastFrame() ?? '')).toContain('manual');

        app.stdin.write('m');
        await wait(500);
        const frame = stripAnsi(app.lastFrame() ?? '');
        expect(frame).toContain('active');
        expect(frame).toContain('auto');

        await waitForGrowth(live.sessionId, liveInitial, RESPONSE_TIMEOUT_MS);
      } finally {
        unmount?.();
        await shutdownSession(live);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
