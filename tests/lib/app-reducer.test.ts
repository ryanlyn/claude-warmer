import { describe, it, expect } from 'vitest';
import {
  appReducer,
  initialState,
  applyWarmPatches,
  mergeDiscoverySnapshot,
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
    warmStatus: 'idle',
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

describe('mergeDiscoverySnapshot', () => {
  it('preserves warmer-owned fields on sessions we have seen before', () => {
    const prev = [
      session({
        sessionId: 's1',
        selected: true,
        warmCount: 5,
        nextWarmAt: 1234567,
        warmStatus: 'success',
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
    const merged = mergeDiscoverySnapshot(prev, fresh);
    expect(merged[0].cacheReadTokens).toBe(88888);
    expect(merged[0].isWarm).toBe(true);
    expect(merged[0].selected).toBe(true);
    expect(merged[0].warmCount).toBe(5);
    expect(merged[0].nextWarmAt).toBe(1234567);
    expect(merged[0].warmStatus).toBe('success');
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
    const merged = mergeDiscoverySnapshot(prev, fresh);
    expect(merged[0].consecutiveErrors).toBe(3);
  });

  it('preserves discovery-supplied selected:true on sessions new to this refresh (B1 fixed)', () => {
    const prev = [session({ sessionId: 's1', selected: true })];
    const fresh = [
      session({ sessionId: 's1', selected: true }),
      // New session - discoverSessions sets selected:true for warm sessions;
      // mergeDiscoverySnapshot must preserve that so the new session auto-joins
      // warming on the next refresh.
      session({ sessionId: 's2', selected: true, isWarm: true }),
    ];
    const merged = mergeDiscoverySnapshot(prev, fresh);
    const s2 = merged.find((s) => s.sessionId === 's2')!;
    expect(s2.selected).toBe(true);
  });

  it('drops sessions no longer present in fresh', () => {
    const prev = [session({ sessionId: 's1' }), session({ sessionId: 's2' })];
    const fresh = [session({ sessionId: 's1' })];
    const merged = mergeDiscoverySnapshot(prev, fresh);
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
    expect(mergeDiscoverySnapshot(prev, fresh)).toBe(prev);
  });
});

describe('applyWarmPatches', () => {
  it('applies warm success facts without replacing discovery-owned fields', () => {
    const latest = [
      session({ sessionId: 's1', name: 'Fresh discovery name', cwd: '/fresh', selected: true, warmCount: 0 }),
      session({ sessionId: 's2', warmCount: 0 }),
    ];
    const merged = applyWarmPatches(latest, [
      {
        type: 'succeeded',
        sessionId: 's1',
        warmedAt: 12345,
        nextWarmAt: 67890,
        usage: { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 1_000, outputTokens: 3 },
        model: 'claude-sonnet-4-6',
        costUsd: 0.015,
      },
    ]);
    expect(merged.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(merged.find((s) => s.sessionId === 's1')!.name).toBe('Fresh discovery name');
    expect(merged.find((s) => s.sessionId === 's1')!.cwd).toBe('/fresh');
    expect(merged.find((s) => s.sessionId === 's1')!.warmCount).toBe(1);
    expect(merged.find((s) => s.sessionId === 's1')!.lastWarmedAt).toBe(12345);
    expect(merged.find((s) => s.sessionId === 's1')!.nextWarmAt).toBe(67890);
    expect(merged.find((s) => s.sessionId === 's1')!.warmStatus).toBe('success');
  });

  it('applies started patches to selected sessions', () => {
    const latest = [session({ sessionId: 's1', selected: true, warmStatus: 'idle' })];
    const merged = applyWarmPatches(latest, [{ type: 'started', sessionId: 's1', startedAt: 1000 }]);
    expect(merged[0].warmStatus).toBe('warming');
  });

  it('keeps the same reference when a started patch targets a deselected session', () => {
    const latest = [session({ sessionId: 's1', selected: false, warmStatus: 'idle' })];
    const merged = applyWarmPatches(latest, [{ type: 'started', sessionId: 's1', startedAt: 1000 }]);
    expect(merged).toBe(latest);
  });

  it('falls back to the existing session model when a success patch has no model', () => {
    const latest = [session({ sessionId: 's1', selected: true, model: 'claude-sonnet-4-6' })];
    const merged = applyWarmPatches(latest, [
      {
        type: 'succeeded',
        sessionId: 's1',
        warmedAt: 1000,
        nextWarmAt: 2000,
        usage: { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0, outputTokens: 3 },
        model: '',
        costUsd: 0.015,
      },
    ]);
    expect(merged[0].model).toBe('claude-sonnet-4-6');
  });

  it('preserves sessions that exist only in latest (refresh added mid-tick)', () => {
    const latest = [session({ sessionId: 's1' }), session({ sessionId: 's2', name: 'NewByRefresh' })];
    const merged = applyWarmPatches(latest, [
      {
        type: 'succeeded',
        sessionId: 's1',
        warmedAt: 1000,
        nextWarmAt: 2000,
        usage: { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0, outputTokens: 3 },
        model: 'claude-sonnet-4-6',
        costUsd: 0.015,
      },
    ]);
    const s2 = merged.find((s) => s.sessionId === 's2')!;
    expect(s2).toBeDefined();
    expect(s2.name).toBe('NewByRefresh');
  });

  it('ignores patches for sessions no longer present in latest', () => {
    const latest = [session({ sessionId: 's1' })];
    const merged = applyWarmPatches(latest, [
      { type: 'started', sessionId: 's-gone', startedAt: 1000 },
      {
        type: 'succeeded',
        sessionId: 's1',
        warmedAt: 1000,
        nextWarmAt: 2000,
        usage: { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0, outputTokens: 3 },
        model: 'claude-sonnet-4-6',
        costUsd: 0.015,
      },
    ]);
    expect(merged.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('does not reschedule a session that was deselected while its warm was in flight', () => {
    const latest = [session({ sessionId: 's1', selected: false, nextWarmAt: null })];
    const merged = applyWarmPatches(latest, [
      {
        type: 'succeeded',
        sessionId: 's1',
        warmedAt: 1000,
        nextWarmAt: 2000,
        usage: { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0, outputTokens: 3 },
        model: 'claude-sonnet-4-6',
        costUsd: 0.015,
      },
    ]);
    expect(merged[0].selected).toBe(false);
    expect(merged[0].warmCount).toBe(1);
    expect(merged[0].nextWarmAt).toBeNull();
  });

  it('applies warm failure facts and schedules the retry while still selected', () => {
    const latest = [session({ sessionId: 's1', selected: true, nextWarmAt: 500 })];
    const merged = applyWarmPatches(latest, [
      {
        type: 'failed',
        sessionId: 's1',
        failedAt: 1000,
        nextWarmAt: 2000,
        error: 'PTY failed',
        consecutiveErrors: 2,
      },
    ]);
    expect(merged[0].warmStatus).toBe('error');
    expect(merged[0].lastWarmError).toBe('PTY failed');
    expect(merged[0].consecutiveErrors).toBe(2);
    expect(merged[0].nextWarmAt).toBe(2000);
  });

  it('does not reschedule a failed warm when the session was deselected mid-flight', () => {
    const latest = [session({ sessionId: 's1', selected: false, nextWarmAt: null })];
    const merged = applyWarmPatches(latest, [
      {
        type: 'failed',
        sessionId: 's1',
        failedAt: 1000,
        nextWarmAt: 2000,
        error: 'PTY failed',
        consecutiveErrors: 2,
      },
    ]);
    expect(merged[0].warmStatus).toBe('error');
    expect(merged[0].nextWarmAt).toBeNull();
  });

  it('returns the same array reference when there are no patches', () => {
    const latest = [session({ sessionId: 's1', warmCount: 2 }), session({ sessionId: 's2', warmCount: 0 })];
    expect(applyWarmPatches(latest, [])).toBe(latest);
  });
});

describe('appReducer', () => {
  it('DISCOVERY_SNAPSHOT_RECEIVED applies mergeDiscoverySnapshot', () => {
    const state = stateWith([session({ sessionId: 's1', selected: true, warmCount: 3 })]);
    const next = appReducer(state, {
      type: 'DISCOVERY_SNAPSHOT_RECEIVED',
      fresh: [session({ sessionId: 's1', selected: false, cacheReadTokens: 100 })],
    });
    expect(next.sessions[0].selected).toBe(true);
    expect(next.sessions[0].cacheReadTokens).toBe(100);
    expect(next.sessions[0].warmCount).toBe(3);
  });

  it('DISCOVERY_SNAPSHOT_RECEIVED no-ops when merge yields no change', () => {
    const state = stateWith([session({ sessionId: 's1', selected: true, warmCount: 3, isWarm: true })]);
    const next = appReducer(state, {
      type: 'DISCOVERY_SNAPSHOT_RECEIVED',
      fresh: [session({ sessionId: 's1', selected: true, warmCount: 3, isWarm: true })],
    });
    expect(next).toBe(state);
  });

  it('WARM_PATCHES_RECEIVED applies patches while preserving sessions added by mid-tick refresh', () => {
    // Latest has s1 and s2 (refresh added s2 during tick). Tick was computed
    // from a stale snapshot containing only s1. The merge must take s1 from
    // tick (it has fresh warmCount/etc.) and keep s2 from latest.
    const state = stateWith([session({ sessionId: 's1' }), session({ sessionId: 's2' })], {
      warmingEnabled: true,
      warmingRunId: 1,
    });
    const next = appReducer(state, {
      type: 'WARM_PATCHES_RECEIVED',
      runId: 1,
      patches: [
        {
          type: 'succeeded',
          sessionId: 's1',
          warmedAt: 1000,
          nextWarmAt: 2000,
          usage: { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0, outputTokens: 3 },
          model: 'claude-sonnet-4-6',
          costUsd: 0.015,
        },
      ],
    });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(next.sessions.find((s) => s.sessionId === 's1')!.warmCount).toBe(1);
  });

  it('WARM_PATCHES_RECEIVED ignores stale patches after warming is stopped', () => {
    const state = stateWith([session({ sessionId: 's1' })], { warmingEnabled: false, warmingRunId: 2 });
    const next = appReducer(state, {
      type: 'WARM_PATCHES_RECEIVED',
      runId: 1,
      patches: [{ type: 'started', sessionId: 's1', startedAt: 1000 }],
    });
    expect(next).toBe(state);
  });

  it('SESSION_REPLACED updates by id, no-op on unknown id', () => {
    const state = stateWith([session({ sessionId: 'a', selected: false })]);
    const next = appReducer(state, {
      type: 'SESSION_REPLACED',
      sessionId: 'a',
      next: session({ sessionId: 'a', selected: true }),
    });
    expect(next.sessions[0].selected).toBe(true);

    const unchanged = appReducer(state, {
      type: 'SESSION_REPLACED',
      sessionId: 'missing',
      next: session({ sessionId: 'missing' }),
    });
    expect(unchanged).toBe(state);
  });

  it('SESSION_LIST_REPLACED swaps the session list', () => {
    const state = stateWith([session({ sessionId: 'old' })]);
    const next = appReducer(state, { type: 'SESSION_LIST_REPLACED', next: [session({ sessionId: 'new' })] });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['new']);
  });

  it('WARMING_STARTED flips warmingEnabled and adopts bootstrapped sessions', () => {
    const state = stateWith([session({ sessionId: 'a' })]);
    const next = appReducer(state, {
      type: 'WARMING_STARTED',
      runId: 1,
      bootstrapped: [session({ sessionId: 'a', nextWarmAt: 9999 })],
    });
    expect(next.warmingEnabled).toBe(true);
    expect(next.warmingRunId).toBe(1);
    expect(next.sessions[0].nextWarmAt).toBe(9999);
  });

  it('WARMING_STOPPED clears nextWarmAt and resets in-flight status to idle', () => {
    const state = stateWith(
      [
        session({ sessionId: 'a', nextWarmAt: 1, warmStatus: 'warming' }),
        session({ sessionId: 'b', warmStatus: 'success' }),
      ],
      { warmingEnabled: true, warmingRunId: 1 },
    );
    const next = appReducer(state, { type: 'WARMING_STOPPED', runId: 2 });
    expect(next.warmingEnabled).toBe(false);
    expect(next.warmingRunId).toBe(2);
    expect(next.sessions[0].nextWarmAt).toBeNull();
    expect(next.sessions[0].warmStatus).toBe('idle');
    expect(next.sessions[1].warmStatus).toBe('success');
  });

  it('INTERVAL_CHANGED updates intervalMinutes only', () => {
    const state = stateWith([], { intervalMinutes: 55 });
    const next = appReducer(state, { type: 'INTERVAL_CHANGED', minutes: 30 });
    expect(next.intervalMinutes).toBe(30);
  });

  it('PROMPT_CHANGED updates warmPrompt only', () => {
    const state = stateWith([], { warmPrompt: 'old' });
    const next = appReducer(state, { type: 'PROMPT_CHANGED', prompt: 'new' });
    expect(next.warmPrompt).toBe('new');
  });
});
