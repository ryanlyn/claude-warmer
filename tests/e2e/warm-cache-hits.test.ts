/**
 * E2E cache benchmark coverage for keep-warm resumes.
 *
 * Same-mode resumes are the stable correctness gate for this app:
 * repeated PTY resumes and repeated print-mode resumes should reach
 * high cache hit rates by the second warm.
 *
 * Cross-mode sequences are benchmarked for observability. They log
 * per-turn cache reads and writes so behavior stays visible without
 * turning variable mode switches into brittle pass/fail gates.
 */

import { describe, it, expect } from 'vitest';
import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

const CWD = process.cwd();
const PROJECT_DIR = '-' + CWD.replace(/\//g, '-').slice(1);
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects', PROJECT_DIR);
const PROMPT = "Reply 'ok'";
const FLAG = '--exclude-dynamic-system-prompt-sections';

const EXPECTED_CACHE_HIT_RATE = 0.9;
const RUN_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 300_000;

type ResumeMode = 'pty' | 'print';

interface UsageSnapshot {
  reads: number;
  writes: number;
}

interface SessionHandle {
  sessionId: string;
  jsonlPath: string;
}

function getClaudePath(): string {
  return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
}

function getHitRate(usage: UsageSnapshot): number {
  const total = usage.reads + usage.writes;
  return total > 0 ? usage.reads / total : 0;
}

function formatUsage(label: string, usage: UsageSnapshot): string {
  return `${label}: reads=${usage.reads} writes=${usage.writes} hit=${(getHitRate(usage) * 100).toFixed(1)}%`;
}

function logUsage(prefix: string, label: string, usage: UsageSnapshot): void {
  console.log(`[${prefix}] ${formatUsage(label, usage)}`);
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function extractSessionIdFromPtyOutput(output: string): string {
  const match = stripAnsi(output).match(/claude --resume ([a-f0-9-]{36})/);
  expect(match).not.toBeNull();
  return match![1];
}

function getJsonlPath(sessionId: string): string {
  return path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
}

function listProjectSessions(): Array<{ sessionId: string; mtimeMs: number }> {
  return fs
    .readdirSync(PROJECTS_ROOT)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => ({
      sessionId: file.replace(/\.jsonl$/, ''),
      mtimeMs: fs.statSync(path.join(PROJECTS_ROOT, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getNewestSessionId(before: Set<string>): string {
  const sessions = listProjectSessions();
  const created = sessions.find((session) => !before.has(session.sessionId));
  return (created ?? sessions[0]).sessionId;
}

function readUsageAfter(jsonlPath: string, offset: number): UsageSnapshot | null {
  const stat = fs.statSync(jsonlPath);
  if (stat.size <= offset) return null;

  const buf = Buffer.alloc(stat.size - offset);
  const fd = fs.openSync(jsonlPath, 'r');
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);

  const lines = buf
    .toString('utf-8')
    .split('\n')
    .filter((line) => line.trim());

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]);
      const msg = record.message;
      if (msg?.role === 'assistant' && msg?.usage && msg.model !== '<synthetic>') {
        return {
          reads: msg.usage.cache_read_input_tokens || 0,
          writes: msg.usage.cache_creation_input_tokens || 0,
        };
      }
    } catch {
      // Ignore malformed lines and keep walking backwards.
    }
  }

  return null;
}

function readUsageOrThrow(jsonlPath: string, offset: number, label: string): UsageSnapshot {
  const usage = readUsageAfter(jsonlPath, offset);
  expect(usage, `${label} should append assistant usage to the session JSONL`).not.toBeNull();
  return usage!;
}

function runSession(args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let prompted = false;
    let exiting = false;

    const p = pty.spawn(getClaudePath(), args, {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: CWD,
      env: process.env as Record<string, string>,
    });

    p.onData((chunk: string) => {
      output += chunk;
    });

    const promptTimer = setTimeout(() => {
      prompted = true;
      p.write(prompt + '\r');
    }, 15_000);

    const exitTimer = setTimeout(() => {
      if (prompted && !exiting) {
        exiting = true;
        p.write('/exit\r');
      }
    }, 40_000);

    p.onExit(() => {
      clearTimeout(promptTimer);
      clearTimeout(exitTimer);
      resolve(output);
    });

    setTimeout(() => {
      clearTimeout(promptTimer);
      clearTimeout(exitTimer);
      try {
        p.kill();
      } catch {
        // The child has already exited.
      }
      reject(new Error('session timed out'));
    }, RUN_TIMEOUT_MS);
  });
}

