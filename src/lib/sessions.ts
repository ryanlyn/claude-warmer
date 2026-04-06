import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Session } from './types.js';
import { calcExpiryCost } from './pricing.js';
import { WARM_THRESHOLD_MS } from './types.js';

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

function loadPidFiles(): Map<string, { cwd: string; pid: number; isLive: boolean }> {
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  const map = new Map<string, { cwd: string; pid: number; isLive: boolean }>();

  if (!fs.existsSync(sessionsDir)) return map;

  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
      const entry: PidEntry = JSON.parse(content);
      const isLive = checkPidAlive(entry.pid);
      map.set(entry.sessionId, { cwd: entry.cwd, pid: entry.pid, isLive });
    } catch {
      continue;
    }
  }

  return map;
}

export function discoverSessions(): Session[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const pidMap = loadPidFiles();
  const sessions: Session[] = [];
  const now = Date.now();

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
        cwd: pidInfo?.cwd || '',
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
