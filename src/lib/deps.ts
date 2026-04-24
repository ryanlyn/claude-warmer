import * as fs from 'node:fs';
import * as pty from 'node-pty';

/**
 * Dependency injection surface for claude-warmer.
 *
 * The app and its library modules accept an optional `Deps` bag at their
 * public boundaries. Production code uses `realDeps()`; tests can supply
 * in-memory fakes for Fs, a virtual clock, a deterministic RNG, and a
 * PTY-free Spawn implementation. This replaces module-level `vi.mock(...)`
 * incantations with explicit, typed fakes — the call sites that read files,
 * spawn processes, or ask the clock are visible in each function signature.
 *
 * Existing tests that use `vi.useFakeTimers()` and `vi.mock('node:fs')`
 * continue to work: the real Clock defers to the live `Date.now` /
 * `setInterval` globals, which vi replaces when fake timers are on, and the
 * real Fs is the actual `node:fs` module that `vi.mock` intercepts.
 */

export interface Clock {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof globalThis.setInterval>;
  clearInterval(id: ReturnType<typeof globalThis.setInterval>): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(id: ReturnType<typeof globalThis.setTimeout>): void;
}

export type Random = () => number;

/**
 * The narrow subset of `node:fs` that claude-warmer actually uses.
 * Kept minimal so test fakes only have to implement what's needed.
 */
export interface Fs {
  existsSync: typeof fs.existsSync;
  readFileSync: typeof fs.readFileSync;
  readdirSync: typeof fs.readdirSync;
  statSync: typeof fs.statSync;
  openSync: typeof fs.openSync;
  fstatSync: typeof fs.fstatSync;
  readSync: typeof fs.readSync;
  closeSync: typeof fs.closeSync;
}

export type PtyLike = Pick<pty.IPty, 'onData' | 'onExit' | 'write' | 'kill'>;
export type SpawnFn = (file: string, args: string[], options: pty.IPtyForkOptions) => PtyLike;

export interface Deps {
  clock: Clock;
  random: Random;
  fs: Fs;
  spawn: SpawnFn;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export const realFs: Fs = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  openSync: fs.openSync,
  fstatSync: fs.fstatSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
};

export const realSpawn: SpawnFn = (file, args, options) => pty.spawn(file, args, options);

export function realDeps(): Deps {
  return {
    clock: realClock,
    random: Math.random,
    fs: realFs,
    spawn: realSpawn,
  };
}