function runPrintSession(args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      getClaudePath(),
      [...args, '-p', prompt],
      { cwd: CWD, env: process.env, maxBuffer: 10 * 1024 * 1024, timeout: RUN_TIMEOUT_MS },
      (err: Error | null, stdout: string) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

async function createSession(mode: ResumeMode, extraArgs: string[] = []): Promise<SessionHandle> {
  if (mode === 'pty') {
    const output = await runSession(extraArgs, PROMPT);
    const sessionId = extractSessionIdFromPtyOutput(output);
    const jsonlPath = getJsonlPath(sessionId);
    expect(fs.existsSync(jsonlPath)).toBe(true);
    return { sessionId, jsonlPath };
  }

  const before = new Set(listProjectSessions().map((session) => session.sessionId));
  await runPrintSession(extraArgs, PROMPT);
  const sessionId = getNewestSessionId(before);
  const jsonlPath = getJsonlPath(sessionId);
  expect(fs.existsSync(jsonlPath)).toBe(true);
  return { sessionId, jsonlPath };
}

async function resumeSession(
  handle: SessionHandle,
  mode: ResumeMode,
  label: string,
  extraArgs: string[] = [],
): Promise<UsageSnapshot> {
  const offset = fs.statSync(handle.jsonlPath).size;
  const args = ['--resume', handle.sessionId, ...extraArgs];

  if (mode === 'pty') {
    await runSession(args, PROMPT);
  } else {
    await runPrintSession(args, PROMPT);
  }

  return readUsageOrThrow(handle.jsonlPath, offset, label);
}

function expectHighHitRate(prefix: string, label: string, usage: UsageSnapshot): void {
  logUsage(prefix, label, usage);
  expect(getHitRate(usage)).toBeGreaterThanOrEqual(EXPECTED_CACHE_HIT_RATE);
}

describe('warm cache hits (e2e)', () => {
  it(
    'consecutive PTY resumes reach a high cache hit rate by warm 2',
    async () => {
      const handle = await createSession('pty');
      const prefix = 'pty same-mode';
      console.log(`[${prefix}] Session: ${handle.sessionId}`);

      const warm1 = await resumeSession(handle, 'pty', 'Warm 1');
      logUsage(prefix, 'Warm 1', warm1);

      const warm2 = await resumeSession(handle, 'pty', 'Warm 2');
      expectHighHitRate(prefix, 'Warm 2', warm2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'consecutive PTY resumes with the flag reach a high cache hit rate by warm 2',
    async () => {
      const handle = await createSession('pty', [FLAG]);
      const prefix = 'pty same-mode flag';
      console.log(`[${prefix}] Session: ${handle.sessionId}`);

      const warm1 = await resumeSession(handle, 'pty', 'Warm 1', [FLAG]);
      logUsage(prefix, 'Warm 1', warm1);

      const warm2 = await resumeSession(handle, 'pty', 'Warm 2', [FLAG]);
      expectHighHitRate(prefix, 'Warm 2', warm2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'consecutive print-mode resumes reach a high cache hit rate by warm 2',
    async () => {
      const handle = await createSession('print');
      const prefix = 'print same-mode';
      console.log(`[${prefix}] Session: ${handle.sessionId}`);

      const warm1 = await resumeSession(handle, 'print', 'Warm 1');
      logUsage(prefix, 'Warm 1', warm1);

      const warm2 = await resumeSession(handle, 'print', 'Warm 2');
      expectHighHitRate(prefix, 'Warm 2', warm2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'consecutive print-mode resumes with the flag reach a high cache hit rate by warm 2',
    async () => {
      const handle = await createSession('print', [FLAG]);
      const prefix = 'print same-mode flag';
      console.log(`[${prefix}] Session: ${handle.sessionId}`);

      const warm1 = await resumeSession(handle, 'print', 'Warm 1', [FLAG]);
      logUsage(prefix, 'Warm 1', warm1);

      const warm2 = await resumeSession(handle, 'print', 'Warm 2', [FLAG]);
      expectHighHitRate(prefix, 'Warm 2', warm2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'benchmarks PTY create -> print warm 1 -> print warm 2 -> PTY warm 3',
    async () => {
      const handle = await createSession('pty');
      const prefix = 'cross pty->print->print->pty';
      console.log(`[${prefix}] Session: ${handle.sessionId}`);

      const warm1 = await resumeSession(handle, 'print', 'Warm 1');
      logUsage(prefix, 'Warm 1 (print)', warm1);

      const warm2 = await resumeSession(handle, 'print', 'Warm 2');
      logUsage(prefix, 'Warm 2 (print)', warm2);

      const warm3 = await resumeSession(handle, 'pty', 'Warm 3');
      logUsage(prefix, 'Warm 3 (pty)', warm3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'benchmarks PTY create -> print warm 1 -> print warm 2 with the flag',
    async () => {
      const handle = await createSession('pty', [FLAG]);
      const prefix = 'cross pty->print flag';
      console.log(`[${prefix}] Session: ${handle.sessionId}`);

      const warm1 = await resumeSession(handle, 'print', 'Warm 1', [FLAG]);
      logUsage(prefix, 'Warm 1 (print)', warm1);

      const warm2 = await resumeSession(handle, 'print', 'Warm 2', [FLAG]);
      logUsage(prefix, 'Warm 2 (print)', warm2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'benchmarks print create with the flag -> PTY warm 1 -> PTY warm 2',
    async () => {
      const handle = await createSession('print', [FLAG]);
      const prefix = 'cross print flag->pty';
      console.log(`[${prefix}] Session: ${handle.sessionId}`);

      const warm1 = await resumeSession(handle, 'pty', 'Warm 1');
      logUsage(prefix, 'Warm 1 (pty)', warm1);

      const warm2 = await resumeSession(handle, 'pty', 'Warm 2');
      logUsage(prefix, 'Warm 2 (pty)', warm2);
    },
    TEST_TIMEOUT_MS,
  );
});
