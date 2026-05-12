import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { spy } from '@std/testing/mock';
import { FakeTime } from '@std/testing/time';
import { Buffer } from 'node:buffer';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import type * as fs from 'node:fs';
import {
  extractUsageFromNewLines,
  getClaudePath,
  getJsonlPath,
  makeWarmer,
  resetClaudePath,
  warmSession,
} from '../../src/lib/warmer.ts';
import type { ExecFileSyncFn } from '../../src/lib/warmer.ts';
import type { Fs, PtyLike, SpawnFn } from '../../src/lib/deps.ts';

function makeJsonlLine(overrides: { model?: string; usage?: Record<string, number> }): string {
  return JSON.stringify({
    message: {
      role: 'assistant',
      model: overrides.model || 'claude-opus-4-6',
      usage: overrides.usage || {},
    },
    type: 'assistant',
    timestamp: new Date().toISOString(),
  });
}

interface MockPty extends PtyLike {
  emitData: (data: string) => void;
  emitExit: (event: { exitCode: number }) => void;
  writeCalls: string[];
  killCalls: number;
  killThrows: boolean;
}

function makeMockPty(): MockPty {
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((event: { exitCode: number }) => void) | null = null;
  const mp: MockPty = {
    onData: (cb) => {
      dataCb = cb;
      return { dispose: () => {} };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose: () => {} };
    },
    write: (data: string) => {
      mp.writeCalls.push(data);
      return true;
    },
    kill: () => {
      mp.killCalls++;
      if (mp.killThrows) throw new Error('Process already exited');
    },
    emitData: (data) => dataCb?.(data),
    emitExit: (event) => exitCb?.(event),
    writeCalls: [],
    killCalls: 0,
    killThrows: false,
  };
  return mp;
}

interface MockFsState {
  statSize?: number | 'throw';
  fstatSize?: number;
  readContent?: string;
  openThrows?: boolean;
}

function makeMockFs(state: MockFsState): Fs {
  const closeSync = spy(() => undefined);
  return {
    existsSync: (() => true) as Fs['existsSync'],
    readdirSync: (() => []) as Fs['readdirSync'],
    readFileSync: (() => '') as Fs['readFileSync'],
    statSync: ((..._args: unknown[]) => {
      if (state.statSize === 'throw') throw new Error('ENOENT');
      return { size: state.statSize ?? 0 } as fs.Stats;
    }) as Fs['statSync'],
    openSync: ((..._args: unknown[]) => {
      if (state.openThrows) throw new Error('ENOENT');
      return 42;
    }) as Fs['openSync'],
    fstatSync: (() => ({ size: state.fstatSize ?? 0 } as fs.Stats)) as Fs['fstatSync'],
    readSync: ((_fd: number, buf: Buffer) => {
      if (state.readContent) {
        buf.write(state.readContent);
        return state.readContent.length;
      }
      return 0;
    }) as unknown as Fs['readSync'],
    closeSync: closeSync as unknown as Fs['closeSync'],
  };
}

describe('getJsonlPath', () => {
  it('constructs the correct path', () => {
    const result = getJsonlPath('my-project', 'abc-123');
    expect(result).toBe(path.join(os.homedir(), '.claude', 'projects', 'my-project', 'abc-123.jsonl'));
  });
});

describe('getClaudePath', () => {
  let originalClaudePath: string | undefined;

  beforeEach(() => {
    resetClaudePath();
    originalClaudePath = process.env.CLAUDE_PATH;
    delete process.env.CLAUDE_PATH;
  });

  afterEach(() => {
    if (originalClaudePath === undefined) {
      delete process.env.CLAUDE_PATH;
    } else {
      process.env.CLAUDE_PATH = originalClaudePath;
    }
    resetClaudePath();
  });

  it('returns cached path on subsequent calls', () => {
    const exec = spy(() => '/usr/local/bin/claude\n');
    const first = getClaudePath(exec as unknown as ExecFileSyncFn);
    const second = getClaudePath(exec as unknown as ExecFileSyncFn);
    expect(first).toBe('/usr/local/bin/claude');
    expect(second).toBe('/usr/local/bin/claude');
    expect(exec.calls.length).toBe(1);
  });

  it('falls back to claude when which fails', () => {
    const exec = spy(() => {
      throw new Error('not found');
    });
    const result = getClaudePath(exec as unknown as ExecFileSyncFn);
    expect(result).toBe('claude');
  });

  it('uses CLAUDE_PATH env var when set, skipping which', () => {
    process.env.CLAUDE_PATH = '/tmp/fake-claude';
    const exec = spy(() => '/should-not-be-called');
    const result = getClaudePath(exec as unknown as ExecFileSyncFn);
    expect(result).toBe('/tmp/fake-claude');
    expect(exec.calls.length).toBe(0);
  });

  it('ignores empty CLAUDE_PATH and falls through to which', () => {
    process.env.CLAUDE_PATH = '';
    const exec = spy(() => '/usr/local/bin/claude\n');
    const result = getClaudePath(exec as unknown as ExecFileSyncFn);
    expect(result).toBe('/usr/local/bin/claude');
    expect(exec.calls.length).toBe(1);
  });
});

