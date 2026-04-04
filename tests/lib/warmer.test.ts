import { describe, it, expect, vi, beforeEach } from 'vitest';
import { warmSession, parseWarmOutput } from '../../src/lib/warmer.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process');

const mockCp = vi.mocked(child_process);

describe('parseWarmOutput', () => {
  it('parses valid JSON output with usage', () => {
    const output = JSON.stringify({
      result: 'OK',
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 100000,
        cache_creation_input_tokens: 500,
        output_tokens: 5,
      },
    });

    const result = parseWarmOutput(output);
    expect(result.usage.cacheReadInputTokens).toBe(100000);
    expect(result.usage.cacheCreationInputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.error).toBeNull();
  });

  it('handles JSON with missing usage fields gracefully', () => {
    const output = JSON.stringify({
      result: 'OK',
      model: 'claude-opus-4-6',
      usage: {},
    });

    const result = parseWarmOutput(output);
    expect(result.usage.cacheReadInputTokens).toBe(0);
    expect(result.usage.cacheCreationInputTokens).toBe(0);
    expect(result.error).toBeNull();
  });

  it('returns error for invalid JSON', () => {
    const result = parseWarmOutput('NOT JSON AT ALL');
    expect(result.error).toContain('Failed to parse');
  });

  it('returns error for JSON without usage', () => {
    const output = JSON.stringify({ result: 'OK' });
    const result = parseWarmOutput(output);
    expect(result.error).toContain('No usage data');
  });

  it('falls back to empty string when model is missing from valid usage response', () => {
    const output = JSON.stringify({
      result: 'OK',
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    });
    const result = parseWarmOutput(output);
    expect(result.model).toBe('');
    expect(result.error).toBeNull();
  });

  it('falls back to empty string when model is missing from no-usage response', () => {
    const output = JSON.stringify({ result: 'OK' });
    const result = parseWarmOutput(output);
    expect(result.model).toBe('');
  });
});

describe('warmSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('spawns claude CLI and returns parsed result on success', async () => {
    const jsonOutput = JSON.stringify({
      result: 'OK',
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 80000,
        cache_creation_input_tokens: 1000,
        output_tokens: 3,
      },
    });

    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, jsonOutput, '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('abc-123', 'Reply with only the word OK');
    expect(result.sessionId).toBe('abc-123');
    expect(result.usage.cacheReadInputTokens).toBe(80000);
    expect(result.error).toBeNull();
  });

  it('returns error when CLI fails', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('Command failed'), '', 'session not found');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('bad-id', 'Reply with only the word OK');
    expect(result.error).toContain('Command failed');
  });

  it('returns error on timeout', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error('TIMEOUT') as NodeJS.ErrnoException;
      err.killed = true;
      (callback as Function)(err, '', '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('timeout-id', 'Reply with only the word OK');
    expect(result.error).toContain('TIMEOUT');
  });

  it('returns costUsd 0 when CLI succeeds but output has parse error', async () => {
    const jsonOutput = JSON.stringify({ result: 'OK' }); // No usage field

    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, jsonOutput, '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('abc-123', 'Reply with only the word OK');
    expect(result.error).toContain('No usage data');
    expect(result.costUsd).toBe(0);
  });

  it('returns error when CLI fails without stderr', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('Command failed'), '', '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('bad-id', 'Reply with only the word OK');
    expect(result.error).toBe('Command failed');
  });
});
