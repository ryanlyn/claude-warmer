import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
import type { WarmResult, SessionUsage } from './types.js';
import { calcWarmCost } from './pricing.js';

const EMPTY_USAGE: SessionUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 };
const TOTAL_TIMEOUT_MS = 120_000;
const SETTLE_MS = 3_000;
const EXIT_GRACE_MS = 5_000;

let resolvedClaudePath: string | null = null;

export function getClaudePath(): string {
  if (resolvedClaudePath) return resolvedClaudePath;
  try {
    resolvedClaudePath = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
  } catch {
    resolvedClaudePath = 'claude';
  }
  return resolvedClaudePath;
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

export function warmSession(sessionId: string, warmPrompt: string, cwd?: string, projectDir?: string): Promise<WarmResult> {
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
    let output = '';
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    let phase: 'waiting-for-ready' | 'sent-prompt' | 'done' = 'waiting-for-ready';
    let resolved = false;

    const finish = (error?: string) => {
      if (resolved) return;
      resolved = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (totalTimer) clearTimeout(totalTimer);

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

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(getClaudePath(), ['--resume', sessionId], {
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
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (phase === 'waiting-for-ready') {
          phase = 'sent-prompt';
          ptyProcess.write(warmPrompt + '\r');
          resetSettle();
        } else if (phase === 'sent-prompt') {
          phase = 'done';
          ptyProcess.write('/exit\r');
          // Give it time to exit gracefully, then kill
          setTimeout(() => {
            if (!resolved) {
              try { ptyProcess.kill(); } catch {}
              finish();
            }
          }, EXIT_GRACE_MS);
        }
      }, SETTLE_MS);
    };

    ptyProcess.onData((data: string) => {
      output += data;
      if (phase !== 'done') {
        resetSettle();
      }
    });

    ptyProcess.onExit(() => {
      finish();
    });

    totalTimer = setTimeout(() => {
      if (!resolved) {
        finish('Warm session timed out');
        try { ptyProcess.kill(); } catch {}
      }
    }, TOTAL_TIMEOUT_MS);

    // Start the settle timer for initial readiness detection
    resetSettle();
  });
}
