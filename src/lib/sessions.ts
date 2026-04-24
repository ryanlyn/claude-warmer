import * as path from 'node:path';
import * as os from 'node:os';
import type { Session } from './types.js';
import { calcExpiryCost } from './pricing.js';
import { WARM_THRESHOLD_MS } from './types.js';
import { realClock, realFs, type Clock, type Fs } from './deps.js';

interface ParsedSession {
  name: string;
  model: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastAssistantTimestamp: number;
}

interface PidEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
}

/**
 * Greedy filesystem-aware decoder for Claude Code project-dir names. Tries
 * to recover the original absolute path by walking the encoded segments
 * left-to-right; at each step any number of remaining parts can be glued
 * together with `-` to form a single path segment, and a candidate is only
 * accepted if it stat()s as a directory. Returns null when no traversal
 * reaches the end with every prefix existing on disk.
 *
 * Worst case is O(2^n) candidates for n hyphens in the encoded form, but
 * in practice the filesystem prunes branches aggressively (most candidate
 * prefixes don't exist). Results are memoized at module level — see
 * `smartDecodeCache`.
 */
export function findProjectCwd(fs: Fs, encoded: string): string | null {
  if (!encoded.startsWith('-')) return null;
  const parts = encoded.slice(1).split('-');

  const isDir = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  function dfs(prefix: string, idx: number): string | null {
    if (idx >= parts.length) return prefix;
    for (let span = 1; span <= parts.length - idx; span++) {
      const segment = parts.slice(idx, idx + span).join('-');
      const candidate = prefix + '/' + segment;
      if (isDir(candidate)) {
        const result = dfs(candidate, idx + span);
        if (result) return result;
      }
    }
    return null;
  }

  return dfs('', 0);
}

/**
 * Module-level cache for `findProjectCwd`. Filesystem layout for project
 * directories changes rarely, so caching across `discoverSessions` calls
 * avoids re-running the O(2^n) DFS on every 30s refresh. A stale negative
 * cache entry would only matter if the user later created a missing
 * directory; a process restart is acceptable for that case.
 */
const smartDecodeCache = new Map<string, string | null>();

/**
 * Resolve the cwd to use when warming a session, falling back through
 * progressively weaker hints. The order matters: stronger hints are
 * authoritative because Claude Code records them, weaker ones are
 * heuristics that can be wrong on hyphenated paths.
 *   1. The session's own PID file (authoritative when the session is live).
 *   2. Any sibling PID file from the same project (authoritative — the
 *      encoded projectDir round-trips with the recorded cwd).
 *   3. Filesystem-aware greedy decode via `findProjectCwd`.
 *   4. Empty string (warmer falls back to its own cwd, which usually fails
 *      — but better than spawning into a non-existent directory).
 */
function resolveSessionCwd(
  fs: Fs,
  pidInfo: { cwd: string } | undefined,
  siblingCwdByProject: Map<string, string>,
  projectDir: string,
): string {
  if (pidInfo?.cwd) return pidInfo.cwd;
  const sibling = siblingCwdByProject.get(projectDir);
  if (sibling) return sibling;
  let smart = smartDecodeCache.get(projectDir);
  if (smart === undefined) {
    smart = findProjectCwd(fs, projectDir);
    smartDecodeCache.set(projectDir, smart);
  }
  return smart ?? '';
}

