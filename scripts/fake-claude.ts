#!/usr/bin/env npx tsx
/**
 * Deterministic stand-in for the real `claude` binary.
 *
 * Invoked as: `fake-claude --resume <sessionId>` (other args ignored).
 *
 * Behavior:
 *   1. Prints a short REPL banner to stdout so the warmer's settle-timer fires.
 *   2. Reads stdin line-by-line. Any non-empty line that is not `/exit`
 *      is treated as a warm prompt: after an artificial latency, a single
 *      valid assistant-with-usage JSONL record is appended to
 *      ~/.claude/projects/<projectDir>/<sessionId>.jsonl and `ok` is echoed.
 *   3. `/exit` exits cleanly with code 0.
 *   4. stdin close also exits cleanly.
 *
 * Environment knobs (so integration tests can drive it):
 *   FAKE_CLAUDE_PROJECT_DIR           explicit project dir (defaults to
 *                                     cwd-derived `/Users/x/y` -> `-Users-x-y`)
 *   FAKE_CLAUDE_MODEL                 default `claude-sonnet-4-6`
 *   FAKE_CLAUDE_CACHE_READ_TOKENS     default `80000`
 *   FAKE_CLAUDE_CACHE_CREATION_TOKENS default `0`
 *   FAKE_CLAUDE_LATENCY_MS            default `100` (ms before writing JSONL)
 *   FAKE_CLAUDE_FAIL_MODE             'error-exit' | 'no-jsonl' | unset (= success)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';

interface Args {
  sessionId: string | null;
}

type FailMode = 'error-exit' | 'no-jsonl' | 'success';
const VALID_FAIL_MODES: ReadonlySet<string> = new Set<FailMode>(['error-exit', 'no-jsonl', 'success']);

function parseFailMode(raw: string | undefined): FailMode {
  if (raw && VALID_FAIL_MODES.has(raw)) return raw as FailMode;
  return 'success';
}

function parseArgs(argv: string[]): Args {
  let sessionId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume' && i + 1 < argv.length) {
      sessionId = argv[i + 1];
      i++;
    }
  }
  return { sessionId };
}

function deriveProjectDirFromCwd(cwd: string): string {
  // Claude Code's convention: `/Users/test/dev` -> `-Users-test-dev`
  return cwd.replace(/\//g, '-');
}

function getProjectDir(): string {
  const explicit = process.env.FAKE_CLAUDE_PROJECT_DIR;
  if (explicit && explicit.length > 0) return explicit;
  return deriveProjectDirFromCwd(process.cwd());
}

function buildJsonlLine(opts: {
  model: string;
  cacheRead: number;
  cacheCreation: number;
}): string {
  const record = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    message: {
      role: 'assistant',
      model: opts.model,
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: opts.cacheRead,
        cache_creation_input_tokens: opts.cacheCreation,
        output_tokens: 3,
      },
    },
  };
  return JSON.stringify(record);
}

function appendJsonl(projectDir: string, sessionId: string, line: string): void {
  const dir = path.join(os.homedir(), '.claude', 'projects', projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.appendFileSync(file, line + '\n', 'utf-8');
}

async function main(): Promise<void> {
  const { sessionId } = parseArgs(process.argv.slice(2));
  if (!sessionId) {
    process.stderr.write('fake-claude: missing --resume <sessionId>\n');
    process.exit(2);
  }

  const failMode = parseFailMode(process.env.FAKE_CLAUDE_FAIL_MODE);
  const model = process.env.FAKE_CLAUDE_MODEL || 'claude-sonnet-4-6';
  const cacheRead = parseInt(process.env.FAKE_CLAUDE_CACHE_READ_TOKENS || '80000', 10);
  const cacheCreation = parseInt(process.env.FAKE_CLAUDE_CACHE_CREATION_TOKENS || '0', 10);
  const latencyMs = parseInt(process.env.FAKE_CLAUDE_LATENCY_MS || '100', 10);
  const projectDir = getProjectDir();

  // REPL banner — warmer waits for data to settle before sending the prompt.
  process.stdout.write('fake-claude v0.0.0 (test stand-in)\n> ');

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  let exiting = false;
  let pendingWrites = 0;
  let exitRequested: number | null = null;

  const maybeExit = (): void => {
    if (exitRequested === null || pendingWrites > 0 || exiting) return;
    exiting = true;
    rl.close();
    process.exit(exitRequested);
  };

  const shutdown = (code = 0): void => {
    if (exitRequested !== null) return;
    exitRequested = code;
    maybeExit();
  };

  rl.on('line', (rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;

    if (line === '/exit') {
      shutdown(0);
      return;
    }

    // Warm prompt received.
    pendingWrites++;
    setTimeout(() => {
      try {
        if (failMode === 'error-exit') {
          shutdown(1);
          return;
        }
        if (failMode === 'no-jsonl') {
          process.stdout.write('ok\n> ');
          return;
        }

        try {
          const jsonl = buildJsonlLine({ model, cacheRead, cacheCreation });
          appendJsonl(projectDir, sessionId, jsonl);
        } catch (err) {
          process.stderr.write(`fake-claude: failed to write JSONL: ${(err as Error).message}\n`);
          shutdown(1);
          return;
        }
        process.stdout.write('ok\n> ');
      } finally {
        pendingWrites--;
        maybeExit();
      }
    }, latencyMs);
  });

  rl.on('close', () => {
    shutdown(0);
  });

  process.stdin.on('end', () => {
    shutdown(0);
  });
}

main().catch((err) => {
  process.stderr.write(`fake-claude: crashed: ${(err as Error).message}\n`);
  process.exit(1);
});
