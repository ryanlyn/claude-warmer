import type { Session } from './types.js';

// Pure state machine for the session list. Effects in `app.tsx` compute
// the result of any Scheduler/clock/random call FIRST and then dispatch a
// data-only event so the reducer stays side-effect-free.

export interface AppSessionState {
  sessions: Session[];
  warming: boolean;
  intervalMinutes: number;
  warmPrompt: string;
}

export type AppEvent =
  | { type: 'REFRESH_MERGE'; fresh: Session[] }
  | { type: 'TICK_RESULT'; updated: Session[] }
  | { type: 'REPLACE_SESSION'; sessionId: string; next: Session }
  | { type: 'REPLACE_ALL'; next: Session[] }
  | { type: 'WARMING_ON'; bootstrapped: Session[] }
  | { type: 'WARMING_OFF' }
  | { type: 'SET_INTERVAL'; minutes: number }
  | { type: 'SET_PROMPT'; prompt: string };

export function initialState(intervalMinutes: number, warmPrompt: string): AppSessionState {
  return {
    sessions: [],
    warming: false,
    intervalMinutes,
    warmPrompt,
  };
}

// Preserves discovery's `selected: isWarm` for sessions new to the merge so
// auto-selected warm sessions reach the scheduler on the next refresh.
function mergeRefresh(prev: Session[], fresh: Session[]): Session[] {
  const prevById = new Map(prev.map((s) => [s.sessionId, s]));
  let changed = prev.length !== fresh.length;
  const merged = fresh.map((s, i) => {
    const existing = prevById.get(s.sessionId);
    const next: Session = existing
      ? {
          ...s,
          selected: existing.selected,
          warmingStatus: existing.warmingStatus,
          warmCostUsd: existing.warmCostUsd,
          warmCount: existing.warmCount,
          nextWarmAt: existing.nextWarmAt,
          lastWarmedAt: existing.lastWarmedAt,
          lastWarmError: existing.lastWarmError,
          consecutiveErrors: existing.consecutiveErrors,
        }
      : s;
    if (!changed && !sessionsShallowEqual(prev[i], next)) changed = true;
    return next;
  });
  return changed ? merged : prev;
}

// Merges tick results by sessionId so a refresh that added a session during
// a long warm survives the tick result; sessions removed by the user are dropped.
function mergeTickResults(latest: Session[], updated: Session[]): Session[] {
  if (updated === latest) return latest;
  const updatedById = new Map(updated.map((s) => [s.sessionId, s]));
  let changed = false;
  const merged = latest.map((s) => {
    const tickVersion = updatedById.get(s.sessionId);
    if (!tickVersion) return s;
    if (sessionsShallowEqual(s, tickVersion)) return s;
    changed = true;
    return tickVersion;
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
  'warmingStatus',
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
    case 'REFRESH_MERGE': {
      const next = mergeRefresh(state.sessions, event.fresh);
      return next === state.sessions ? state : { ...state, sessions: next };
    }
    case 'TICK_RESULT': {
      const next = mergeTickResults(state.sessions, event.updated);
      return next === state.sessions ? state : { ...state, sessions: next };
    }
    case 'REPLACE_SESSION': {
      const idx = state.sessions.findIndex((s) => s.sessionId === event.sessionId);
      if (idx === -1) return state;
      const next = [...state.sessions];
      next[idx] = event.next;
      return { ...state, sessions: next };
    }
    case 'REPLACE_ALL':
      return { ...state, sessions: event.next };
    case 'WARMING_ON':
      return { ...state, warming: true, sessions: event.bootstrapped };
    case 'WARMING_OFF':
      return {
        ...state,
        warming: false,
        sessions: state.sessions.map((s) => ({
          ...s,
          nextWarmAt: null,
          warmingStatus: s.warmingStatus === 'warming' ? 'idle' : s.warmingStatus,
        })),
      };
    case 'SET_INTERVAL':
      return { ...state, intervalMinutes: event.minutes };
    case 'SET_PROMPT':
      return { ...state, warmPrompt: event.prompt };
  }
}

// Exported for direct unit testing of the merge semantics.
export { mergeRefresh, mergeTickResults };
