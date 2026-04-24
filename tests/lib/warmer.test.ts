import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  warmSession,
  extractUsageFromNewLines,
  getJsonlPath,
  getClaudePath,
  resetClaudePath,
  makeWarmer,
} from '../../src/lib/warmer.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import * as child_process from 'node:child_process';

vi.mock('node-pty');
vi.mock('node:fs');
vi.mock('node:child_process');

const mockPty = vi.mocked(pty);
const mockFs = vi.mocked(fs);
const mockCp = vi.mocked(child_process);

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

describe('getJsonlPath', () => {
  it('constructs the correct path', () => {
    const result = getJsonlPath('my-project', 'abc-123');
    expect(result).toBe(path.join(os.homedir(), '.claude', 'projects', 'my-project', 'abc-123.jsonl'));
  });
});

describe('getClaudePath', () => {
  let originalClaudePath: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
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
  });

  it('returns cached path on subsequent calls', () => {
    mockCp.execFileSync.mockReturnValue('/usr/local/bin/claude\n' as never);
    const first = getClaudePath();
    const second = getClaudePath();
    expect(first).toBe('/usr/local/bin/claude');
    expect(second).toBe('/usr/local/bin/claude');
    expect(mockCp.execFileSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to claude when which fails', () => {
    mockCp.execFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const result = getClaudePath();
    expect(result).toBe('claude');
  });

  it('uses CLAUDE_PATH env var when set, skipping which', () => {
    process.env.CLAUDE_PATH = '/tmp/fake-claude';
    const result = getClaudePath();
    expect(result).toBe('/tmp/fake-claude');
    expect(mockCp.execFileSync).not.toHaveBeenCalled();
  });

  it('ignores empty CLAUDE_PATH and falls through to which', () => {
    process.env.CLAUDE_PATH = '';
    mockCp.execFileSync.mockReturnValue('/usr/local/bin/claude\n' as never);
    const result = getClaudePath();
    expect(result).toBe('/usr/local/bin/claude');
    expect(mockCp.execFileSync).toHaveBeenCalled();
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
    const content = line1 + '\n' + line2;

    const result = extractUsageFromNewLines(content);
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
    const content = userLine + '\n' + assistantLine;

    const result = extractUsageFromNewLines(content);
    expect(result.usage.cacheReadInputTokens).toBe(50000);
    expect(result.error).toBeNull();
  });
});

