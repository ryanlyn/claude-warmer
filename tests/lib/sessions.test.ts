import { afterAll, beforeAll, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import process from 'node:process';
import type * as fs from 'node:fs';
import { checkPidAlive, discoverSessions, findProjectCwd, parseJsonlFile } from '../../src/lib/sessions.ts';
import type { Clock, Fs } from '../../src/lib/deps.ts';

const FIXED_NOW = new Date('2026-05-12T12:00:00.000Z').getTime();

const fixedClock: Clock = {
  now: () => FIXED_NOW,
  setInterval: globalThis.setInterval as unknown as typeof globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setTimeout: globalThis.setTimeout as unknown as typeof globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

const HOME = '/mock-home';
let originalHome: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = HOME;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

interface FakeFsState {
  files?: Record<string, string>;
  dirs?: string[];
  entries?: Record<string, string[]>;
  statThrows?: boolean;
  readFileThrows?: boolean;
  readDirThrows?: (path: string) => boolean;
}

function makeFakeFs(state: FakeFsState): Fs {
  const files = state.files ?? {};
  const dirs = new Set(state.dirs ?? []);
  const entries = state.entries ?? {};
  return {
    existsSync: ((p: fs.PathLike) => {
      const key = p.toString();
      return dirs.has(key) || key in files || key in entries;
    }) as Fs['existsSync'],
    readdirSync: ((p: fs.PathLike) => {
      const key = p.toString();
      if (state.readDirThrows && state.readDirThrows(key)) {
        throw new Error('EACCES');
      }
      if (!(key in entries)) throw new Error(`ENOENT: ${key}`);
      return entries[key] as unknown as fs.Dirent[];
    }) as Fs['readdirSync'],
    readFileSync: ((p: fs.PathOrFileDescriptor) => {
      const key = p.toString();
      if (state.readFileThrows) throw new Error('EACCES');
      if (key in files) return files[key];
      throw new Error(`ENOENT: ${key}`);
    }) as Fs['readFileSync'],
    statSync: ((p: fs.PathLike) => {
      if (state.statThrows) throw new Error('ENOENT');
      const key = p.toString();
      const isDir = dirs.has(key) || key in entries;
      return { size: 0, isDirectory: () => isDir } as fs.Stats;
    }) as Fs['statSync'],
    openSync: (() => 0) as Fs['openSync'],
    fstatSync: (() => ({ size: 0 }) as fs.Stats) as Fs['fstatSync'],
    readSync: (() => 0) as Fs['readSync'],
    closeSync: (() => undefined) as Fs['closeSync'],
  };
}

function buildJsonl(opts: {
  model?: string;
  cacheRead?: number;
  cacheWrite?: number;
  outputTokens?: number;
  inputTokens?: number;
  timestamp?: string | number;
  customTitle?: string;
  lastPrompt?: string;
  sessionId?: string;
}): string {
  const lines: string[] = [];
  if (opts.customTitle) {
    lines.push(
      JSON.stringify({ type: 'custom-title', customTitle: opts.customTitle, sessionId: opts.sessionId ?? 'x' }),
    );
  }
  lines.push(JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
        output_tokens: opts.outputTokens ?? 1,
      },
    },
    timestamp: opts.timestamp ?? new Date(FIXED_NOW).toISOString(),
  }));
  if (opts.lastPrompt) {
    lines.push(JSON.stringify({ type: 'last-prompt', lastPrompt: opts.lastPrompt, sessionId: opts.sessionId ?? 'x' }));
  }
  return lines.join('\n');
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
    expect(result!.name).toBe('My Session');
    expect(result!.model).toBe('claude-opus-4-6');
    expect(result!.cacheReadTokens).toBe(100000);
    expect(result!.cacheWriteTokens).toBe(5000);
    expect(result!.lastAssistantTimestamp).toBe(new Date('2026-04-04T17:00:00.000Z').getTime());
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
    expect(result!.name.length).toBeLessThanOrEqual(53);
  });

  it('falls back to sessionId if no title and no lastPrompt', () => {
    const lines = [JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      },
      timestamp: '2026-04-04T17:00:00.000Z',
    })].join('\n');

    const result = parseJsonlFile(lines, 'def-456-789');
    expect(result!.name).toBe('def-456-789');
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
    expect(result!.name).toBe('Good Session');
    expect(result!.cacheReadTokens).toBe(50000);
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
    const lines = [JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: { input_tokens: 0, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 1 },
      },
      timestamp: 12345,
    })].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result).not.toBeNull();
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
    expect(checkPidAlive(12345, () => {})).toBe(true);
  });

  it('returns false for a dead process', () => {
    expect(
      checkPidAlive(99999, () => {
        throw new Error('ESRCH');
      }),
    ).toBe(false);
  });
});

