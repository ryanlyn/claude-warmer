import type { Session, WarmPatch } from './types.ts';
import { calcExpiryCost } from './pricing.ts';

// Pure state machine for the session list. Effects in `app.tsx` compute
// Scheduler/clock/random/fs results first, then dispatch data-only events so
// the reducer stays side-effect-free.

export interface AppSessionState {
  sessions: Session[];
  warmingEnabled: boolean;
  warmingRunId: number;
  intervalMinutes: number;
  warmPrompt: string;
}

export type AppEvent =
  | { type: 'DISCOVERY_SNAPSHOT_RECEIVED'; fresh: Session[] }
  | { type: 'WARM_PATCHES_RECEIVED'; runId: number; patches: WarmPatch[] }
  | { type: 'SESSION_REPLACED'; sessionId: string; next: Session }
  | { type: 'SESSION_LIST_REPLACED'; next: Session[] }
  | { type: 'WARMING_STARTED'; runId: number; bootstrapped: Session[] }
  | { type: 'WARMING_STOPPED'; runId: number }
  | { type: 'INTERVAL_CHANGED'; minutes: number }
  | { type: 'PROMPT_CHANGED'; prompt: string };

export function initialState(intervalMinutes: number, warmPrompt: string): AppSessionState {
  return {
    sessions: [],
    warmingEnabled: false,
    warmingRunId: 0,
    intervalMinutes,
    warmPrompt,
  };
}

function preserveRuntimeFields(discovered: Session, existing: Session): Session {
  return {
    ...discovered,
    selected: existing.selected,
    warmStatus: existing.warmStatus,
    warmCostUsd: existing.warmCostUsd,
    warmCount: existing.warmCount,
    nextWarmAt: existing.nextWarmAt,
    lastWarmedAt: existing.lastWarmedAt,
    lastWarmError: existing.lastWarmError,
    consecutiveErrors: existing.consecutiveErrors,
  };
}

// Preserve discovery's `selected: isWarm` for sessions new to the snapshot so
// auto-selected warm sessions reach the scheduler on the next refresh.
function mergeDiscoverySnapshot(prev: Session[], fresh: Session[]): Session[] {
  const prevById = new Map(prev.map((s) => [s.sessionId, s]));
  let changed = prev.length !== fresh.length;
  const merged = fresh.map((s, i) => {
    const existing = prevById.get(s.sessionId);
    const next = existing ? preserveRuntimeFields(s, existing) : s;
    if (!changed && !sessionsShallowEqual(prev[i], next)) changed = true;
    return next;
  });
  return changed ? merged : prev;
}

function applyWarmPatch(session: Session, patch: WarmPatch): Session {
  switch (patch.type) {
    case 'started':
      return session.selected ? { ...session, warmStatus: 'warming' } : session;
    case 'succeeded': {
      const model = patch.model || session.model;
      return {
        ...session,
        warmStatus: 'success',
        warmCostUsd: patch.costUsd,
        warmCount: session.warmCount + 1,
        nextWarmAt: session.selected ? patch.nextWarmAt : null,
        lastWarmedAt: patch.warmedAt,
        lastWarmError: null,
        consecutiveErrors: 0,
        cacheReadTokens: patch.usage.cacheReadInputTokens,
        cacheWriteTokens: patch.usage.cacheCreationInputTokens,
        expiryCostUsd: calcExpiryCost(patch.usage.cacheReadInputTokens + patch.usage.cacheCreationInputTokens, model),
        isWarm: true,
        model,
      };
    }
    case 'failed':
      return {
        ...session,
        warmStatus: 'error',
        lastWarmError: patch.error,
        consecutiveErrors: patch.consecutiveErrors,
        nextWarmAt: session.selected ? patch.nextWarmAt : null,
      };
  }
}

// Applies warm-owned facts to the latest session list. Discovery-owned fields
// stay with the latest refresh, sessions added during a long warm survive, and
// patches for sessions no longer present are ignored.
function applyWarmPatches(latest: Session[], patches: WarmPatch[]): Session[] {
  if (patches.length === 0) return latest;

  const patchesById = new Map<string, WarmPatch[]>();
  for (const patch of patches) {
    const sessionPatches = patchesById.get(patch.sessionId) ?? [];
    sessionPatches.push(patch);
    patchesById.set(patch.sessionId, sessionPatches);
  }

  let changed = false;
  const merged = latest.map((session) => {
    const sessionPatches = patchesById.get(session.sessionId);
    if (!sessionPatches) return session;

    let next = session;
    for (const patch of sessionPatches) {
      next = applyWarmPatch(next, patch);
    }

    if (sessionsShallowEqual(session, next)) return session;
    changed = true;
    return next;
  });

  return changed ? merged : latest;
}

const SESSION_KEYS: ReadonlyArray<keyof Session> = [
  'sessionId',
  'name',
  'projectDir',
  'cwd',
  'model',
  'lastAssistantTimestamp',
  'isWarm',
  'isLive',
  'cacheReadTokens',
  'cacheWriteTokens',
  'expiryCostUsd',
  'selected',
  'warmStatus',
  'warmCostUsd',
  'warmCount',
  'nextWarmAt',
  'lastWarmedAt',
  'lastWarmError',
  'consecutiveErrors',
];

function sessionsShallowEqual(a: Session, b: Session): boolean {
  return SESSION_KEYS.every((k) => a[k] === b[k]);
}

export function appReducer(state: AppSessionState, event: AppEvent): AppSessionState {
  switch (event.type) {
    case 'DISCOVERY_SNAPSHOT_RECEIVED': {
      const next = mergeDiscoverySnapshot(state.sessions, event.fresh);
      return next === state.sessions ? state : { ...state, sessions: next };
    }
    case 'WARM_PATCHES_RECEIVED': {
      if (!state.warmingEnabled || event.runId !== state.warmingRunId) return state;
      const next = applyWarmPatches(state.sessions, event.patches);
      return next === state.sessions ? state : { ...state, sessions: next };
    }
    case 'SESSION_REPLACED': {
      const idx = state.sessions.findIndex((s) => s.sessionId === event.sessionId);
      if (idx === -1) return state;
      const next = [...state.sessions];
      next[idx] = event.next;
      return { ...state, sessions: next };
    }
    case 'SESSION_LIST_REPLACED':
      return { ...state, sessions: event.next };
    case 'WARMING_STARTED':
      return { ...state, warmingEnabled: true, warmingRunId: event.runId, sessions: event.bootstrapped };
    case 'WARMING_STOPPED':
      return {
        ...state,
        warmingEnabled: false,
        warmingRunId: event.runId,
        sessions: state.sessions.map((s) => ({
          ...s,
          nextWarmAt: null,
          warmStatus: s.warmStatus === 'warming' ? 'idle' : s.warmStatus,
        })),
      };
    case 'INTERVAL_CHANGED':
      return { ...state, intervalMinutes: event.minutes };
    case 'PROMPT_CHANGED':
      return { ...state, warmPrompt: event.prompt };
  }
}

// Exported for direct unit testing of the merge semantics.
export { applyWarmPatches, mergeDiscoverySnapshot };
