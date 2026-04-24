import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { WarmResult, SessionUsage } from './types.js';
import { calcWarmCost } from './pricing.js';
import { realClock, realFs, realSpawn, type Clock, type Fs, type SpawnFn } from './deps.js';

const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
};
const TOTAL_TIMEOUT_MS = 120_000;
const SETTLE_MS = 3_000;
const EXIT_GRACE_MS = 5_000;

let resolvedClaudePath: string | null = null;

export function getClaudePath(): string {
  if (resolvedClaudePath) return resolvedClaudePath;
  // Integration-test escape hatch: CLAUDE_PATH overrides `which claude`
  // so tests can point the warmer at a deterministic fake binary.
  const envPath = process.env.CLAUDE_PATH;
  if (envPath && envPath.length > 0) {
    resolvedClaudePath = envPath;
    return resolvedClaudePath;
  }
  try {
    resolvedClaudePath = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
  } catch {
    resolvedClaudePath = 'claude';
  }
  return resolvedClaudePath;
}

export function resetClaudePath(): void {
  resolvedClaudePath = null;
}

interface ParsedOutput {
  usage: SessionUsage;
  model: string;
  error: string | null;
}

export function getJsonlPath(projectDir: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
}

export function extractUsageFromNewLines(newContent: string): ParsedOutput {
  const lines = newContent.split('\n').filter((l) => l.trim());
  // Walk backwards to find the last assistant message with usage
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const msg = record.message as Record<string, unknown> | undefined;
    if (msg?.role !== 'assistant' || !msg.usage) continue;

    const usage = msg.usage as Record<string, number>;
    const model = (msg.model as string) || '';

    return {
      usage: {
        inputTokens: usage.input_tokens || 0,
        cacheReadInputTokens: usage.cache_read_input_tokens || 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      },
      model,
      error: null,
    };
  }

  return { usage: EMPTY_USAGE, model: '', error: 'No assistant message with usage in new JSONL lines' };
}

export interface WarmerDeps {
  fs?: Fs;
  spawn?: SpawnFn;
  clock?: Clock;
}

export function warmSession(
  sessionId: string,
  warmPrompt: string,
  cwd?: string,
  projectDir?: string,
  deps: WarmerDeps = {},
): Promise<WarmResult> {
  const fs = deps.fs ?? realFs;
  const spawn = deps.spawn ?? realSpawn;
  const clock = deps.clock ?? realClock;

  const errorResult = (error: string): WarmResult => ({
    sessionId,
    usage: EMPTY_USAGE,
    model: '',
    costUsd: 0,
    error,
  });

  if (!projectDir) {
    return Promise.resolve(errorResult('No projectDir provided'));
  }

  const jsonlPath = getJsonlPath(projectDir, sessionId);
  let offsetBefore: number;
  try {
    const stat = fs.statSync(jsonlPath);
    offsetBefore = stat.size;
  } catch {
    offsetBefore = 0;
  }

  return new Promise((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    let phase: 'waiting-for-ready' | 'sent-prompt' | 'done' = 'waiting-for-ready';
    let resolved = false;

    const finish = (error?: string) => {
      /* v8 ignore next */
      if (resolved) return;
      resolved = true;
      if (settleTimer) clock.clearTimeout(settleTimer);
      if (totalTimer) clock.clearTimeout(totalTimer);

      if (error) {
        resolve(errorResult(error));
        return;
      }

      // Read new JSONL lines appended during the session
      let newContent = '';
      try {
        const fd = fs.openSync(jsonlPath, 'r');
        const stat = fs.fstatSync(fd);
        const bytesToRead = stat.size - offsetBefore;
        if (bytesToRead > 0) {
          const buf = Buffer.alloc(bytesToRead);
          fs.readSync(fd, buf, 0, bytesToRead, offsetBefore);
          newContent = buf.toString('utf-8');
        }
        fs.closeSync(fd);
      } catch {
        resolve(errorResult('Failed to read JSONL file after warm'));
        return;
      }

      if (!newContent.trim()) {
        resolve(errorResult('No new JSONL content after warm'));
        return;
      }

      const parsed = extractUsageFromNewLines(newContent);
      const costUsd = parsed.error ? 0 : calcWarmCost(parsed.usage, parsed.model);

      resolve({
        sessionId,
        usage: parsed.usage,
        model: parsed.model,
        costUsd,
        error: parsed.error,
      });
    };

    let ptyProcess: ReturnType<SpawnFn>;
    try {
      ptyProcess = spawn(getClaudePath(), ['--resume', sessionId], {
        name: 'xterm-color',
        cols: 120,
        rows: 40,
        cwd: cwd || undefined,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      finish(`Failed to spawn PTY: ${(err as Error).message}`);
      return;
    }

    const resetSettle = () => {
      if (settleTimer) clock.clearTimeout(settleTimer);
      settleTimer = clock.setTimeout(() => {
        if (phase === 'waiting-for-ready') {
          phase = 'sent-prompt';
          ptyProcess.write(warmPrompt + '\r');
          resetSettle();
          return;
        }
        /* v8 ignore next */
        if (phase === 'sent-prompt') {
          phase = 'done';
          ptyProcess.write('/exit\r');
          // Give it time to exit gracefully, then kill
          clock.setTimeout(() => {
            if (!resolved) {
              try {
                ptyProcess.kill();
              } catch {
                // already exited
              }
              finish();
            }
          }, EXIT_GRACE_MS);
        }
      }, SETTLE_MS);
    };

    ptyProcess.onData((_data: string) => {
      if (phase !== 'done') {
        resetSettle();
      }
    });

    ptyProcess.onExit(() => {
      finish();
    });

    totalTimer = clock.setTimeout(() => {
      /* v8 ignore next */
      if (!resolved) {
        finish('Warm session timed out');
        try {
          ptyProcess.kill();
        } catch {
          // already exited
        }
      }
    }, TOTAL_TIMEOUT_MS);

    // Start the settle timer for initial readiness detection
    resetSettle();
  });
}

/**
 * Curry a `warmSession` bound to a fixed deps bag — useful to pass into
 * `new Scheduler(warmFn, ...)` when the caller wants an injected fs/spawn/clock
 * applied to every invocation.
 */
export function makeWarmer(baseDeps: WarmerDeps) {
  return (sessionId: string, prompt: string, cwd?: string, projectDir?: string) =>
    warmSession(sessionId, prompt, cwd, projectDir, baseDeps);
}