// Inverse of Claude Code's `/`→`-` encoding for cwd paths. Used only for
// the sibling-PID lookup map key; not a path constructor.
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export function checkPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseJsonlFile(content: string, sessionId: string): ParsedSession | null {
  let customTitle: string | null = null;
  let lastPrompt: string | null = null;
  let lastModel = '';
  let lastCacheRead = 0;
  let lastCacheWrite = 0;
  let lastTimestamp = 0;
  let hasAssistant = false;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      customTitle = record.customTitle;
    }

    if (record.type === 'last-prompt' && typeof record.lastPrompt === 'string') {
      lastPrompt = record.lastPrompt;
    }

    const msg = record.message as Record<string, unknown> | undefined;
    if (msg?.role === 'assistant' && msg.usage) {
      hasAssistant = true;
      const usage = msg.usage as Record<string, unknown>;
      lastModel = (msg.model as string) || lastModel;
      lastCacheRead = (usage.cache_read_input_tokens as number) || 0;
      lastCacheWrite = (usage.cache_creation_input_tokens as number) || 0;
      if (typeof record.timestamp === 'string') {
        lastTimestamp = new Date(record.timestamp).getTime();
      }
    }
  }

  if (!hasAssistant) return null;

  let name = customTitle || lastPrompt || sessionId;
  if (!customTitle && lastPrompt && lastPrompt.length > 50) {
    name = lastPrompt.slice(0, 50) + '...';
  }

  return {
    name,
    model: lastModel,
    cacheReadTokens: lastCacheRead,
    cacheWriteTokens: lastCacheWrite,
    lastAssistantTimestamp: lastTimestamp,
  };
}

interface PidLookups {
  bySessionId: Map<string, { cwd: string; pid: number; isLive: boolean }>;
  cwdByProject: Map<string, string>;
}

function loadPidFiles(fs: Fs): PidLookups {
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  const bySessionId = new Map<string, { cwd: string; pid: number; isLive: boolean }>();
  const cwdByProject = new Map<string, string>();

  if (!fs.existsSync(sessionsDir)) return { bySessionId, cwdByProject };

  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
      const entry: PidEntry = JSON.parse(content);
      const isLive = checkPidAlive(entry.pid);
      bySessionId.set(entry.sessionId, { cwd: entry.cwd, pid: entry.pid, isLive });
      // Reverse map: any PID file from the same project gives an authoritative
      // cwd we can use for sessions in that project that have no PID file
      // of their own. Resolves the hyphen-ambiguity in the encoding.
      if (entry.cwd) cwdByProject.set(encodeCwd(entry.cwd), entry.cwd);
    } catch {
      continue;
    }
  }

  return { bySessionId, cwdByProject };
}

export function discoverSessions(fs: Fs = realFs, clock: Clock = realClock): Session[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const { bySessionId: pidMap, cwdByProject: siblingCwdByProject } = loadPidFiles(fs);
  const sessions: Session[] = [];
  const now = clock.now();

  for (const projectDir of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, projectDir);
    let files: string[];
    try {
      files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      let content: string;
      try {
        content = fs.readFileSync(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }

      const parsed = parseJsonlFile(content, sessionId);
      if (!parsed) continue;

      const model = parsed.model;
      const cachedTokens = parsed.cacheReadTokens + parsed.cacheWriteTokens;
      if (cachedTokens === 0) continue;
      const pidInfo = pidMap.get(sessionId);
      const isWarm = now - parsed.lastAssistantTimestamp < WARM_THRESHOLD_MS;

      sessions.push({
        sessionId,
        name: parsed.name,
        projectDir,
        cwd: resolveSessionCwd(fs, pidInfo, siblingCwdByProject, projectDir),
        model,
        lastAssistantTimestamp: parsed.lastAssistantTimestamp,
        isWarm,
        isLive: pidInfo?.isLive || false,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheWriteTokens: parsed.cacheWriteTokens,
        expiryCostUsd: calcExpiryCost(cachedTokens, model),
        selected: isWarm,
        warmingStatus: 'idle',
        warmCostUsd: 0,
        warmCount: 0,
        nextWarmAt: null,
        lastWarmedAt: null,
        lastWarmError: null,
      });
    }
  }

  sessions.sort((a, b) => {
    const aTier = a.isLive ? 2 : a.isWarm ? 1 : 0;
    const bTier = b.isLive ? 2 : b.isWarm ? 1 : 0;
    if (aTier !== bTier) return bTier - aTier;
    const aCached = a.cacheReadTokens + a.cacheWriteTokens;
    const bCached = b.cacheReadTokens + b.cacheWriteTokens;
    return bCached - aCached;
  });

  return sessions;
}
