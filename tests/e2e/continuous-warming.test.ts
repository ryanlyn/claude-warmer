/**
 * Comprehensive end-to-end verification that a session selected in the
 * full TUI gets continuously warmed against the REAL `claude` binary while
 * every mutation surface the TUI exposes is exercised concurrently. Proof
 * is the target session's JSONL growing monotonically across checkpoints
 * spread over ~110 seconds of wall time.
 *
 * Acceleration: App's tick + refresh intervals are dropped from 30s to
 * 2s/4s via the `tickIntervalMs`/`refreshIntervalMs` deps, and the warm
 * interval is set to 3s (0.05 min). Random is pinned to 0 so bootstrap
 * always schedules the earliest slot in the warm window. The real warmer
 * still spawns real PTY claude processes per cycle.
 *
 * Mutations applied during the run:
 *   - 30s refresh (auto, fires every 4s)
 *   - Space        — toggle the highlighted session's selection (off, then on)
 *   - 'a'          — select-active (re-selects all live/warm)
 *   - Down/Up      — navigation, mutates highlightedIndex/scrollOffset
 *   - 'p' + text   — change the warm prompt mid-run
 *   - Enter        — toggle warming off, then back on
 *
 * Cost: ~6-8 small warm prompts (pennies). Pollutes ~/.claude with one
 * test session.
 */
import React, { type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { App } from '../../src/app.js';
import { resetClaudePath } from '../../src/lib/warmer.js';
import { realFs, type Fs } from '../../src/lib/deps.js';

const CWD = process.cwd();
const PROJECT_DIR = '-' + CWD.replace(/\//g, '-').slice(1);
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects', PROJECT_DIR);
const PROMPT = "Reply 'ok'";
const REPL_READY_MS = 12_000;
const TEST_TIMEOUT_MS = 360_000;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  // Real execFileSync for the warmer's `which claude`; stub execSync so the
  // 'c' (copy) keybinding doesn't try to invoke pbcopy in the test process.
  return { ...actual, execSync: () => Buffer.from('') };
});
vi.mock('@inkjs/ui', () => ({
  TextInput: ({ defaultValue, onSubmit }: { defaultValue?: string; onSubmit?: (v: string) => void; children?: ReactNode }) =>
    // ink-testing-library doesn't drive @inkjs/ui's TextInput, so we render a
    // plain marker and expose onSubmit through a global stash that the test
    // can call directly when it edits the prompt.
    React.createElement(StubbedTextInput, { defaultValue, onSubmit }),
}));

let pendingSubmit: ((v: string) => void) | null = null;
function StubbedTextInput({
  defaultValue,
  onSubmit,
}: {
  defaultValue?: string;
  onSubmit?: (v: string) => void;
}): React.ReactElement {
  pendingSubmit = onSubmit ?? null;
  return React.createElement('ink-text', null, `[input:${defaultValue ?? ''}]`);
}

function getClaudePath(): string {
  return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
}

/**
 * Wrap real fs so refresh only sees ONE project dir containing ONE JSONL
 * (the test session). Without this, `discoverSessions` parses thousands of
 * JSONLs on a long-running developer machine, blocking the event loop for
 * seconds at a time and starving the warmer's PTY settle-timers. All
 * non-discovery fs calls pass through unchanged so warmer + sessions code
 * paths stay real.
 */
function scopedFs(onlyProjectDir: string, onlySessionJsonl: string): Fs {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const projectPath = path.join(projectsRoot, onlyProjectDir);
  return {
    ...realFs,
    readdirSync: ((p: fs.PathLike) => {
      const key = p.toString();
      if (key === projectsRoot) return [onlyProjectDir] as unknown as fs.Dirent[];
      if (key === projectPath) return [onlySessionJsonl] as unknown as fs.Dirent[];
      return realFs.readdirSync(p) as unknown as fs.Dirent[];
    }) as Fs['readdirSync'],
  };
}