describe('extractUsageFromNewLines', () => {
  it('extracts usage from assistant message', () => {
    const line = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 100000,
        cache_creation_input_tokens: 500,
        output_tokens: 5,
      },
    });
    const result = extractUsageFromNewLines(line);
    expect(result.usage.cacheReadInputTokens).toBe(100000);
    expect(result.usage.cacheCreationInputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.error).toBeNull();
  });

  it('handles missing usage fields gracefully', () => {
    const line = makeJsonlLine({ model: 'claude-opus-4-6', usage: {} });
    const result = extractUsageFromNewLines(line);
    expect(result.usage.cacheReadInputTokens).toBe(0);
    expect(result.usage.cacheCreationInputTokens).toBe(0);
    expect(result.error).toBeNull();
  });

  it('returns error when no assistant message found', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
    const result = extractUsageFromNewLines(line);
    expect(result.error).toContain('No assistant message');
  });

  it('returns error for empty content', () => {
    const result = extractUsageFromNewLines('');
    expect(result.error).toContain('No assistant message');
  });

  it('returns error for invalid JSON lines', () => {
    const result = extractUsageFromNewLines('NOT JSON\nALSO NOT JSON');
    expect(result.error).toContain('No assistant message');
  });

  it('picks the last assistant message when multiple exist', () => {
    const line1 = makeJsonlLine({
      model: 'claude-sonnet-4-6',
      usage: { cache_read_input_tokens: 1000, output_tokens: 1 },
    });
    const line2 = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });
    const result = extractUsageFromNewLines(line1 + '\n' + line2);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.usage.cacheReadInputTokens).toBe(80000);
  });

  it('defaults model to empty string when missing', () => {
    const line = JSON.stringify({
      message: { role: 'assistant', usage: { cache_read_input_tokens: 1000, output_tokens: 1 } },
      type: 'assistant',
      timestamp: new Date().toISOString(),
    });
    const result = extractUsageFromNewLines(line);
    expect(result.model).toBe('');
    expect(result.error).toBeNull();
  });

  it('skips non-assistant messages to find the assistant one', () => {
    const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 50000, output_tokens: 2 },
    });
    const result = extractUsageFromNewLines(userLine + '\n' + assistantLine);
    expect(result.usage.cacheReadInputTokens).toBe(50000);
    expect(result.error).toBeNull();
  });
});

