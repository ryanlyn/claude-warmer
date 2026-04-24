import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { warmSession, resetClaudePath, extractUsageFromNewLines } from '../../src/lib/warmer.js';

// Integration test: spawns the real `fake-claude.ts` script through node-pty
// via warmSession. Does NOT mock node-pty or node:fs so we exercise the
// CLAUDE_PATH override end-to-end.
//
// Scoping:
//   - `HOME` is redirected to a per-test tmp dir so ~/.claude/projects writes
//     don't touch the real home directory.
//   - `CLAUDE_PATH` points to a shim bash script that execs
//     `npx tsx scripts/fake-claude.ts "$@"` so node-pty can spawn it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FAKE_CLAUDE_TS = path.join(REPO_ROOT, 'scripts', 'fake-claude.ts');

let tmpRoot: string;
let fakeClaudeShim: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-test-'));
  fakeClaudeShim = path.join(tmpRoot, 'fake-claude.sh');
  fs.writeFileSync(
    fakeClaudeShim,
    `#!/usr/bin/env bash\nexec npx --no-install tsx ${JSON.stringify(FAKE_CLAUDE_TS)} "$@"\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(fakeClaudeShim, 0o755);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetClaudePath();
  const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('CLAUDE_PATH', fakeClaudeShim);
  vi.stubEnv('FAKE_CLAUDE_LATENCY_MS', '10');
  vi.stubEnv('FAKE_CLAUDE_CACHE_READ_TOKENS', '123456');
  vi.stubEnv('FAKE_CLAUDE_CACHE_CREATION_TOKENS', '789');
  vi.stubEnv('FAKE_CLAUDE_MODEL', 'claude-sonnet-4-6');
  vi.stubEnv('FAKE_CLAUDE_FAIL_MODE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetClaudePath();
});

describe('fake-claude integration with warmSession', () => {
  // Real warmSession waits SETTLE_MS=3s x 2 + tsx boot, so give generous timeouts.
  const TEST_TIMEOUT_MS = 60_000;

  it(
    'CLAUDE_PATH override + fake writes a JSONL line that extractUsageFromNewLines parses',
    async () => {
      const projectDir = '-fake-test-project-ok';
      vi.stubEnv('FAKE_CLAUDE_PROJECT_DIR', projectDir);
      const sessionId = 'fake-session-ok';

      const result = await warmSession(sessionId, 'ping', undefined, projectDir);

      expect(result.error).toBeNull();
      expect(result.sessionId).toBe(sessionId);
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.usage.cacheReadInputTokens).toBe(123456);
      expect(result.usage.cacheCreationInputTokens).toBe(789);
      expect(result.costUsd).toBeGreaterThan(0);

      // The JSONL file exists and every line parses cleanly.
      const jsonlPath = path.join(process.env.HOME!, '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const parsed = extractUsageFromNewLines(content);
      expect(parsed.error).toBeNull();
      expect(parsed.usage.cacheReadInputTokens).toBe(123456);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "FAKE_CLAUDE_FAIL_MODE=no-jsonl surfaces 'No new JSONL content after warm'",
    async () => {
      const projectDir = '-fake-test-project-nojsonl';
      vi.stubEnv('FAKE_CLAUDE_PROJECT_DIR', projectDir);
      vi.stubEnv('FAKE_CLAUDE_FAIL_MODE', 'no-jsonl');
      const sessionId = 'fake-session-nojsonl';

      // Pre-create the JSONL file so statSync gets a valid offset (size=0),
      // otherwise statSync ENOENTs and offsetBefore=0 which still works, but
      // creating the dir avoids a flaky race.
      const dir = path.join(process.env.HOME!, '.claude', 'projects', projectDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '');

      const result = await warmSession(sessionId, 'ping', undefined, projectDir);
      expect(result.error).toBe('No new JSONL content after warm');
      expect(result.usage.cacheReadInputTokens).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