function jsonlSize(sessionId: string): number {
  const p = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
  if (!fs.existsSync(p)) return 0;
  return fs.statSync(p).size;
}

function listProjectSessionIds(): string[] {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs.readdirSync(PROJECTS_ROOT).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function createRealSession(): Promise<{ sessionId: string; jsonlPath: string }> {
  const before = new Set(listProjectSessionIds());
  const proc = pty.spawn(getClaudePath(), [], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: CWD,
    env: process.env as Record<string, string>,
  });

  let output = '';
  proc.onData((c: string) => {
    output += c;
  });

  // Wait for REPL banner to settle, then send a prompt so a JSONL is created.
  await new Promise((r) => setTimeout(r, REPL_READY_MS));
  proc.write(PROMPT + '\r');
  await new Promise((r) => setTimeout(r, 10_000));
  proc.write('/exit\r');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already dead
      }
      resolve();
    }, 8_000);
    proc.onExit(() => {
      clearTimeout(t);
      resolve();
    });
  });

  const after = listProjectSessionIds();
  const newIds = after.filter((id) => !before.has(id));
  // Prefer banner-derived id; fall back to project-dir delta.
  const banner = stripAnsi(output).match(/claude --resume ([a-f0-9-]{36})/);
  const sessionId = banner?.[1] ?? newIds[newIds.length - 1];
  if (!sessionId) throw new Error('createRealSession: could not determine sessionId');
  const jsonlPath = path.join(PROJECTS_ROOT, `${sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) throw new Error(`createRealSession: jsonl missing at ${jsonlPath}`);
  return { sessionId, jsonlPath };
}

interface Checkpoint {
  label: string;
  atMs: number;
  jsonlSize: number;
  selectedHint: boolean;
}

describe('e2e: continuous warming of selected session under TUI mutations', () => {
  it(
    'JSONL grows monotonically across all checkpoints despite refresh, toggle, prompt change, navigation, and warming flips',
    async () => {
      delete process.env.CLAUDE_PATH;
      resetClaudePath();

      console.log('\n[CW] Phase 1: create a real session via PTY');
      const seed = await createRealSession();
      console.log(`[CW] Seed sessionId: ${seed.sessionId}  initial size=${jsonlSize(seed.sessionId)}B`);
      const initialSize = jsonlSize(seed.sessionId);

      console.log('[CW] Phase 2: mount App with accelerated intervals + warming on');
      const { stdin, lastFrame, unmount } = render(
        React.createElement(App, {
          intervalMinutes: 0.05, // 3s warm interval
          warmPrompt: PROMPT,
          deps: {
            random: () => 0, // bootstrap picks earliest slot
            tickIntervalMs: 2_000,
            refreshIntervalMs: 4_000,
            fs: scopedFs(PROJECT_DIR, `${seed.sessionId}.jsonl`),
          },
        }),
      );

      // Let the App mount, run initial discovery, render.
      await new Promise((r) => setTimeout(r, 800));
      const initialFrame = stripAnsi(lastFrame() ?? '');
      const seedShortId = seed.sessionId.slice(0, 8);
      // The session table truncates the session ID column so just check a
      // shortened form of the id is present.
      expect(initialFrame).toContain(seedShortId.slice(0, 6));

      // Start warming.
      stdin.write('\r');
      await new Promise((r) => setTimeout(r, 500));

      const checkpoints: Checkpoint[] = [];
      const t0 = Date.now();
      function recordCheckpoint(label: string, selectedHint = true): void {
        checkpoints.push({
          label,
          atMs: Date.now() - t0,
          jsonlSize: jsonlSize(seed.sessionId),
          selectedHint,
        });
      }
      recordCheckpoint('start (warming on)');

      console.log('[CW] Phase 3: 110s of TUI mutations interleaved with warming');

      // T+18s: refresh has fired ~4-5 times, at least one warm should have completed.
      await new Promise((r) => setTimeout(r, 18_000));
      recordCheckpoint('after-18s (refresh+warm only)');

      // Toggle the highlighted session's selection: off, then back on.
      // Side effect: scheduler.removeSession then scheduler.addSession.
      stdin.write(' ');
      await new Promise((r) => setTimeout(r, 500));
      stdin.write(' ');
      await new Promise((r) => setTimeout(r, 18_000));
      recordCheckpoint('after-toggle-selection');

      // Press 'a' to re-select all active sessions, then 'n' to deselect,
      // then 'a' again to re-select. Exercises selectActive and selectNone.
      stdin.write('a');
      await new Promise((r) => setTimeout(r, 500));
      stdin.write('n');
      await new Promise((r) => setTimeout(r, 500));
      stdin.write('a');
      await new Promise((r) => setTimeout(r, 18_000));
      recordCheckpoint('after-select-all/none/all');

      // Navigate down then up — exercises useInput's arrow handling and
      // scroll-clamp effects. Even with one session it touches the same
      // code path and shouldn't drop the session from state.
      stdin.write('\x1B[B'); // down
      await new Promise((r) => setTimeout(r, 200));
      stdin.write('\x1B[A'); // up
      await new Promise((r) => setTimeout(r, 18_000));
      recordCheckpoint('after-navigation');

      // Change the warm prompt mid-run via 'p' + StubbedTextInput.onSubmit.
      stdin.write('p');
      await new Promise((r) => setTimeout(r, 300));
      expect(pendingSubmit).not.toBeNull();
      pendingSubmit?.('Reply with only the word ok');
      pendingSubmit = null;
      await new Promise((r) => setTimeout(r, 18_000));
      recordCheckpoint('after-prompt-change');

      // Toggle warming off then on — exercises stop() + bootstrap().
      stdin.write('\r');
      await new Promise((r) => setTimeout(r, 800));
      stdin.write('\r');
      await new Promise((r) => setTimeout(r, 18_000));
      recordCheckpoint('after-warming-toggle-off-on');

      unmount();

      // ---- Reporting -----------------------------------------------------
      console.log('\n[CW] Checkpoint report (initial size=' + initialSize + 'B):');
      let prev = initialSize;
      for (const cp of checkpoints) {
        const delta = cp.jsonlSize - prev;
        console.log(
          `  [t+${(cp.atMs / 1000).toFixed(1)}s] ${cp.label.padEnd(36)} ` +
            `size=${cp.jsonlSize}B  delta=+${delta}B`,
        );
        prev = cp.jsonlSize;
      }

      // ---- Assertions ----------------------------------------------------
      // 1. Monotonically non-decreasing JSONL across every checkpoint.
      for (let i = 1; i < checkpoints.length; i++) {
        expect(
          checkpoints[i].jsonlSize,
          `checkpoint ${i} (${checkpoints[i].label}) must be >= previous`,
        ).toBeGreaterThanOrEqual(checkpoints[i - 1].jsonlSize);
      }

      // 2. Final size strictly greater than initial — proves warming
      //    actually happened, not just that the file was preserved.
      const finalSize = checkpoints[checkpoints.length - 1].jsonlSize;
      expect(finalSize).toBeGreaterThan(initialSize);

      // 3. At least 3 of the 6 checkpoints should show forward progress
      //    (delta > 0). With ~13s per warm cycle and 18s gaps, expect
      //    most or all to advance.
      const advancingCheckpoints = checkpoints.filter((c, i) => {
        const prevSize = i === 0 ? initialSize : checkpoints[i - 1].jsonlSize;
        return c.jsonlSize > prevSize;
      });
      expect(advancingCheckpoints.length).toBeGreaterThanOrEqual(3);

      // 4. Total growth should be at least 5KB — a single successful warm
      //    appends ~2-5KB; we expect 4+ across the run.
      expect(finalSize - initialSize).toBeGreaterThanOrEqual(5_000);
    },
    TEST_TIMEOUT_MS,
  );
});