describe('warmSession', () => {
  let time: FakeTime;
  let mockPty: MockPty;
  let spawn: SpawnFn;
  let exec: ExecFileSyncFn;

  beforeEach(() => {
    resetClaudePath();
    time = new FakeTime();
    mockPty = makeMockPty();
    spawn = (() => mockPty) as unknown as SpawnFn;
    exec = (() => 'claude\n') as ExecFileSyncFn;
  });

  afterEach(() => {
    time.restore();
    resetClaudePath();
  });

  it('returns error when no projectDir is provided', async () => {
    const result = await warmSession('abc-123', "Reply 'ok'", '/test', undefined, {
      fs: makeMockFs({ statSize: 0 }),
      spawn,
      execFile: exec,
    });
    expect(result.error).toBe('No projectDir provided');
  });

  it('spawns claude with --resume in a PTY', async () => {
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, cache_creation_input_tokens: 1000, output_tokens: 3 },
    });
    const spawnSpy = spy((_file: string, _args: string[], _opts: unknown) => mockPty);
    const fsFake = makeMockFs({ statSize: 0, fstatSize: assistantLine.length, readContent: assistantLine });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn: spawnSpy as unknown as SpawnFn,
      execFile: exec,
    });

    mockPty.emitData('Claude Code v2.1\n> ');
    await time.tickAsync(3500);
    expect(mockPty.writeCalls).toContain("Reply 'ok'\r");

    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    expect(mockPty.writeCalls).toContain('/exit\r');

    mockPty.emitExit({ exitCode: 0 });
    await time.runMicrotasks();
    const result = await promise;
    expect(result.sessionId).toBe('abc-123');
    expect(result.usage.cacheReadInputTokens).toBe(80000);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.error).toBeNull();

    expect(spawnSpy.calls[0].args[1]).toEqual(['--resume', 'abc-123']);
    expect((spawnSpy.calls[0].args[2] as { cwd?: string }).cwd).toBe('/test');
  });

  it('handles total timeout', async () => {
    const fsFake = makeMockFs({ statSize: 0 });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    for (let i = 0; i < 50; i++) {
      await time.tickAsync(2500);
      mockPty.emitData('.');
    }
    await time.tickAsync(5_000);
    const result = await promise;
    expect(result.error).toBe('Warm session timed out');
    expect(mockPty.killCalls).toBeGreaterThan(0);
  });

  it('handles PTY spawn failure', async () => {
    const failSpawn = (() => {
      throw new Error('spawn failed');
    }) as unknown as SpawnFn;
    const result = await warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: makeMockFs({ statSize: 0 }),
      spawn: failSpawn,
      execFile: exec,
    });
    expect(result.error).toContain('Failed to spawn PTY');
  });

  it('kills PTY after grace period if it does not exit after /exit', async () => {
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });
    const fsFake = makeMockFs({ statSize: 0, fstatSize: assistantLine.length, readContent: assistantLine });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    await time.tickAsync(5500);

    const result = await promise;
    expect(mockPty.killCalls).toBeGreaterThan(0);
    expect(result.error).toBeNull();
  });

  it('handles kill failure in grace period when PTY already exited', async () => {
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });
    mockPty.killThrows = true;
    const fsFake = makeMockFs({ statSize: 0, fstatSize: assistantLine.length, readContent: assistantLine });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    await time.tickAsync(5500);

    const result = await promise;
    expect(result.error).toBeNull();
  });

  it('handles missing JSONL file before warm (statSync fails)', async () => {
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });
    const fsFake = makeMockFs({ statSize: 'throw', fstatSize: assistantLine.length, readContent: assistantLine });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    mockPty.emitExit({ exitCode: 0 });
    await time.runMicrotasks();

    const result = await promise;
    expect(result.error).toBeNull();
    expect(result.usage.cacheReadInputTokens).toBe(80000);
  });

  it('returns error when JSONL file read fails after warm', async () => {
    const fsFake = makeMockFs({ statSize: 0, openThrows: true });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    mockPty.emitExit({ exitCode: 0 });
    await time.runMicrotasks();

    const result = await promise;
    expect(result.error).toBe('Failed to read JSONL file after warm');
  });

  it('passes undefined cwd when not provided', async () => {
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });
    const spawnSpy = spy((_file: string, _args: string[], _opts: unknown) => mockPty);
    const fsFake = makeMockFs({ statSize: 0, fstatSize: assistantLine.length, readContent: assistantLine });
    const promise = warmSession('abc-123', "Reply 'ok'", undefined, 'my-project', {
      fs: fsFake,
      spawn: spawnSpy as unknown as SpawnFn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    mockPty.emitExit({ exitCode: 0 });
    await time.runMicrotasks();

    const result = await promise;
    expect(result.error).toBeNull();
    expect((spawnSpy.calls[0].args[2] as { cwd?: string }).cwd).toBeUndefined();
  });

  it('returns parsed error when JSONL has no assistant message', async () => {
    const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
    const fsFake = makeMockFs({ statSize: 0, fstatSize: userLine.length, readContent: userLine });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    mockPty.emitExit({ exitCode: 0 });
    await time.runMicrotasks();

    const result = await promise;
    expect(result.error).toContain('No assistant message');
    expect(result.costUsd).toBe(0);
  });

  it('returns error when no new JSONL content found after warm', async () => {
    // statSize === fstatSize → bytesToRead is 0 → no new content.
    const fsFake = makeMockFs({ statSize: 100, fstatSize: 100 });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    mockPty.emitExit({ exitCode: 0 });
    await time.runMicrotasks();

    const result = await promise;
    expect(result.error).toBe('No new JSONL content after warm');
  });

  it('handles finish called multiple times (idempotent)', async () => {
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });
    const fsFake = makeMockFs({ statSize: 0, fstatSize: assistantLine.length, readContent: assistantLine });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    mockPty.emitExit({ exitCode: 0 });
    await time.tickAsync(6000);

    const result = await promise;
    expect(result.error).toBeNull();
  });

  it('handles data received after done phase', async () => {
    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });
    const fsFake = makeMockFs({ statSize: 0, fstatSize: assistantLine.length, readContent: assistantLine });
    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project', {
      fs: fsFake,
      spawn,
      execFile: exec,
    });

    mockPty.emitData('> ');
    await time.tickAsync(3500);
    mockPty.emitData('ok\n> ');
    await time.tickAsync(3500);
    mockPty.emitData('extra output');
    mockPty.emitExit({ exitCode: 0 });
    await time.runMicrotasks();

    const result = await promise;
    expect(result.error).toBeNull();
  });
});

describe('makeWarmer', () => {
  it('returns a warmFn bound to the supplied deps', async () => {
    const warmFn = makeWarmer({});
    const result = await warmFn('abc-123', "Reply 'ok'", '/tmp');
    expect(result.error).toBe('No projectDir provided');
    expect(result.sessionId).toBe('abc-123');
  });
});
