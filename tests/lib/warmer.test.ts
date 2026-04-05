import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { warmSession, extractUsageFromNewLines, getJsonlPath } from '../../src/lib/warmer.js';
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
    const line1 = makeJsonlLine({ model: 'claude-sonnet-4-6', usage: { cache_read_input_tokens: 1000, output_tokens: 1 } });
    const line2 = makeJsonlLine({ model: 'claude-opus-4-6', usage: { cache_read_input_tokens: 80000, output_tokens: 3 } });
    const content = line1 + '\n' + line2;

    const result = extractUsageFromNewLines(content);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.usage.cacheReadInputTokens).toBe(80000);
  });

  it('skips non-assistant messages to find the assistant one', () => {
    const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
    const assistantLine = makeJsonlLine({ model: 'claude-opus-4-6', usage: { cache_read_input_tokens: 50000, output_tokens: 2 } });
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

    mockCp.execFileSync.mockReturnValue('claude\n' as never);

    mockPtyProcess = {
      onData: vi.fn((cb) => { dataCallback = cb; }),
      onExit: vi.fn((cb) => { exitCallback = cb; }),
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
    const jsonlPath = getJsonlPath('my-project', 'abc-123');
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
    mockPty.spawn.mockImplementation(() => { throw new Error('spawn failed'); });

    const result = await warmSession('abc-123', "Reply 'ok'", '/test', 'my-project');
    expect(result.error).toContain('Failed to spawn PTY');
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
});
