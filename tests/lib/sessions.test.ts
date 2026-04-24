import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverSessions, parseJsonlFile, checkPidAlive, findProjectCwd } from '../../src/lib/sessions.js';
import type { Fs } from '../../src/lib/deps.js';
import * as fs from 'node:fs';

import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

beforeEach(() => {
  vi.resetAllMocks();
  mockOs.homedir.mockReturnValue('/mock-home');
});

/**
 * Minimal in-memory Fs fake keyed by absolute path. Exists alongside the
 * `vi.mock('node:fs')` tests to demonstrate the DI surface — tests that want
 * typed, explicit filesystem state can supply one of these instead of
 * configuring `vi.mocked(fs)` per call.
 */
function memoryFs(state: { dirs: string[]; files: Record<string, string>; entries: Record<string, string[]> }): Fs {
  const exists = (p: string) => state.dirs.includes(p) || p in state.files;
  return {
    existsSync: ((p: fs.PathLike) => exists(p.toString())) as Fs['existsSync'],
    readdirSync: ((p: fs.PathLike) => {
      const entries = state.entries[p.toString()];
      if (!entries) throw new Error(`ENOENT: ${p}`);
      return entries as unknown as fs.Dirent[];
    }) as Fs['readdirSync'],
    readFileSync: ((p: fs.PathOrFileDescriptor) => {
      const key = p.toString();
      if (key in state.files) return state.files[key];
      throw new Error(`ENOENT: ${key}`);
    }) as Fs['readFileSync'],
    statSync: (() => ({ size: 0 }) as fs.Stats) as Fs['statSync'],
    openSync: (() => 0) as Fs['openSync'],
    fstatSync: (() => ({ size: 0 }) as fs.Stats) as Fs['fstatSync'],
    readSync: (() => 0) as Fs['readSync'],
    closeSync: (() => undefined) as Fs['closeSync'],
  };
}

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
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
      JSON.stringify({
        type: 'last-prompt',
        lastPrompt: 'A very long prompt that should be truncated after fifty characters for display purposes',
        sessionId: 'def-456',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'def-456');
    expect(result.name.length).toBeLessThanOrEqual(53); // 50 + "..."
  });

  it('falls back to sessionId if no title and no lastPrompt', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
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
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 0, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, output_tokens: 10 },
        },
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
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result).toBeNull();
  });

  it('skips empty lines in JSONL content', () => {
    const lines = [
      '',
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 },
        },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
      '',
      '   ',
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result).not.toBeNull();
    expect(result!.cacheReadTokens).toBe(1000);
  });

  it('handles assistant message without timestamp', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 0, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 1 },
        },
        timestamp: 12345,
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result).not.toBeNull();
    // timestamp is not a string, so lastTimestamp stays at 0
    expect(result!.lastAssistantTimestamp).toBe(0);
  });

  it('uses the last assistant message for usage data', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, output_tokens: 5 },
        },
        timestamp: '2026-04-04T16:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 90000,
            cache_creation_input_tokens: 5000,
            output_tokens: 20,
          },
        },
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

describe('findProjectCwd (filesystem-aware decoder)', () => {
  function memFs(existingDirs: string[]): import('../../src/lib/deps.js').Fs {
    const set = new Set(existingDirs);
    return {
      existsSync: ((p: import('node:fs').PathLike) => set.has(p.toString())) as never,
      readdirSync: (() => []) as never,
      readFileSync: (() => '') as never,
      statSync: ((p: import('node:fs').PathLike) => {
        if (!set.has(p.toString())) throw new Error('ENOENT');
        return { isDirectory: () => true } as import('node:fs').Stats;
      }) as never,
      openSync: (() => 0) as never,
      fstatSync: (() => ({ size: 0 }) as import('node:fs').Stats) as never,
      readSync: (() => 0) as never,
      closeSync: (() => undefined) as never,
    };
  }

  it('recovers a path with no hyphen ambiguity', () => {
    const fs = memFs(['/Users', '/Users/test', '/Users/test/dev']);
    expect(findProjectCwd(fs, '-Users-test-dev')).toBe('/Users/test/dev');
  });

  it('recovers a path containing a hyphen in the last segment (the claude-warmer case)', () => {
    const fs = memFs(['/Users', '/Users/test', '/Users/test/dev', '/Users/test/dev/claude-warmer']);
    expect(findProjectCwd(fs, '-Users-test-dev-claude-warmer')).toBe('/Users/test/dev/claude-warmer');
  });

  it('prefers the / split when both /a/b and /a-b exist (greedy left-to-right)', () => {
    const fs = memFs(['/foo', '/foo/bar', '/foo-bar']);
    expect(findProjectCwd(fs, '-foo-bar')).toBe('/foo/bar');
  });

  it('falls through to /a-b when /a/b does not exist', () => {
    const fs = memFs(['/foo-bar']);
    expect(findProjectCwd(fs, '-foo-bar')).toBe('/foo-bar');
  });

  it('returns null when no traversal reaches the end', () => {
    const fs = memFs(['/Users', '/Users/test']);
    expect(findProjectCwd(fs, '-Users-test-doesnotexist')).toBeNull();
  });

  it('returns null on a malformed (no leading hyphen) input', () => {
    const fs = memFs([]);
    expect(findProjectCwd(fs, 'no-leading-dash')).toBeNull();
  });

  it('returns null on an empty input (no parts)', () => {
    const fs = memFs([]);
    expect(findProjectCwd(fs, '-')).toBeNull();
  });

  it('handles nested hyphens in interior segments (recursive backtrack)', () => {
    const fs = memFs(['/a', '/a/b-c', '/a/b-c/d']);
    expect(findProjectCwd(fs, '-a-b-c-d')).toBe('/a/b-c/d');
  });
});

