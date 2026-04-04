import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverSessions, parseJsonlFile, checkPidAlive } from '../../src/lib/sessions.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

beforeEach(() => {
  vi.resetAllMocks();
  mockOs.homedir.mockReturnValue('/mock-home');
});

describe('parseJsonlFile', () => {
  it('extracts session data from valid JSONL', () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'My Session', sessionId: 'abc-123' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 100000,
            cache_creation_input_tokens: 5000,
            output_tokens: 50,
          },
        },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'Fix the login bug', sessionId: 'abc-123' }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result.name).toBe('My Session');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.cacheReadTokens).toBe(100000);
    expect(result.cacheWriteTokens).toBe(5000);
    expect(result.lastAssistantTimestamp).toBe(new Date('2026-04-04T17:00:00.000Z').getTime());
  });

  it('falls back to lastPrompt if no custom title', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'A very long prompt that should be truncated after fifty characters for display purposes', sessionId: 'def-456' }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'def-456');
    expect(result.name.length).toBeLessThanOrEqual(53); // 50 + "..."
  });

  it('falls back to sessionId if no title and no lastPrompt', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'def-456-789');
    expect(result.name).toBe('def-456-789');
  });

  it('skips corrupted lines without crashing', () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'Good Session', sessionId: 'abc-123' }),
      'THIS IS NOT JSON {{{',
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, output_tokens: 10 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result.name).toBe('Good Session');
    expect(result.cacheReadTokens).toBe(50000);
  });

  it('returns null if no assistant messages found', () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'Empty', sessionId: 'abc-123' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-04-04T17:00:00.000Z' }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result).toBeNull();
  });

  it('uses the last assistant message for usage data', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, output_tokens: 5 } },
        timestamp: '2026-04-04T16:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000, output_tokens: 20 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result!.cacheReadTokens).toBe(90000);
    expect(result!.cacheWriteTokens).toBe(5000);
    expect(result!.lastAssistantTimestamp).toBe(new Date('2026-04-04T17:00:00.000Z').getTime());
  });
});

describe('checkPidAlive', () => {
  it('returns true for a live process', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(checkPidAlive(12345)).toBe(true);
  });

  it('returns false for a dead process', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(checkPidAlive(99999)).toBe(false);
  });
});

describe('discoverSessions', () => {
  it('returns empty array when no project dirs exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    const sessions = discoverSessions('claude-sonnet-4-6');
    expect(sessions).toEqual([]);
  });

  it('discovers sessions from JSONL files and cross-references PID files', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['abc-123.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return ['999.json'] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({ type: 'custom-title', customTitle: 'Test Session', sessionId: 'abc-123' }),
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 80000, cache_creation_input_tokens: 2000, output_tokens: 10 } },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('999.json')) {
        return JSON.stringify({ pid: 999, sessionId: 'abc-123', cwd: '/home/user/project', startedAt: Date.now(), kind: 'interactive' });
      }
      return '';
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const sessions = discoverSessions('claude-sonnet-4-6');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('abc-123');
    expect(sessions[0].name).toBe('Test Session');
    expect(sessions[0].cwd).toBe('/home/user/project');
    expect(sessions[0].isLive).toBe(false);
    expect(sessions[0].isWarm).toBe(true);
  });
});
