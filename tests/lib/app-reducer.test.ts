import { describe, it, expect } from 'vitest';
import {
  appReducer,
  initialState,
  mergeRefresh,
  mergeTickResults,
  type AppSessionState,
} from '../../src/lib/app-reducer.js';
import type { Session } from '../../src/lib/types.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'id-1',
    name: 'Test',
    projectDir: 'proj',
    cwd: '/proj',
    model: 'claude-sonnet-4-6',
    lastAssistantTimestamp: 0,
    isWarm: false,
    isLive: false,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    expiryCostUsd: 0,
    selected: false,
    warmingStatus: 'idle',
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
    ...overrides,
  };
}

function stateWith(sessions: Session[], overrides: Partial<AppSessionState> = {}): AppSessionState {
  return { ...initialState(55, "Reply 'ok'"), sessions, ...overrides };
}

describe('mergeRefresh', () => {
  it('preserves warmer-owned fields on sessions we have seen before', () => {
    const prev = [
      session({
        sessionId: 's1',
        selected: true,
        warmCount: 5,
        nextWarmAt: 1234567,
        warmingStatus: 'success',
        warmCostUsd: 0.02,
        lastWarmedAt: 1000000,
        lastWarmError: 'old err',
      }),
    ];
    const fresh = [
      session({
        sessionId: 's1',
        cacheReadTokens: 88888,
        isWarm: true,
        selected: false,
        warmCount: 0,
        nextWarmAt: null,
      }),
    ];
    const merged = mergeRefresh(prev, fresh);
    expect(merged[0].cacheReadTokens).toBe(88888);
    expect(merged[0].isWarm).toBe(true);
    expect(merged[0].selected).toBe(true);
    expect(merged[0].warmCount).toBe(5);
    expect(merged[0].nextWarmAt).toBe(1234567);
    expect(merged[0].warmingStatus).toBe('success');
    expect(merged[0].lastWarmedAt).toBe(1000000);
    expect(merged[0].lastWarmError).toBe('old err');
    expect(merged[0].warmCostUsd).toBe(0.02);
  });

  it('preserves consecutiveErrors across refresh so backoff escalates correctly', () => {
    // Regression: a session that has failed N times must keep its retry
    // counter through the periodic refresh, otherwise the bounded backoff
    // schedule resets to attempt 0 every 30s and the warmer hammers a
    // broken session at the shortest backoff slot forever.
    const prev = [session({ sessionId: 's1', consecutiveErrors: 3, lastWarmError: 'spawn failed' })];
    const fresh = [session({ sessionId: 's1' })]; // discoverSessions never sets consecutiveErrors
    const merged = mergeRefresh(prev, fresh);
    expect(merged[0].consecutiveErrors).toBe(3);
  });

  it('preserves discovery-supplied selected:true on sessions new to this refresh (B1 fixed)', () => {
    const prev = [session({ sessionId: 's1', selected: true })];
    const fresh = [
      session({ sessionId: 's1', selected: true }),
      // New session — discoverSessions sets selected:true for warm sessions;
      // mergeRefresh must preserve that so the new session auto-joins
      // warming on the next refresh.
      session({ sessionId: 's2', selected: true, isWarm: true }),
    ];
    const merged = mergeRefresh(prev, fresh);
    const s2 = merged.find((s) => s.sessionId === 's2')!;
    expect(s2.selected).toBe(true);
  });

  it('drops sessions no longer present in fresh', () => {
    const prev = [session({ sessionId: 's1' }), session({ sessionId: 's2' })];
    const fresh = [session({ sessionId: 's1' })];
    const merged = mergeRefresh(prev, fresh);
    expect(merged.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('returns the same array reference when merge yields no changes (no-op short-circuit)', () => {
    const prev = [
      session({ sessionId: 's1', selected: true, warmCount: 3, isWarm: true }),
      session({ sessionId: 's2', selected: false, isWarm: false }),
    ];
    // Fresh has the same discovery-fields as prev; warmer-owned fields are
    // preserved from prev anyway, so merged === prev structurally.
    const fresh = [
      session({ sessionId: 's1', selected: true, warmCount: 3, isWarm: true }),
      session({ sessionId: 's2', selected: false, isWarm: false }),
    ];
    expect(mergeRefresh(prev, fresh)).toBe(prev);
  });
});

describe('mergeTickResults', () => {
  it('updates sessions by id with the tick version', () => {
    const latest = [
      session({ sessionId: 's1', warmCount: 0 }),
      session({ sessionId: 's2', warmCount: 0 }),
    ];
    const updated = [session({ sessionId: 's1', warmCount: 5, lastWarmedAt: 12345 })];
    const merged = mergeTickResults(latest, updated);
    expect(merged.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(merged.find((s) => s.sessionId === 's1')!.warmCount).toBe(5);
    expect(merged.find((s) => s.sessionId === 's1')!.lastWarmedAt).toBe(12345);
  });

  it('preserves sessions that exist only in latest (refresh added mid-tick)', () => {
    const latest = [session({ sessionId: 's1' }), session({ sessionId: 's2', name: 'NewByRefresh' })];
    const updated = [session({ sessionId: 's1', warmCount: 1 })];
    const merged = mergeTickResults(latest, updated);
    const s2 = merged.find((s) => s.sessionId === 's2')!;
    expect(s2).toBeDefined();
    expect(s2.name).toBe('NewByRefresh');
  });

  it('drops sessions present only in updated (user removed them mid-tick)', () => {
    const latest = [session({ sessionId: 's1' })];
    const updated = [
      session({ sessionId: 's1', warmCount: 1 }),
      session({ sessionId: 's-gone', warmCount: 9 }),
    ];
    const merged = mergeTickResults(latest, updated);
    expect(merged.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('returns the same array reference when every entry shallow-equals (no-op short-circuit)', () => {
    const latest = [
      session({ sessionId: 's1', warmCount: 2 }),
      session({ sessionId: 's2', warmCount: 0 }),
    ];
    const updated = [session({ sessionId: 's1', warmCount: 2 })];
    expect(mergeTickResults(latest, updated)).toBe(latest);
  });

  it('returns the same array reference when updated === latest (identity short-circuit)', () => {
    const latest = [session({ sessionId: 's1' })];
    expect(mergeTickResults(latest, latest)).toBe(latest);
  });
});

describe('appReducer', () => {
  it('REFRESH_MERGE applies mergeRefresh', () => {
    const state = stateWith([session({ sessionId: 's1', selected: true, warmCount: 3 })]);
    const next = appReducer(state, {
      type: 'REFRESH_MERGE',
      fresh: [session({ sessionId: 's1', selected: false, cacheReadTokens: 100 })],
    });
    expect(next.sessions[0].selected).toBe(true);
    expect(next.sessions[0].cacheReadTokens).toBe(100);
    expect(next.sessions[0].warmCount).toBe(3);
  });

  it('REFRESH_MERGE no-ops when merge yields no change', () => {
    const state = stateWith([session({ sessionId: 's1', selected: true, warmCount: 3, isWarm: true })]);
    const next = appReducer(state, {
      type: 'REFRESH_MERGE',
      fresh: [session({ sessionId: 's1', selected: true, warmCount: 3, isWarm: true })],
    });
    expect(next).toBe(state);
  });

  it('TICK_RESULT merges by sessionId, preserving sessions added by mid-tick refresh', () => {
    // Latest has s1 and s2 (refresh added s2 during tick). Tick was computed
    // from a stale snapshot containing only s1. The merge must take s1 from
    // tick (it has fresh warmCount/etc.) and keep s2 from latest.
    const state = stateWith([session({ sessionId: 's1' }), session({ sessionId: 's2' })]);
    const next = appReducer(state, {
      type: 'TICK_RESULT',
      updated: [session({ sessionId: 's1', warmCount: 1 })],
    });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(next.sessions.find((s) => s.sessionId === 's1')!.warmCount).toBe(1);
  });

  it('TICK_RESULT no-ops when updated === current sessions reference', () => {
    const state = stateWith([session({ sessionId: 's1' })]);
    const next = appReducer(state, { type: 'TICK_RESULT', updated: state.sessions });
    expect(next).toBe(state);
  });

  it('REPLACE_SESSION updates by id, no-op on unknown id', () => {
    const state = stateWith([session({ sessionId: 'a', selected: false })]);
    const next = appReducer(state, {
      type: 'REPLACE_SESSION',
      sessionId: 'a',
      next: session({ sessionId: 'a', selected: true }),
    });
    expect(next.sessions[0].selected).toBe(true);

    const unchanged = appReducer(state, {
      type: 'REPLACE_SESSION',
      sessionId: 'missing',
      next: session({ sessionId: 'missing' }),
    });
    expect(unchanged).toBe(state);
  });

  it('REPLACE_ALL swaps the session list', () => {
    const state = stateWith([session({ sessionId: 'old' })]);
    const next = appReducer(state, { type: 'REPLACE_ALL', next: [session({ sessionId: 'new' })] });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['new']);
  });

  it('WARMING_ON flips warming and adopts bootstrapped sessions', () => {
    const state = stateWith([session({ sessionId: 'a' })]);
    const next = appReducer(state, {
      type: 'WARMING_ON',
      bootstrapped: [session({ sessionId: 'a', nextWarmAt: 9999 })],
    });
    expect(next.warming).toBe(true);
    expect(next.sessions[0].nextWarmAt).toBe(9999);
  });

  it('WARMING_OFF clears nextWarmAt and resets in-flight status to idle', () => {
    const state = stateWith(
      [
        session({ sessionId: 'a', nextWarmAt: 1, warmingStatus: 'warming' }),
        session({ sessionId: 'b', warmingStatus: 'success' }),
      ],
      { warming: true },
    );
    const next = appReducer(state, { type: 'WARMING_OFF' });
    expect(next.warming).toBe(false);
    expect(next.sessions[0].nextWarmAt).toBeNull();
    expect(next.sessions[0].warmingStatus).toBe('idle');
    expect(next.sessions[1].warmingStatus).toBe('success');
  });

  it('SET_INTERVAL updates intervalMinutes only', () => {
    const state = stateWith([], { intervalMinutes: 55 });
    const next = appReducer(state, { type: 'SET_INTERVAL', minutes: 30 });
    expect(next.intervalMinutes).toBe(30);
  });

  it('SET_PROMPT updates warmPrompt only', () => {
    const state = stateWith([], { warmPrompt: 'old' });
    const next = appReducer(state, { type: 'SET_PROMPT', prompt: 'new' });
    expect(next.warmPrompt).toBe('new');
  });
});