describe('findProjectCwd (filesystem-aware decoder)', () => {
  function dirsFs(existingDirs: string[]): Fs {
    const set = new Set(existingDirs);
    return {
      existsSync: ((p: fs.PathLike) => set.has(p.toString())) as Fs['existsSync'],
      readdirSync: (() => []) as Fs['readdirSync'],
      readFileSync: (() => '') as Fs['readFileSync'],
      statSync: ((p: fs.PathLike) => {
        if (!set.has(p.toString())) throw new Error('ENOENT');
        return { isDirectory: () => true } as fs.Stats;
      }) as Fs['statSync'],
      openSync: (() => 0) as Fs['openSync'],
      fstatSync: (() => ({ size: 0 }) as fs.Stats) as Fs['fstatSync'],
      readSync: (() => 0) as Fs['readSync'],
      closeSync: (() => undefined) as Fs['closeSync'],
    };
  }

  it('recovers a path with no hyphen ambiguity', () => {
    expect(findProjectCwd(dirsFs(['/Users', '/Users/test', '/Users/test/dev']), '-Users-test-dev')).toBe(
      '/Users/test/dev',
    );
  });

  it('recovers a path containing a hyphen in the last segment (the claude-warmer case)', () => {
    expect(
      findProjectCwd(
        dirsFs(['/Users', '/Users/test', '/Users/test/dev', '/Users/test/dev/claude-warmer']),
        '-Users-test-dev-claude-warmer',
      ),
    ).toBe('/Users/test/dev/claude-warmer');
  });

  it('prefers the / split when both /a/b and /a-b exist (greedy left-to-right)', () => {
    expect(findProjectCwd(dirsFs(['/foo', '/foo/bar', '/foo-bar']), '-foo-bar')).toBe('/foo/bar');
  });

  it('falls through to /a-b when /a/b does not exist', () => {
    expect(findProjectCwd(dirsFs(['/foo-bar']), '-foo-bar')).toBe('/foo-bar');
  });

  it('returns null when no traversal reaches the end', () => {
    expect(findProjectCwd(dirsFs(['/Users', '/Users/test']), '-Users-test-doesnotexist')).toBeNull();
  });

  it('returns null on a malformed (no leading hyphen) input', () => {
    expect(findProjectCwd(dirsFs([]), 'no-leading-dash')).toBeNull();
  });

  it('returns null on an empty input (no parts)', () => {
    expect(findProjectCwd(dirsFs([]), '-')).toBeNull();
  });

  it('handles nested hyphens in interior segments (recursive backtrack)', () => {
    expect(findProjectCwd(dirsFs(['/a', '/a/b-c', '/a/b-c/d']), '-a-b-c-d')).toBe('/a/b-c/d');
  });
});

