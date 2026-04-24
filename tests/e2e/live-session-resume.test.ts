/**
 * Verifies what `claude --resume <sid>` actually does when another `claude`
 * process is currently holding that session — the H5 hypothesis underlying
 * the fd23508e investigation. Spawns a real PTY-backed `claude` session,
 * creates a second `claude --resume` against the same id and leaves it
 * idle (mirroring the fd23508e shape: one cmux-launched session held open
 * for 11h while the user was away), then runs the warmer's actual
 * `warmSession` codepath three times at a 5-second interval and records
 * what really happens — exit modes, JSONL deltas, any forked session
 * artifacts, and how it diverges from the fake-claude `fork-session`
 * simulation.
 *
 * No assertions on outcome: this is an observation test. It logs a
 * structured report so the reader can compare real-binary behavior to the
 * fake-claude reproducer in
 * `tests/integration/fake-claude-fork-session.test.ts`.
 *
 * Cost: ~3 small warm prompts (≈$0.01). Pollutes ~/.claude with 1-2 test
 * sessions, same as the existing e2e suite.
 */
import { describe, it, expect } from 'vitest';
import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { warmSession, resetClaudePath } from '../../src/lib/warmer.js';

const CWD = process.cwd();
const PROJECT_DIR = '-' + CWD.replace(/\//g, '-').slice(1);
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects', PROJECT_DIR);
const SESSIONS_ROOT = path.join(os.homedir(), '.claude', 'sessions');
const PROMPT = "Reply 'ok'";

const REPL_READY_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 300_000;
const INTER_WARM_DELAY_MS = 5_000;
const NUM_WARM_CYCLES = 3;

function getClaudePath(): string {
  return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
}

function listProjectSessions(): string[] {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs
    .readdirSync(PROJECTS_ROOT)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''));
}

function listPidFilesForSession(sessionId: string): Array<{ pid: number; alive: boolean }> {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const out: Array<{ pid: number; alive: boolean }> = [];
  for (const f of fs.readdirSync(SESSIONS_ROOT)) {
    if (!f.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(SESSIONS_ROOT, f), 'utf-8'));
      if (entry.sessionId !== sessionId) continue;
      let alive = false;
      try {
        process.kill(entry.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      out.push({ pid: entry.pid, alive });
    } catch {
      // ignore corrupt
    }
  }
  return out;
}

function jsonlSize(sessionId: string): number {
  const p = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
  if (!fs.existsSync(p)) return 0;
  return fs.statSync(p).size;
}

function findForkedSessions(originalId: string, knownIds: Set<string>): string[] {
  // Any sessionId that newly appears AND mentions the original id in its
  // first few lines is a likely "fork".
  const candidates: string[] = [];
  for (const id of listProjectSessions()) {
    if (knownIds.has(id)) continue;
    candidates.push(id);
  }
  // Also surface any new sessions that don't mention the original — they
  // could still be forks under a different bookkeeping convention.
  return candidates.filter((id) => id !== originalId);
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

interface SpawnedSession {
  sessionId: string;
  proc: pty.IPty;
  output: string;
  exited: Promise<void>;
}

/**
 * Spawn `claude --resume <sid>` (or fresh) and wait for the REPL prompt
 * to settle. Returns the live PTY handle WITHOUT sending /exit; the caller
 * is responsible for shutting it down.
 */
async function spawnAndWaitForReady(args: string[]): Promise<SpawnedSession> {
  const proc = pty.spawn(getClaudePath(), args, {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: CWD,
    env: process.env as Record<string, string>,
  });

  let output = '';
  let resolveExit!: () => void;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });

  proc.onData((chunk: string) => {
    output += chunk;
  });
  proc.onExit(() => resolveExit());

  // Settle-based readiness: 3s of quiet stdout = REPL ready.
  let lastDataAt = Date.now();
  const dataTracker = (chunk: string) => {
    output += chunk;
    lastDataAt = Date.now();
  };
  proc.onData(dataTracker);

  const readyDeadline = Date.now() + REPL_READY_TIMEOUT_MS;
  while (Date.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (output.length > 0 && Date.now() - lastDataAt > 3_000) break;
  }

  // Extract sessionId from the banner if it's a fresh session.
  const match = stripAnsi(output).match(/claude --resume ([a-f0-9-]{36})/);
  let sessionId = '';
  if (args[0] === '--resume') {
    sessionId = args[1];
  } else if (match) {
    sessionId = match[1];
  }

  return { sessionId, proc, output, exited };
}

async function shutdownSession(s: SpawnedSession): Promise<void> {
  try {
    s.proc.write('/exit\r');
  } catch {
    // already exited
  }
  // Give it a few seconds, then kill.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      process.kill(s.proc.pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    s.proc.kill();
  } catch {
    // already exited
  }
  await s.exited;
}

