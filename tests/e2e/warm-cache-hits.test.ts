/**
 * E2E test: verifies that consecutive keep-warm resumes get high cache hit rates.
 *
 * After the first resume (which pays a cache-write cost to establish the prefix),
 * subsequent resumes from separate processes should read from cache for the full
 * conversation prefix (system blocks + tools + messages).
 *
 * Currently FAILS (~53% hits) due to non-deterministic Agent tool ordering in
 * Claude Code (agent types listed in plugin-load order, not sorted).
 * See: claude-code internal_claude_source_file - inline path doesn't sort.
 * Expected to PASS once Claude Code sorts agent types deterministically.
 */

import { describe, it, expect } from 'vitest';
import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const CWD = process.cwd();
const PROJECT_DIR = '-' + CWD.replace(/\//g, '-').slice(1);
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects', PROJECT_DIR);
const PROMPT = "Reply 'ok'";

// Target: >90% cache hits on the second warm.
// Currently blocked by non-deterministic agent ordering (~53%).
const EXPECTED_CACHE_HIT_RATE = 0.9;

function getClaudePath(): string {
  return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
}

/** Spawn claude in a PTY, send a prompt after startup, /exit after response, wait for exit. */
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

    p.onData((d: string) => { output += d; });

    // Send prompt after startup delay
    const promptTimer = setTimeout(() => {
      prompted = true;
      p.write(prompt + '\r');
    }, 15_000);

    // After prompt, wait for response then /exit
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

    // Hard timeout
    setTimeout(() => {
      clearTimeout(promptTimer);
      clearTimeout(exitTimer);
      try { p.kill(); } catch {}
      reject(new Error('session timed out'));
    }, 90_000);
  });
}

/** Read the last assistant message with usage from a JSONL file after a byte offset. */
function readUsageAfter(jsonlPath: string, offset: number): { reads: number; writes: number } | null {
  const stat = fs.statSync(jsonlPath);
  if (stat.size <= offset) return null;

  const buf = Buffer.alloc(stat.size - offset);
  const fd = fs.openSync(jsonlPath, 'r');
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);

  const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]);
      const msg = r.message;
      if (msg?.role === 'assistant' && msg?.usage && msg.model !== '<synthetic>') {
        return {
          reads: msg.usage.cache_read_input_tokens || 0,
          writes: msg.usage.cache_creation_input_tokens || 0,
        };
      }
    } catch {}
  }
  return null;
}

describe('warm cache hits (e2e)', () => {
  it('consecutive resumes share prefix cache', async () => {
    // Step 1: Create a fresh session
    const createOutput = await runSession([], PROMPT);
    const stripped = createOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const match = stripped.match(/claude --resume ([a-f0-9-]{36})/);
    expect(match).not.toBeNull();

    const sessionId = match![1];
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    expect(fs.existsSync(jsonlPath)).toBe(true);
    console.log(`Session: ${sessionId}`);

    // Step 2: First warm (establishes the resume-path cache prefix)
    const offset1 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    console.log(`Warm 1: reads=${warm1!.reads} writes=${warm1!.writes}`);

    // Step 3: Second warm (should hit cache from warm 1's prefix)
    const offset2 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();

    const total = warm2!.reads + warm2!.writes;
    const hitRate = total > 0 ? warm2!.reads / total : 0;
    console.log(`Warm 2: reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hitRate * 100).toFixed(1)}%`);

    expect(hitRate).toBeGreaterThanOrEqual(EXPECTED_CACHE_HIT_RATE);
  }, 300_000);
});
