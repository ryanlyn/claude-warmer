import { describe, it, expect, vi, beforeEach } from 'vitest';
import { warmSession, parseWarmOutput } from '../../src/lib/warmer.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process');

const mockCp = vi.mocked(child_process);

function makeCliOutput(overrides: { result?: Record<string, unknown>; assistant?: Record<string, unknown> } = {}) {
  const entries: Record<string, unknown>[] = [];
  if (overrides.assistant) {
    entries.push({ type: 'assistant', ...overrides.assistant });
  }
  if (overrides.result) {
    entries.push({ type: 'result', ...overrides.result });
  }
  return JSON.stringify(entries);
}

describe('parseWarmOutput', () => {
  it('parses valid JSON array with result and assistant entries', () => {
    const output = makeCliOutput({
      assistant: { message: { model: 'claude-opus-4-6' } },
      result: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 100000,
          cache_creation_input_tokens: 500,
          output_tokens: 5,
        },
      },
    });

    const result = parseWarmOutput(output);
    expect(result.usage.cacheReadInputTokens).toBe(100000);
    expect(result.usage.cacheCreationInputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.error).toBeNull();
  });

  it('handles result with missing usage fields gracefully', () => {
    const output = makeCliOutput({
      assistant: { message: { model: 'claude-opus-4-6' } },
      result: { usage: {} },
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

  it('returns error when no result entry exists', () => {
    const output = JSON.stringify([{ type: 'assistant', message: { model: 'claude-opus-4-6' } }]);
    const result = parseWarmOutput(output);
    expect(result.error).toContain('No result entry');
  });

  it('returns error when result has no usage', () => {
    const output = makeCliOutput({ result: { subtype: 'success' } });
    const result = parseWarmOutput(output);
    expect(result.error).toContain('No usage data');
  });

  it('extracts model from assistant entry', () => {
    const output = makeCliOutput({
      assistant: { message: { model: 'claude-sonnet-4-6' } },
      result: { usage: { input_tokens: 1, cache_read_input_tokens: 100, output_tokens: 1 } },
    });
    const result = parseWarmOutput(output);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to empty model when no assistant entry', () => {
    const output = makeCliOutput({
      result: { usage: { input_tokens: 1, cache_read_input_tokens: 100, output_tokens: 1 } },
    });
    const result = parseWarmOutput(output);
    expect(result.model).toBe('');
    expect(result.error).toBeNull();
  });

  it('handles single object (non-array) input', () => {
    const output = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 2 },
    });
    const result = parseWarmOutput(output);
    expect(result.usage.cacheReadInputTokens).toBe(50);
    expect(result.error).toBeNull();
  });
});

describe('warmSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('spawns claude CLI and returns parsed result on success', async () => {
    const jsonOutput = makeCliOutput({
      assistant: { message: { model: 'claude-opus-4-6' } },
      result: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 80000,
          cache_creation_input_tokens: 1000,
          output_tokens: 3,
        },
      },
    });

    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, jsonOutput, '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('abc-123', "Reply 'ok'");
    expect(result.sessionId).toBe('abc-123');
    expect(result.usage.cacheReadInputTokens).toBe(80000);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.error).toBeNull();
  });

  it('returns error when CLI fails', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('Command failed'), '', 'session not found');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('bad-id', "Reply 'ok'");
    expect(result.error).toContain('Command failed');
  });

  it('returns error on timeout', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error('TIMEOUT') as NodeJS.ErrnoException;
      err.killed = true;
      (callback as Function)(err, '', '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('timeout-id', "Reply 'ok'");
    expect(result.error).toContain('TIMEOUT');
  });

  it('returns costUsd 0 when output has no usage', async () => {
    const jsonOutput = makeCliOutput({ result: { subtype: 'success' } });

    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, jsonOutput, '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('abc-123', "Reply 'ok'");
    expect(result.error).toContain('No usage data');
    expect(result.costUsd).toBe(0);
  });

  it('returns error when CLI fails without stderr', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('Command failed'), '', '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('bad-id', "Reply 'ok'");
    expect(result.error).toBe('Command failed');
  });
});