describe('discoverSessions', () => {
  // Each test gets its own FakeFs; nothing leaks because we always pass it
  // explicitly to discoverSessions.
  it('returns empty array when no project dirs exist', () => {
    const fake = makeFakeFs({ files: {}, dirs: [], entries: {} });
    expect(discoverSessions(fake, fixedClock)).toEqual([]);
  });

  it('discovers sessions from JSONL files and cross-references PID files', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['abc-123.jsonl'],
        [`${HOME}/.claude/sessions`]: ['999.json'],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/abc-123.jsonl`]: buildJsonl({
          customTitle: 'Test Session',
          model: 'claude-opus-4-6',
          cacheRead: 80000,
          cacheWrite: 2000,
          outputTokens: 10,
          sessionId: 'abc-123',
        }),
        [`${HOME}/.claude/sessions/999.json`]: JSON.stringify({
          pid: 999,
          sessionId: 'abc-123',
          cwd: '/home/user/project',
          startedAt: FIXED_NOW,
          kind: 'interactive',
        }),
      },
    });
    // Inject a dead-PID kill so the pid is reported not live, but we need to
    // also use sessions.ts's checkPidAlive default which calls process.kill.
    // Stubbing process.kill for this test:
    const original = process.kill;
    process.kill = ((..._args: unknown[]) => {
      throw new Error('ESRCH');
    }) as typeof process.kill;
    try {
      const sessions = discoverSessions(fake, fixedClock);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('abc-123');
      expect(sessions[0].name).toBe('Test Session');
      expect(sessions[0].cwd).toBe('/home/user/project');
      expect(sessions[0].isLive).toBe(false);
      expect(sessions[0].isWarm).toBe(true);
    } finally {
      process.kill = original;
    }
  });

  it('handles sessions dir not existing for loadPidFiles', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['abc-123.jsonl'],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/abc-123.jsonl`]: buildJsonl({
          model: 'claude-opus-4-6',
          cacheRead: 1000,
        }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('');
    expect(sessions[0].isLive).toBe(false);
  });

  it('when pidInfo is missing and decoded path stat()s, cwd falls back to decoded projectDir', () => {
    const fake = makeFakeFs({
      dirs: [
        `${HOME}/.claude/projects`,
        `${HOME}/.claude/projects/-Users-test-dev`,
        `${HOME}/.claude/sessions`,
        '/Users',
        '/Users/test',
        '/Users/test/dev',
      ],
      entries: {
        [`${HOME}/.claude/projects`]: ['-Users-test-dev'],
        [`${HOME}/.claude/projects/-Users-test-dev`]: ['abc-123.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        [`${HOME}/.claude/projects/-Users-test-dev/abc-123.jsonl`]: buildJsonl({
          model: 'claude-opus-4-6',
          cacheRead: 1000,
        }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('/Users/test/dev');
  });

  it('when pidInfo is missing and decoded path does not stat(), cwd is empty', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/-dev-some-cache`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['-dev-some-cache'],
        [`${HOME}/.claude/projects/-dev-some-cache`]: ['abc.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        [`${HOME}/.claude/projects/-dev-some-cache/abc.jsonl`]: buildJsonl({
          model: 'claude-opus-4-6',
          cacheRead: 1000,
        }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('');
  });

  it('when pidInfo is missing but a sibling PID file records the cwd, sibling wins over naive decode', () => {
    const fake = makeFakeFs({
      dirs: [
        `${HOME}/.claude/projects`,
        `${HOME}/.claude/projects/-Users-test-dev-claude-warmer`,
        `${HOME}/.claude/sessions`,
      ],
      entries: {
        [`${HOME}/.claude/projects`]: ['-Users-test-dev-claude-warmer'],
        [`${HOME}/.claude/projects/-Users-test-dev-claude-warmer`]: ['abc.jsonl'],
        [`${HOME}/.claude/sessions`]: ['999.json'],
      },
      files: {
        [`${HOME}/.claude/projects/-Users-test-dev-claude-warmer/abc.jsonl`]: buildJsonl({
          model: 'claude-opus-4-6',
          cacheRead: 1000,
        }),
        [`${HOME}/.claude/sessions/999.json`]: JSON.stringify({
          pid: 999,
          sessionId: 'some-other-session',
          cwd: '/Users/test/dev/claude-warmer',
          startedAt: FIXED_NOW,
          kind: 'interactive',
        }),
      },
    });
    const original = process.kill;
    process.kill = ((..._args: unknown[]) => {
      throw new Error('ESRCH');
    }) as typeof process.kill;
    try {
      const sessions = discoverSessions(fake, fixedClock);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].cwd).toBe('/Users/test/dev/claude-warmer');
    } finally {
      process.kill = original;
    }
  });

  it('handles corrupt PID JSON files gracefully', () => {
    const fake = makeFakeFs({
      dirs: [
        `${HOME}/.claude/projects`,
        `${HOME}/.claude/projects/my-project`,
        `${HOME}/.claude/sessions`,
      ],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['abc-123.jsonl'],
        [`${HOME}/.claude/sessions`]: ['bad.json'],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/abc-123.jsonl`]: buildJsonl({
          model: 'claude-opus-4-6',
          cacheRead: 1000,
        }),
        [`${HOME}/.claude/sessions/bad.json`]: 'NOT VALID JSON!!!',
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('');
  });

  it('handles readFileSync errors on JSONL files', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['abc-123.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        // intentionally not registered so readFileSync throws
      },
      readFileThrows: true,
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(0);
  });

  it('handles readdirSync errors on project directories', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/bad-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['bad-project'],
        [`${HOME}/.claude/sessions`]: [],
      },
      readDirThrows: (p) => p.endsWith('bad-project'),
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(0);
  });

  it('uses empty model when session model is not set', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['abc-123.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/abc-123.jsonl`]: buildJsonl({
          model: '',
          cacheRead: 1000,
        }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].model).toBe('');
  });

  it('skips non-json files in sessions dir', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['abc-123.jsonl'],
        [`${HOME}/.claude/sessions`]: ['readme.txt', '999.json'],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/abc-123.jsonl`]: buildJsonl({
          model: 'claude-opus-4-6',
          cacheRead: 1000,
        }),
        [`${HOME}/.claude/sessions/999.json`]: JSON.stringify({
          pid: 999,
          sessionId: 'abc-123',
          cwd: '/test',
          startedAt: FIXED_NOW,
          kind: 'interactive',
        }),
      },
    });
    const original = process.kill;
    process.kill = ((..._args: unknown[]) => {
      throw new Error('ESRCH');
    }) as typeof process.kill;
    try {
      const sessions = discoverSessions(fake, fixedClock);
      expect(sessions).toHaveLength(1);
    } finally {
      process.kill = original;
    }
  });

  it('skips JSONL files that parse to null (no assistant messages)', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['empty.jsonl', 'valid.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/empty.jsonl`]: JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'hello' },
        }),
        [`${HOME}/.claude/projects/my-project/valid.jsonl`]: buildJsonl({
          model: 'claude-opus-4-6',
          cacheRead: 1000,
        }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('valid');
  });

  it('sorts sessions by active first, then cached tokens descending', () => {
    const recent = new Date(FIXED_NOW).toISOString();
    const old = new Date(FIXED_NOW - 2 * 60 * 60 * 1000).toISOString();
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['small.jsonl', 'large.jsonl', 'cold.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/small.jsonl`]: buildJsonl({
          cacheRead: 1000,
          cacheWrite: 500,
          timestamp: recent,
        }),
        [`${HOME}/.claude/projects/my-project/large.jsonl`]: buildJsonl({
          cacheRead: 100000,
          cacheWrite: 5000,
          timestamp: recent,
        }),
        [`${HOME}/.claude/projects/my-project/cold.jsonl`]: buildJsonl({
          cacheRead: 200000,
          cacheWrite: 10000,
          timestamp: old,
        }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(3);
    expect(sessions[0].sessionId).toBe('large');
    expect(sessions[0].isWarm).toBe(true);
    expect(sessions[1].sessionId).toBe('small');
    expect(sessions[1].isWarm).toBe(true);
    expect(sessions[2].sessionId).toBe('cold');
    expect(sessions[2].isWarm).toBe(false);
  });

  it('sorts live sessions as active even if cold', () => {
    const old = new Date(FIXED_NOW - 2 * 60 * 60 * 1000).toISOString();
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['cold-session.jsonl', 'live-session.jsonl'],
        [`${HOME}/.claude/sessions`]: ['999.json'],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/cold-session.jsonl`]: buildJsonl({
          cacheRead: 200000,
          cacheWrite: 10000,
          timestamp: old,
        }),
        [`${HOME}/.claude/projects/my-project/live-session.jsonl`]: buildJsonl({
          cacheRead: 1000,
          cacheWrite: 500,
          timestamp: old,
        }),
        [`${HOME}/.claude/sessions/999.json`]: JSON.stringify({
          pid: 999,
          sessionId: 'live-session',
          cwd: '/test',
          startedAt: FIXED_NOW,
          kind: 'interactive',
        }),
      },
    });
    const original = process.kill;
    process.kill = (() => {}) as typeof process.kill;
    try {
      const sessions = discoverSessions(fake, fixedClock);
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe('live-session');
      expect(sessions[0].isLive).toBe(true);
      expect(sessions[1].sessionId).toBe('cold-session');
    } finally {
      process.kill = original;
    }
  });

  it('sorts by three tiers: live first, then warm, then cold', () => {
    const recent = new Date(FIXED_NOW).toISOString();
    const old = new Date(FIXED_NOW - 2 * 60 * 60 * 1000).toISOString();
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: [
          'warm-session.jsonl',
          'cold-session.jsonl',
          'live-a.jsonl',
          'live-b.jsonl',
        ],
        [`${HOME}/.claude/sessions`]: ['998.json', '999.json'],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/cold-session.jsonl`]: buildJsonl({
          cacheRead: 200000,
          cacheWrite: 10000,
          timestamp: old,
        }),
        [`${HOME}/.claude/projects/my-project/warm-session.jsonl`]: buildJsonl({
          cacheRead: 50000,
          cacheWrite: 1000,
          timestamp: recent,
        }),
        [`${HOME}/.claude/projects/my-project/live-a.jsonl`]: buildJsonl({
          cacheRead: 1000,
          cacheWrite: 500,
          timestamp: old,
        }),
        [`${HOME}/.claude/projects/my-project/live-b.jsonl`]: buildJsonl({
          cacheRead: 2000,
          cacheWrite: 500,
          timestamp: old,
        }),
        [`${HOME}/.claude/sessions/998.json`]: JSON.stringify({
          pid: 998,
          sessionId: 'live-a',
          cwd: '/test',
          startedAt: FIXED_NOW,
          kind: 'interactive',
        }),
        [`${HOME}/.claude/sessions/999.json`]: JSON.stringify({
          pid: 999,
          sessionId: 'live-b',
          cwd: '/test',
          startedAt: FIXED_NOW,
          kind: 'interactive',
        }),
      },
    });
    const original = process.kill;
    process.kill = (() => {}) as typeof process.kill;
    try {
      const sessions = discoverSessions(fake, fixedClock);
      expect(sessions).toHaveLength(4);
      expect(sessions[0].sessionId).toBe('live-b');
      expect(sessions[0].isLive).toBe(true);
      expect(sessions[1].sessionId).toBe('live-a');
      expect(sessions[1].isLive).toBe(true);
      expect(sessions[2].sessionId).toBe('warm-session');
      expect(sessions[2].isWarm).toBe(true);
      expect(sessions[2].isLive).toBe(false);
      expect(sessions[3].sessionId).toBe('cold-session');
      expect(sessions[3].isWarm).toBe(false);
    } finally {
      process.kill = original;
    }
  });

  it('filters out sessions with 0 total cached tokens', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['empty-cache.jsonl', 'has-cache.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/empty-cache.jsonl`]: buildJsonl({
          cacheRead: 0,
          cacheWrite: 0,
          inputTokens: 5,
        }),
        [`${HOME}/.claude/projects/my-project/has-cache.jsonl`]: buildJsonl({
          cacheRead: 5000,
        }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('has-cache');
  });

  it('accepts an injected Fs and reads through it (DI smoke test)', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/proj`],
      entries: {
        [`${HOME}/.claude/projects`]: ['proj'],
        [`${HOME}/.claude/projects/proj`]: ['abc.jsonl'],
      },
      files: {
        [`${HOME}/.claude/projects/proj/abc.jsonl`]: buildJsonl({ cacheRead: 7777 }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('abc');
    expect(sessions[0].cacheReadTokens).toBe(7777);
  });

  it('initializes warmCostUsd with estimated warm cost', () => {
    const fake = makeFakeFs({
      dirs: [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/my-project`, `${HOME}/.claude/sessions`],
      entries: {
        [`${HOME}/.claude/projects`]: ['my-project'],
        [`${HOME}/.claude/projects/my-project`]: ['abc-123.jsonl'],
        [`${HOME}/.claude/sessions`]: [],
      },
      files: {
        [`${HOME}/.claude/projects/my-project/abc-123.jsonl`]: buildJsonl({ cacheRead: 100000 }),
      },
    });
    const sessions = discoverSessions(fake, fixedClock);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].warmCostUsd).toBe(0);
  });
});