interface CycleObservation {
  cycle: number;
  warmResult: {
    error: string | null;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    model: string;
  };
  jsonlSizeAfter: number;
  newSessionIdsObserved: string[];
  livePidStillAlive: boolean;
}

describe('e2e: real claude --resume against a live session (H5 verification)', () => {
  it(
    'observes what really happens when warming a session held by another live claude',
    async () => {
      // Make sure no stale CLAUDE_PATH escape hatch is active.
      delete process.env.CLAUDE_PATH;
      resetClaudePath();

      console.log('\n[H5] Phase 1: create a fresh session via PTY');
      const baseline = new Set(listProjectSessions());
      const seedSession = await spawnAndWaitForReady([]);
      // Send a single prompt to materialize the JSONL with at least one
      // assistant message + cache_creation, then exit cleanly so the PID
      // file is gone (we don't want the SEED's own PID held open).
      seedSession.proc.write(PROMPT + '\r');
      // Wait for response settle.
      await new Promise((r) => setTimeout(r, 8_000));
      await shutdownSession(seedSession);

      // Identify the seed session id from project dir delta.
      const afterSeed = listProjectSessions().filter((id) => !baseline.has(id));
      expect(afterSeed.length).toBeGreaterThanOrEqual(1);
      const sessionId = afterSeed[0];
      const knownIds = new Set([...baseline, ...afterSeed]);
      const seedJsonlSize = jsonlSize(sessionId);
      console.log(`[H5] Seed session id: ${sessionId}  jsonlSize=${seedJsonlSize}`);

      console.log('[H5] Phase 2: spawn a second claude --resume that holds the session');
      const liveHolder = await spawnAndWaitForReady(['--resume', sessionId]);
      const holderPidEntries = listPidFilesForSession(sessionId);
      console.log(
        `[H5] Holder PID(s) registered for session: ${JSON.stringify(holderPidEntries)}`,
      );

      try {
        console.log('[H5] Phase 3: run warmSession 3x at 5s intervals while holder is alive');
        const observations: CycleObservation[] = [];
        for (let cycle = 1; cycle <= NUM_WARM_CYCLES; cycle++) {
          if (cycle > 1) {
            await new Promise((r) => setTimeout(r, INTER_WARM_DELAY_MS));
          }
          const beforeIds = new Set(listProjectSessions());
          const result = await warmSession(sessionId, PROMPT, CWD, PROJECT_DIR);
          const afterIds = listProjectSessions();
          const newIds = afterIds.filter((id) => !beforeIds.has(id));
          observations.push({
            cycle,
            warmResult: {
              error: result.error,
              cacheReadInputTokens: result.usage.cacheReadInputTokens,
              cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
              model: result.model,
            },
            jsonlSizeAfter: jsonlSize(sessionId),
            newSessionIdsObserved: newIds,
            livePidStillAlive: listPidFilesForSession(sessionId).some((p) => p.alive),
          });
          console.log(
            `[H5] cycle ${cycle}: ` +
              `error=${JSON.stringify(result.error)} ` +
              `cacheRead=${result.usage.cacheReadInputTokens} ` +
              `cacheWrite=${result.usage.cacheCreationInputTokens} ` +
              `seedJsonlDelta=${jsonlSize(sessionId) - seedJsonlSize}B ` +
              `newSessions=${JSON.stringify(newIds)} ` +
              `holderStillAlive=${observations[observations.length - 1].livePidStillAlive}`,
          );
        }

        console.log('\n[H5] Final report:');
        const finalSize = jsonlSize(sessionId);
        const sizeDelta = finalSize - seedJsonlSize;
        const allErrors = observations.map((o) => o.warmResult.error);
        const totalNewSessions = findForkedSessions(sessionId, knownIds);
        console.log(`  seed sessionId           : ${sessionId}`);
        console.log(`  seed JSONL size before   : ${seedJsonlSize}`);
        console.log(`  seed JSONL size after 3  : ${finalSize}  (delta=${sizeDelta}B)`);
        console.log(`  warm errors per cycle    : ${JSON.stringify(allErrors)}`);
        console.log(`  cumulative cache reads   : ${observations.reduce((a, b) => a + b.warmResult.cacheReadInputTokens, 0)}`);
        console.log(`  cumulative cache writes  : ${observations.reduce((a, b) => a + b.warmResult.cacheCreationInputTokens, 0)}`);
        console.log(`  new session IDs created  : ${JSON.stringify(totalNewSessions)}`);
        console.log(`  holder PID still alive   : ${observations[observations.length - 1].livePidStillAlive}`);

        // Single sanity check: the test successfully ran the cycles.
        expect(observations.length).toBe(NUM_WARM_CYCLES);
      } finally {
        await shutdownSession(liveHolder);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