describe('warmSession', () => {
  let mockPtyProcess: {
    onData: ReturnType<typeof vi.fn>;
    onExit: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  let dataCallback: (data: string) => void;
  let exitCallback: (event: { exitCode: number }) => void;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    resetClaudePath();

    mockCp.execFileSync.mockReturnValue('claude\n' as never);

    mockPtyProcess = {
      onData: vi.fn((cb) => {
        dataCallback = cb;
      }),
      onExit: vi.fn((cb) => {
        exitCallback = cb;
      }),
      write: vi.fn(),
      kill: vi.fn(),
    };

    mockPty.spawn.mockReturnValue(mockPtyProcess as unknown as pty.IPty);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns error when no projectDir is provided', async () => {
    const result = await warmSession('abc-123', "Reply 'ok'", '/test');
    expect(result.error).toBe('No projectDir provided');
  });

  it('spawns claude with --resume in a PTY', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, cache_creation_input_tokens: 1000, output_tokens: 3 },
    });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    // Simulate REPL startup output
    dataCallback('Claude Code v2.1\n> ');

    // Wait for settle timer to fire (sends prompt)
    await vi.advanceTimersByTimeAsync(3500);
    expect(mockPtyProcess.write).toHaveBeenCalledWith("Reply 'ok'\r");

    // Simulate response output
    dataCallback('ok\n> ');

    // Wait for settle timer to fire (sends /exit)
    await vi.advanceTimersByTimeAsync(3500);
    expect(mockPtyProcess.write).toHaveBeenCalledWith('/exit\r');

    // Mock JSONL file read for new content
    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: assistantLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(assistantLine);
      return assistantLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    // Process exits
    exitCallback({ exitCode: 0 });

    const result = await promise;
    expect(result.sessionId).toBe('abc-123');
    expect(result.usage.cacheReadInputTokens).toBe(80000);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.error).toBeNull();

    expect(mockPty.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'abc-123'],
      expect.objectContaining({ cwd: '/test' }),
    );
  });

  it('handles total timeout', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    // Simulate data flowing continuously so settle timer keeps resetting
    // but never settles long enough to transition phases
    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(2500); // just under SETTLE_MS (3000)
      dataCallback('.');
    }

    // Now advance past total timeout
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await promise;
    expect(result.error).toBe('Warm session timed out');
    expect(mockPtyProcess.kill).toHaveBeenCalled();
  });

  it('handles PTY spawn failure', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);
    mockPty.spawn.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');
    expect(result.error).toContain('Failed to spawn PTY');
  });

  it('kills PTY after grace period if it does not exit after /exit', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500); // sends prompt
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500); // sends /exit

    // PTY does NOT exit - advance past EXIT_GRACE_MS (5000)
    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: assistantLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(assistantLine);
      return assistantLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    await vi.advanceTimersByTimeAsync(5500);

    const result = await promise;
    expect(mockPtyProcess.kill).toHaveBeenCalled();
    expect(result.error).toBeNull();
  });

  it('handles kill failure in grace period when PTY already exited', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500);
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500);

    // kill throws because process already exited
    mockPtyProcess.kill.mockImplementation(() => {
      throw new Error('Process already exited');
    });

    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: assistantLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(assistantLine);
      return assistantLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    await vi.advanceTimersByTimeAsync(5500);

    const result = await promise;
    expect(result.error).toBeNull();
  });

  it('handles missing JSONL file before warm (statSync fails)', async () => {
    mockFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500);
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500);

    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: assistantLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(assistantLine);
      return assistantLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    exitCallback({ exitCode: 0 });

    const result = await promise;
    expect(result.error).toBeNull();
    expect(result.usage.cacheReadInputTokens).toBe(80000);
  });

  it('returns error when JSONL file read fails after warm', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500);
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500);

    // JSONL read throws
    mockFs.openSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    exitCallback({ exitCode: 0 });

    const result = await promise;
    expect(result.error).toBe('Failed to read JSONL file after warm');
  });

  // B2 bug fix: previously H3 asserted the warmer should derive cwd from
  // projectDir when called with an empty cwd. The fix moved upstream to
  // discoverSessions (see sessions.test.ts: "when pidInfo is missing, cwd
  // falls back to decoded projectDir"), so the warmer now receives a
  // pre-decoded cwd and just passes it through. The H3 test is obsolete.

  it('passes undefined cwd when not provided', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });

    const promise = warmSession('abc-123', "Reply 'ok'", undefined, 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500);
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500);

    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: assistantLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(assistantLine);
      return assistantLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    exitCallback({ exitCode: 0 });

    const result = await promise;
    expect(result.error).toBeNull();
    expect(mockPty.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['--resume', 'abc-123'],
      expect.objectContaining({ cwd: undefined }),
    );
  });

  it('returns parsed error when JSONL has no assistant message', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500);
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500);

    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: userLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(userLine);
      return userLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    exitCallback({ exitCode: 0 });

    const result = await promise;
    expect(result.error).toContain('No assistant message');
    expect(result.costUsd).toBe(0);
  });

  it('returns error when no new JSONL content found after warm', async () => {
    mockFs.statSync.mockReturnValue({ size: 100 } as fs.Stats);

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500);
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500);

    // JSONL file didn't grow
    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: 100 } as fs.Stats);
    mockFs.closeSync.mockReturnValue(undefined);

    exitCallback({ exitCode: 0 });

    const result = await promise;
    expect(result.error).toBe('No new JSONL content after warm');
  });

  it('handles finish called multiple times (idempotent)', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500);
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500);

    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: assistantLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(assistantLine);
      return assistantLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    // Both exit and grace timeout fire
    exitCallback({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(6000);

    const result = await promise;
    expect(result.error).toBeNull();
  });

  it('handles data received after done phase', async () => {
    mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

    const assistantLine = makeJsonlLine({
      model: 'claude-opus-4-6',
      usage: { cache_read_input_tokens: 80000, output_tokens: 3 },
    });

    const promise = warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');

    dataCallback('> ');
    await vi.advanceTimersByTimeAsync(3500); // sends prompt
    dataCallback('ok\n> ');
    await vi.advanceTimersByTimeAsync(3500); // sends /exit, phase = done

    // Data arrives after phase is 'done' - should not reset settle
    dataCallback('extra output');

    const fd = 42;
    mockFs.openSync.mockReturnValue(fd);
    mockFs.fstatSync.mockReturnValue({ size: assistantLine.length } as fs.Stats);
    mockFs.readSync.mockImplementation((_fd, buf) => {
      (buf as Buffer).write(assistantLine);
      return assistantLine.length;
    });
    mockFs.closeSync.mockReturnValue(undefined);

    exitCallback({ exitCode: 0 });

    const result = await promise;
    expect(result.error).toBeNull();
  });
});

describe('makeWarmer', () => {
  it('returns a warmFn bound to the supplied deps', async () => {
    const warmFn = makeWarmer({});
    // No projectDir → the bound function takes the synchronous error path,
    // exercising the curried call without needing a full PTY fixture.
    const result = await warmFn('abc-123', "Reply 'ok'", '/tmp');
    expect(result.error).toBe('No projectDir provided');
    expect(result.sessionId).toBe('abc-123');
  });
});
