import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractUsageFromNewLines, resetClaudePath, warmSession } from '../../src/lib/warmer.ts';

// Integration test: spawns the real `fake-claude.ts` script through node-pty
// via warmSession. Does NOT swap node-pty or node:fs for fakes so we exercise
// the CLAUDE_PATH override end-to-end.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FAKE_CLAUDE_TS = path.join(REPO_ROOT, 'scripts', 'fake-claude.ts');

let tmpRoot: string;
let fakeClaudeShim: string;
const ENV_KEYS = [
  'HOME',
  'CLAUDE_PATH',
  'FAKE_CLAUDE_LATENCY_MS',
  'FAKE_CLAUDE_CACHE_READ_TOKENS',
  'FAKE_CLAUDE_CACHE_CREATION_TOKENS',
  'FAKE_CLAUDE_MODEL',
  'FAKE_CLAUDE_FAIL_MODE',
  'FAKE_CLAUDE_PROJECT_DIR',
] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
  process.env[key] = value;
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-test-'));
  fakeClaudeShim = path.join(tmpRoot, 'fake-claude.sh');
  fs.writeFileSync(
    fakeClaudeShim,
    `#!/usr/bin/env bash\nexec deno run -A ${JSON.stringify(FAKE_CLAUDE_TS)} "$@"\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(fakeClaudeShim, 0o755);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  restoreEnv();
});

beforeEach(() => {
  resetClaudePath();
  const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  setEnv('HOME', fakeHome);
  setEnv('CLAUDE_PATH', fakeClaudeShim);
  setEnv('FAKE_CLAUDE_LATENCY_MS', '10');
  setEnv('FAKE_CLAUDE_CACHE_READ_TOKENS', '123456');
  setEnv('FAKE_CLAUDE_CACHE_CREATION_TOKENS', '789');
  setEnv('FAKE_CLAUDE_MODEL', 'claude-sonnet-4-6');
  setEnv('FAKE_CLAUDE_FAIL_MODE', '');
});

afterEach(() => {
  restoreEnv();
  resetClaudePath();
});

describe('fake-claude integration with warmSession', () => {
  it('CLAUDE_PATH override + fake writes a JSONL line that extractUsageFromNewLines parses', async () => {
    const projectDir = '-fake-test-project-ok';
    setEnv('FAKE_CLAUDE_PROJECT_DIR', projectDir);
    const sessionId = 'fake-session-ok';

    const result = await warmSession(sessionId, 'ping', undefined, projectDir);

    expect(result.error).toBeNull();
    expect(result.sessionId).toBe(sessionId);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.usage.cacheReadInputTokens).toBe(123456);
    expect(result.usage.cacheCreationInputTokens).toBe(789);
    expect(result.costUsd).toBeGreaterThan(0);

    const jsonlPath = path.join(process.env.HOME!, '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const parsed = extractUsageFromNewLines(content);
    expect(parsed.error).toBeNull();
    expect(parsed.usage.cacheReadInputTokens).toBe(123456);
  });

  it("FAKE_CLAUDE_FAIL_MODE=no-jsonl surfaces 'No new JSONL content after warm'", async () => {
    const projectDir = '-fake-test-project-nojsonl';
    setEnv('FAKE_CLAUDE_PROJECT_DIR', projectDir);
    setEnv('FAKE_CLAUDE_FAIL_MODE', 'no-jsonl');
    const sessionId = 'fake-session-nojsonl';

    const dir = path.join(process.env.HOME!, '.claude', 'projects', projectDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '');

    const result = await warmSession(sessionId, 'ping', undefined, projectDir);
    expect(result.error).toBe('No new JSONL content after warm');
    expect(result.usage.cacheReadInputTokens).toBe(0);
  });
});
