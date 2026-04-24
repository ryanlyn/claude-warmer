import * as os from 'node:os';
import * as path from 'node:path';
import type * as fs from 'node:fs';
import type { Fs } from '../../src/lib/deps.js';
import type { WarmFn, WarmResult } from '../../src/lib/types.js';

export interface FakeJsonlSpec {
  projectDir: string;
  sessionId: string;
  model?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  lastAssistantAt?: Date;
  customTitle?: string;
}

/**
 * Build the content of a JSONL file that satisfies claude-warmer's
 * `parseJsonlFile` (in `src/lib/sessions.ts`). Produces exactly one
 * assistant-with-usage record, optionally preceded by a custom-title record.
 */
export function buildJsonl(spec: FakeJsonlSpec): string {
  const lines: string[] = [];
  if (spec.customTitle) {
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: spec.customTitle, sessionId: spec.sessionId }));
  }
  lines.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: spec.model ?? 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: spec.cacheReadTokens ?? 80_000,
          cache_creation_input_tokens: spec.cacheWriteTokens ?? 1_000,
          output_tokens: 5,
        },
      },
      timestamp: (spec.lastAssistantAt ?? new Date()).toISOString(),
    }),
  );
  return lines.join('\n');
}

/**
 * In-memory Fs fake backed by a directory/file map keyed off the real
 * `os.homedir()`. `discoverSessions` and the App's refresh loop read
 * through this; production fs/os calls are untouched.
 */
export class InMemoryFs implements Fs {
  readonly home = os.homedir();
  private readonly files = new Map<string, string>();
  private readonly entries = new Map<string, string[]>();
  private readonly dirs = new Set<string>();

  addFile(relPath: string, content: string): void {
    const full = path.join(this.home, relPath);
    this.files.set(full, content);
    const parent = path.dirname(full);
    this.ensureDir(parent);
    const list = this.entries.get(parent) ?? [];
    if (!list.includes(path.basename(full))) list.push(path.basename(full));
    this.entries.set(parent, list);
  }

  ensureDir(absPath: string): void {
    this.dirs.add(absPath);
    const parent = path.dirname(absPath);
    if (parent && parent !== absPath) {
      this.ensureDir(parent);
      const list = this.entries.get(parent) ?? [];
      const child = path.basename(absPath);
      if (!list.includes(child)) list.push(child);
      this.entries.set(parent, list);
    }
  }

  writeFile(relPath: string, content: string): void {
    this.addFile(relPath, content);
  }

  appendFile(relPath: string, content: string): void {
    const full = path.join(this.home, relPath);
    const prev = this.files.get(full) ?? '';
    this.files.set(full, prev + content);
  }

  removeFile(relPath: string): void {
    const full = path.join(this.home, relPath);
    this.files.delete(full);
    const parent = path.dirname(full);
    const list = this.entries.get(parent);
    if (list) {
      this.entries.set(
        parent,
        list.filter((n) => n !== path.basename(full)),
      );
    }
  }

  readSnapshot(relPath: string): string | undefined {
    return this.files.get(path.join(this.home, relPath));
  }

  // Fs surface -------------------------------------------------------------

  existsSync = ((p: fs.PathLike) => {
    const key = p.toString();
    return this.dirs.has(key) || this.files.has(key);
  }) as Fs['existsSync'];

  readdirSync = ((p: fs.PathLike) => {
    const list = this.entries.get(p.toString());
    if (!list) throw new Error(`ENOENT: no such directory, ${p}`);
    return list as unknown as fs.Dirent[];
  }) as Fs['readdirSync'];

  readFileSync = ((p: fs.PathOrFileDescriptor) => {
    const key = p.toString();
    if (!this.files.has(key)) throw new Error(`ENOENT: ${key}`);
    return this.files.get(key) as string;
  }) as Fs['readFileSync'];

  statSync = (() => ({ size: 0 }) as fs.Stats) as Fs['statSync'];
  openSync = (() => 0) as Fs['openSync'];
  fstatSync = (() => ({ size: 0 }) as fs.Stats) as Fs['fstatSync'];
  readSync = (() => 0) as Fs['readSync'];
  closeSync = (() => undefined) as Fs['closeSync'];
}

export interface WarmCall {
  sessionId: string;
  at: number;
  cwd?: string;
  projectDir?: string;
}

export interface FakeWarmerOptions {
  onCall: (call: WarmCall) => void;
  getClockNow: () => number;
  /** ms to simulate the warm taking before resolving. Default 0. */
  durationMs?: number;
  /**
   * Optional per-call override — lets a test simulate a transient error
   * or latency spike without rewriting the whole fake.
   */
  result?: (call: WarmCall) => WarmResult | Promise<WarmResult>;
}

/**
 * Build a warmFn compatible with `src/lib/warmer.ts#warmSession` but
 * implemented in-process. Records every call, honors an injected clock for
 * timestamps, and can inject errors or delays per call. Does NOT spawn a
 * real PTY or real `claude` binary — the equivalent round-trip is covered
 * by `tests/lib/fake-claude.test.ts`.
 */
export function makeFakeWarmer(opts: FakeWarmerOptions): WarmFn {
  return async (sessionId, _prompt, cwd, projectDir) => {
    const call: WarmCall = { sessionId, at: opts.getClockNow(), cwd, projectDir };
    opts.onCall(call);
    if (opts.durationMs && opts.durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.durationMs));
    }
    if (opts.result) return Promise.resolve(opts.result(call));
    return {
      sessionId,
      usage: {
        inputTokens: 0,
        cacheReadInputTokens: 80_000,
        cacheCreationInputTokens: 1_000,
        outputTokens: 3,
      },
      model: 'claude-sonnet-4-6',
      costUsd: 0.004,
      error: null,
    };
  };
}
