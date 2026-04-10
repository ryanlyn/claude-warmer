/**
 * E2E test: verifies that consecutive keep-warm resumes get high cache hit rates.
 *
 * After the first resume (which pays a cache-write cost to establish the prefix),
 * subsequent resumes from separate processes should read from cache for the full
 * conversation prefix (system blocks + tools + messages).
 *
 * Currently FAILS (~53% hits) due to non-deterministic agent type ordering in
 * Claude Code's tool definitions (agent types listed in plugin-load order, not sorted).
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

    p.onData((d: string) => {
      output += d;
    });

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
      try {
        p.kill();
      } catch {
        // already exited
      }
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

  const lines = buf
    .toString('utf-8')
    .split('\n')
    .filter((l) => l.trim());
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
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

/** Run claude in print mode (-p) with a prompt. Non-interactive. */
function runPrintSession(args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    execFile(
      getClaudePath(),
      [...args, '-p', prompt],
      { cwd: CWD, env: process.env, maxBuffer: 10 * 1024 * 1024, timeout: 90_000 },
      (err: Error | null, stdout: string) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

describe('warm cache hits (e2e)', () => {
  it('consecutive PTY resumes share prefix cache (no flag)', async () => {
    const createOutput = await runSession([], PROMPT);
    // eslint-disable-next-line no-control-regex
    const stripped = createOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const match = stripped.match(/claude --resume ([a-f0-9-]{36})/);
    expect(match).not.toBeNull();

    const sessionId = match![1];
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    expect(fs.existsSync(jsonlPath)).toBe(true);
    console.log(`[pty no-flag] Session: ${sessionId}`);

    const offset1 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    console.log(`[pty no-flag] Warm 1: reads=${warm1!.reads} writes=${warm1!.writes}`);

    const offset2 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();

    const total = warm2!.reads + warm2!.writes;
    const hitRate = total > 0 ? warm2!.reads / total : 0;
    console.log(`[pty no-flag] Warm 2: reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hitRate * 100).toFixed(1)}%`);

    expect(hitRate).toBeGreaterThanOrEqual(EXPECTED_CACHE_HIT_RATE);
  }, 300_000);

  it('consecutive PTY resumes share prefix cache (--exclude-dynamic-system-prompt-sections)', async () => {
    const FLAG = '--exclude-dynamic-system-prompt-sections';
    const createOutput = await runSession([FLAG], PROMPT);
    // eslint-disable-next-line no-control-regex
    const stripped = createOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const match = stripped.match(/claude --resume ([a-f0-9-]{36})/);
    expect(match).not.toBeNull();

    const sessionId = match![1];
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    expect(fs.existsSync(jsonlPath)).toBe(true);
    console.log(`[pty flag] Session: ${sessionId}`);

    const offset1 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId, FLAG], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    console.log(`[pty flag] Warm 1: reads=${warm1!.reads} writes=${warm1!.writes}`);

    const offset2 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId, FLAG], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();

    const total = warm2!.reads + warm2!.writes;
    const hitRate = total > 0 ? warm2!.reads / total : 0;
    console.log(`[pty flag] Warm 2: reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hitRate * 100).toFixed(1)}%`);

    expect(hitRate).toBeGreaterThanOrEqual(EXPECTED_CACHE_HIT_RATE);
  }, 300_000);

  it('consecutive print-mode resumes share prefix cache (no flag)', async () => {
    // Create initial session via print mode so the JSONL exists
    const createOut = await runPrintSession([], PROMPT);
    const files = fs
      .readdirSync(PROJECTS_ROOT)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(PROJECTS_ROOT, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    expect(files.length).toBeGreaterThan(0);
    const sessionId = files[0].f.replace(/\.jsonl$/, '');
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    console.log(`[print no-flag] Session: ${sessionId} (create output bytes: ${createOut.length})`);

    const offset1 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    console.log(`[print no-flag] Warm 1: reads=${warm1!.reads} writes=${warm1!.writes}`);

    const offset2 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();

    const total = warm2!.reads + warm2!.writes;
    const hitRate = total > 0 ? warm2!.reads / total : 0;
    console.log(`[print no-flag] Warm 2: reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hitRate * 100).toFixed(1)}%`);

    expect(hitRate).toBeGreaterThanOrEqual(EXPECTED_CACHE_HIT_RATE);
  }, 300_000);

  it('cross-mode: create PTY, resume via print (no flag)', async () => {
    // Create session via PTY (interactive CLI identity)
    const createOutput = await runSession([], PROMPT);
    // eslint-disable-next-line no-control-regex
    const stripped = createOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const match = stripped.match(/claude --resume ([a-f0-9-]{36})/);
    expect(match).not.toBeNull();
    const sessionId = match![1];
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    console.log(`[cross pty->print no-flag] Session: ${sessionId}`);

    // Warm 1: resume via print mode (crosses cli -> sdk-cli identity)
    const offset1 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    const hit1 = (warm1!.reads + warm1!.writes) > 0 ? warm1!.reads / (warm1!.reads + warm1!.writes) : 0;
    console.log(`[cross pty->print no-flag] Warm 1 (print): reads=${warm1!.reads} writes=${warm1!.writes} hit=${(hit1 * 100).toFixed(1)}%`);

    // Warm 2: another print-mode resume (same identity as warm 1, should cache-hit)
    const offset2 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();
    const hit2 = (warm2!.reads + warm2!.writes) > 0 ? warm2!.reads / (warm2!.reads + warm2!.writes) : 0;
    console.log(`[cross pty->print no-flag] Warm 2 (print): reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hit2 * 100).toFixed(1)}%`);
  }, 300_000);

  it('cross-mode: create PTY, resume via print (--exclude-dynamic-system-prompt-sections)', async () => {
    const FLAG = '--exclude-dynamic-system-prompt-sections';
    const createOutput = await runSession([FLAG], PROMPT);
    // eslint-disable-next-line no-control-regex
    const stripped = createOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const match = stripped.match(/claude --resume ([a-f0-9-]{36})/);
    expect(match).not.toBeNull();
    const sessionId = match![1];
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    console.log(`[cross pty->print flag] Session: ${sessionId}`);

    const offset1 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId, FLAG], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    const hit1 = (warm1!.reads + warm1!.writes) > 0 ? warm1!.reads / (warm1!.reads + warm1!.writes) : 0;
    console.log(`[cross pty->print flag] Warm 1 (print): reads=${warm1!.reads} writes=${warm1!.writes} hit=${(hit1 * 100).toFixed(1)}%`);

    const offset2 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId, FLAG], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();
    const hit2 = (warm2!.reads + warm2!.writes) > 0 ? warm2!.reads / (warm2!.reads + warm2!.writes) : 0;
    console.log(`[cross pty->print flag] Warm 2 (print): reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hit2 * 100).toFixed(1)}%`);
  }, 300_000);

  it('cross-mode: create print (flag), resume via PTY', async () => {
    const FLAG = '--exclude-dynamic-system-prompt-sections';
    // Create session via print mode with the flag
    const createOut = await runPrintSession([FLAG], PROMPT);
    const files = fs
      .readdirSync(PROJECTS_ROOT)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(PROJECTS_ROOT, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    expect(files.length).toBeGreaterThan(0);
    const sessionId = files[0].f.replace(/\.jsonl$/, '');
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    console.log(`[cross print(flag)->pty] Session: ${sessionId} (create output bytes: ${createOut.length})`);

    // Warm 1: resume via PTY (crosses sdk-cli -> cli identity)
    const offset1 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    const hit1 = (warm1!.reads + warm1!.writes) > 0 ? warm1!.reads / (warm1!.reads + warm1!.writes) : 0;
    console.log(`[cross print(flag)->pty] Warm 1 (pty): reads=${warm1!.reads} writes=${warm1!.writes} hit=${(hit1 * 100).toFixed(1)}%`);

    // Warm 2: another PTY resume (same identity as warm 1, should cache-hit if PTY→PTY works)
    const offset2 = fs.statSync(jsonlPath).size;
    await runSession(['--resume', sessionId], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();
    const hit2 = (warm2!.reads + warm2!.writes) > 0 ? warm2!.reads / (warm2!.reads + warm2!.writes) : 0;
    console.log(`[cross print(flag)->pty] Warm 2 (pty): reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hit2 * 100).toFixed(1)}%`);
  }, 300_000);

  it('consecutive print-mode resumes share prefix cache (--exclude-dynamic-system-prompt-sections)', async () => {
    const FLAG = '--exclude-dynamic-system-prompt-sections';
    // Create initial session via print mode so the JSONL exists
    const createOut = await runPrintSession([FLAG], PROMPT);
    // Print mode doesn't echo the resume hint. Find the newest JSONL for this project.
    const files = fs
      .readdirSync(PROJECTS_ROOT)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(PROJECTS_ROOT, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    expect(files.length).toBeGreaterThan(0);
    const sessionId = files[0].f.replace(/\.jsonl$/, '');
    const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
    console.log(`[print flag] Session: ${sessionId} (create output bytes: ${createOut.length})`);

    const offset1 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId, FLAG], PROMPT);
    const warm1 = readUsageAfter(jsonlPath, offset1);
    expect(warm1).not.toBeNull();
    console.log(`[print flag] Warm 1: reads=${warm1!.reads} writes=${warm1!.writes}`);

    const offset2 = fs.statSync(jsonlPath).size;
    await runPrintSession(['--resume', sessionId, FLAG], PROMPT);
    const warm2 = readUsageAfter(jsonlPath, offset2);
    expect(warm2).not.toBeNull();

    const total = warm2!.reads + warm2!.writes;
    const hitRate = total > 0 ? warm2!.reads / total : 0;
    console.log(`[print flag] Warm 2: reads=${warm2!.reads} writes=${warm2!.writes} hit=${(hitRate * 100).toFixed(1)}%`);

    expect(hitRate).toBeGreaterThanOrEqual(EXPECTED_CACHE_HIT_RATE);
  }, 300_000);
});