describe('discoverSessions', () => {
  it('returns empty array when no project dirs exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    const sessions = discoverSessions();
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
            message: {
              role: 'assistant',
              model: 'claude-opus-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 80000,
                cache_creation_input_tokens: 2000,
                output_tokens: 10,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('999.json')) {
        return JSON.stringify({
          pid: 999,
          sessionId: 'abc-123',
          cwd: '/home/user/project',
          startedAt: Date.now(),
          kind: 'interactive',
        });
      }
      return '';
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('abc-123');
    expect(sessions[0].name).toBe('Test Session');
    expect(sessions[0].cwd).toBe('/home/user/project');
    expect(sessions[0].isLive).toBe(false);
    expect(sessions[0].isWarm).toBe(true);
  });

  it('handles sessions dir not existing for loadPidFiles', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.endsWith('/projects')) return true;
      if (s.endsWith('/sessions')) return false;
      return false;
    });
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['abc-123.jsonl'] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      return '';
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    // No PID info and decoded path fails stat(), so cwd is empty.
    expect(sessions[0].cwd).toBe('');
    expect(sessions[0].isLive).toBe(false);
  });

  it('when pidInfo is missing and decoded path stat()s, cwd falls back to decoded projectDir', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['-Users-test-dev'] as unknown as fs.Dirent[];
      }
      if (p.includes('-Users-test-dev')) {
        return ['abc-123.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        // No PID files => no pidInfo for the discovered session
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      return '';
    });
    // Stat the decoded path — succeeds, so the fallback is used.
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('/Users/test/dev');
  });

  it('when pidInfo is missing and decoded path does not stat(), cwd is empty', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) return ['-dev-claude-warmer'] as unknown as fs.Dirent[];
      if (p.includes('-dev-claude-warmer')) return ['abc.jsonl'] as unknown as fs.Dirent[];
      if (p.endsWith('/sessions')) return [] as unknown as fs.Dirent[];
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc.jsonl')) {
        return JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-6',
            usage: { input_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 },
          },
          timestamp: new Date().toISOString(),
        });
      }
      return '';
    });
    mockFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('');
  });

  it('when pidInfo is missing but a sibling PID file records the cwd, sibling wins over naive decode', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) return ['-Users-test-dev-claude-warmer'] as unknown as fs.Dirent[];
      if (p.includes('-Users-test-dev-claude-warmer')) return ['abc.jsonl'] as unknown as fs.Dirent[];
      if (p.endsWith('/sessions')) return ['999.json'] as unknown as fs.Dirent[];
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc.jsonl')) {
        return JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-6',
            usage: { input_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 },
          },
          timestamp: new Date().toISOString(),
        });
      }
      if (p.endsWith('999.json')) {
        return JSON.stringify({
          pid: 999,
          sessionId: 'some-other-session',
          cwd: '/Users/test/dev/claude-warmer',
          startedAt: Date.now(),
          kind: 'interactive',
        });
      }
      return '';
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    // Authoritative cwd from sibling PID file — preserves the `-` in
    // `claude-warmer`, unlike the naive decode which would produce
    // `/Users/test/dev/claude/warmer`.
    expect(sessions[0].cwd).toBe('/Users/test/dev/claude-warmer');
  });

  it('handles corrupt PID JSON files gracefully', () => {
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
        return ['bad.json'] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('bad.json')) {
        return 'NOT VALID JSON!!!';
      }
      return '';
    });

    const sessions = discoverSessions();
    // Should still discover the session; corrupt PID file means no sibling
    // lookup, and the decoded path fails stat(), so cwd is empty.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('');
  });

  it('handles readFileSync errors on JSONL files', () => {
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
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const sessions = discoverSessions();
    // Should skip the unreadable file
    expect(sessions).toHaveLength(0);
  });

  it('handles readdirSync errors on project directories', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['bad-project'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return [] as unknown as fs.Dirent[];
      }
      // Throw for the project directory itself
      throw new Error('EACCES');
    });

    const sessions = discoverSessions();
    // Should skip the unreadable project dir
    expect(sessions).toHaveLength(0);
  });

  it('uses empty model when session model is not set', () => {
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
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: '',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      return '';
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].model).toBe('');
  });

  it('skips non-json files in sessions dir', () => {
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
        return ['readme.txt', '999.json'] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('999.json')) {
        return JSON.stringify({
          pid: 999,
          sessionId: 'abc-123',
          cwd: '/test',
          startedAt: Date.now(),
          kind: 'interactive',
        });
      }
      return '';
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
  });

  it('skips JSONL files that parse to null (no assistant messages)', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['empty.jsonl', 'valid.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('empty.jsonl')) {
        // No assistant messages, parseJsonlFile returns null
        return JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
      }
      if (p.endsWith('valid.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      return '';
    });

    const sessions = discoverSessions();
    // Only the valid session should be returned
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('valid');
  });

  it('sorts sessions by active first, then cached tokens descending', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['small.jsonl', 'large.jsonl', 'cold.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('small.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 500,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('large.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 100000,
                cache_creation_input_tokens: 5000,
                output_tokens: 10,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('cold.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 200000,
                cache_creation_input_tokens: 10000,
                output_tokens: 10,
              },
            },
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          }),
        ].join('\n');
      }
      return '';
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(3);
    // Active (warm) sessions first sorted by cached tokens, then cold
    expect(sessions[0].sessionId).toBe('large');
    expect(sessions[0].isWarm).toBe(true);
    expect(sessions[1].sessionId).toBe('small');
    expect(sessions[1].isWarm).toBe(true);
    expect(sessions[2].sessionId).toBe('cold');
    expect(sessions[2].isWarm).toBe(false);
  });

  it('sorts live sessions as active even if cold', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['cold-session.jsonl', 'live-session.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return ['999.json'] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('cold-session.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 200000,
                cache_creation_input_tokens: 10000,
                output_tokens: 1,
              },
            },
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('live-session.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 500,
                output_tokens: 1,
              },
            },
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('999.json')) {
        return JSON.stringify({
          pid: 999,
          sessionId: 'live-session',
          cwd: '/test',
          startedAt: Date.now(),
          kind: 'interactive',
        });
      }
      return '';
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(2);
    // Live session should be first (active) even though it has fewer tokens and is cold by timestamp
    expect(sessions[0].sessionId).toBe('live-session');
    expect(sessions[0].isLive).toBe(true);
    expect(sessions[1].sessionId).toBe('cold-session');
  });

  it('sorts by three tiers: live first, then warm, then cold', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['warm-session.jsonl', 'cold-session.jsonl', 'live-a.jsonl', 'live-b.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return ['998.json', '999.json'] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('cold-session.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 200000,
                cache_creation_input_tokens: 10000,
                output_tokens: 1,
              },
            },
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('warm-session.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 50000,
                cache_creation_input_tokens: 1000,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('live-a.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 500,
                output_tokens: 1,
              },
            },
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('live-b.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 2000,
                cache_creation_input_tokens: 500,
                output_tokens: 1,
              },
            },
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('998.json')) {
        return JSON.stringify({
          pid: 998,
          sessionId: 'live-a',
          cwd: '/test',
          startedAt: Date.now(),
          kind: 'interactive',
        });
      }
      if (p.endsWith('999.json')) {
        return JSON.stringify({
          pid: 999,
          sessionId: 'live-b',
          cwd: '/test',
          startedAt: Date.now(),
          kind: 'interactive',
        });
      }
      return '';
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(4);
    // Two live sessions sorted by cached tokens desc
    expect(sessions[0].sessionId).toBe('live-b');
    expect(sessions[0].isLive).toBe(true);
    expect(sessions[1].sessionId).toBe('live-a');
    expect(sessions[1].isLive).toBe(true);
    // Then warm
    expect(sessions[2].sessionId).toBe('warm-session');
    expect(sessions[2].isWarm).toBe(true);
    expect(sessions[2].isLive).toBe(false);
    // Then cold
    expect(sessions[3].sessionId).toBe('cold-session');
    expect(sessions[3].isWarm).toBe(false);
  });

  it('filters out sessions with 0 total cached tokens', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['empty-cache.jsonl', 'has-cache.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('empty-cache.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('has-cache.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 5000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      return '';
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('has-cache');
  });

  it('accepts an injected Fs and reads through it (DI smoke test)', () => {
    mockOs.homedir.mockReturnValue('/mock-home');
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 7777,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
        },
      },
      timestamp: new Date().toISOString(),
    });

    const fake = memoryFs({
      dirs: ['/mock-home/.claude/projects', '/mock-home/.claude/projects/proj'],
      files: {
        '/mock-home/.claude/projects/proj/abc.jsonl': jsonl,
      },
      entries: {
        '/mock-home/.claude/projects': ['proj'],
        '/mock-home/.claude/projects/proj': ['abc.jsonl'],
      },
    });

    const sessions = discoverSessions(fake);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('abc');
    expect(sessions[0].cacheReadTokens).toBe(7777);
  });

  it('initializes warmCostUsd with estimated warm cost', () => {
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
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 100000,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      return '';
    });

    const sessions = discoverSessions();
    expect(sessions).toHaveLength(1);
    // warmCostUsd is now always initialized to 0 (static display computed in session-row)
    expect(sessions[0].warmCostUsd).toBe(0);
  });
});
