import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { type Spy, spy, stub } from '@std/testing/mock';
import { FakeTime } from '@std/testing/time';
import { Scheduler } from '../../src/lib/scheduler.ts';
import type { Session, WarmResult } from '../../src/lib/types.ts';
import { BACKOFF_SCHEDULE_MS, SAFETY_MARGIN_MS, WARM_THRESHOLD_MS } from '../../src/lib/types.ts';

type WarmFnSig = (sessionId: string, prompt: string, cwd?: string, projectDir?: string) => Promise<WarmResult>;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'test-id',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-sonnet-4-6',
    lastAssistantTimestamp: Date.now() - 10 * 60 * 1000,
    isWarm: true,
    isLive: false,
    cacheReadTokens: 50000,
    cacheWriteTokens: 1000,
    expiryCostUsd: 0.3,
    selected: true,
    warmStatus: 'idle',
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
    ...overrides,
  };
}

function defaultSuccess(): WarmResult {
  return {
    sessionId: 'test-id',
    usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
    model: 'claude-sonnet-4-6',
    costUsd: 0.015,
    error: null,
  };
}

/**
 * Build a stub WarmFn whose queued return values fire in order; if exhausted,
 * the last value is reused (matching vitest's mockResolvedValueOnce → mockResolvedValue).
 */
function stubWarmFn(results: WarmResult[] | WarmResult): Spy<unknown, Parameters<WarmFnSig>, ReturnType<WarmFnSig>> {
  const queue = Array.isArray(results) ? [...results] : [results];
  return spy(async (..._args: Parameters<WarmFnSig>) => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return await Promise.resolve(next);
  });
}

describe('Scheduler', () => {
  let time: FakeTime;
  let warmFn: Spy<unknown, Parameters<WarmFnSig>, ReturnType<WarmFnSig>>;
  let scheduler: Scheduler;

  beforeEach(() => {
    time = new FakeTime();
    warmFn = stubWarmFn(defaultSuccess());
    scheduler = new Scheduler(warmFn as unknown as WarmFnSig);
  });

  afterEach(() => {
    scheduler.stop();
    time.restore();
  });

  describe('bootstrap', () => {
    it('schedules a warm session within its valid window', () => {
      const session = makeSession({ lastAssistantTimestamp: Date.now() - 10 * 60 * 1000 });
      const result = scheduler.bootstrap([session], 55);

      expect(result).toHaveLength(1);
      const nextWarm = result[0].nextWarmAt!;
      const windowEnd = session.lastAssistantTimestamp + WARM_THRESHOLD_MS;
      expect(nextWarm).toBeGreaterThanOrEqual(Date.now());
      expect(nextWarm).toBeLessThanOrEqual(windowEnd);
    });

    it('schedules a cold session immediately (nextWarmAt <= now)', () => {
      const session = makeSession({
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
        isWarm: false,
      });
      const result = scheduler.bootstrap([session], 55);

      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt!).toBeLessThanOrEqual(Date.now());
    });

    it('schedules live sessions normally', () => {
      const session = makeSession({ isLive: true });
      const result = scheduler.bootstrap([session], 55);
      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt).not.toBeNull();
    });

    it('skips deselected sessions', () => {
      const session = makeSession({ selected: false });
      const result = scheduler.bootstrap([session], 55);
      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt).toBeNull();
    });

    it('anchors first-warm on lastAssistantTimestamp, not lastWarmedAt', () => {
      const lastAssistant = Date.now() - 30 * 60 * 1000;
      const session = makeSession({
        lastAssistantTimestamp: lastAssistant,
        lastWarmedAt: Date.now() - 60 * 1000,
      });
      const result = scheduler.bootstrap([session], 55);
      expect(result[0].nextWarmAt!).toBeLessThanOrEqual(lastAssistant + WARM_THRESHOLD_MS);
    });
  });

  describe('runDueWarmups', () => {
    it('returns warm patches for a session that is due and clamps nextWarmAt by the safety margin', async () => {
      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const patches = await scheduler.runDueWarmups([session], 'Reply with only the word OK', 55);

      expect(warmFn.calls[0].args).toEqual(['test-id', 'Reply with only the word OK', '/test', 'test-project']);
      expect(patches[0]).toMatchObject({ type: 'started', sessionId: 'test-id' });
      expect(patches[1]).toMatchObject({ type: 'succeeded', sessionId: 'test-id' });
      const success = patches[1];
      if (success.type !== 'succeeded') throw new Error('expected success patch');
      expect(success.warmedAt).toBeGreaterThan(0);
      const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
      expect(success.nextWarmAt).toBe(success.warmedAt + cap);
    });

    it('does not warm a session that is not yet due', async () => {
      const session = makeSession({ nextWarmAt: Date.now() + 60_000 });
      const patches = await scheduler.runDueWarmups([session], 'Reply with only the word OK', 55);
      expect(warmFn.calls.length).toBe(0);
      expect(patches).toEqual([]);
    });

    it('returns no patches when nothing was warmed', async () => {
      const sessions = [makeSession({ nextWarmAt: Date.now() + 60_000 })];
      const result = await scheduler.runDueWarmups(sessions, 'Reply OK', 55);
      expect(result).toEqual([]);
    });

    it('falls back to session model when result model is empty', async () => {
      const fn = stubWarmFn({
        sessionId: 'test-id',
        usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
        model: '',
        costUsd: 0.015,
        error: null,
      });
      const sched = new Scheduler(fn as unknown as WarmFnSig);
      const session = makeSession({ nextWarmAt: Date.now() - 1000, model: 'claude-sonnet-4-6' });
      const patches = await sched.runDueWarmups([session], 'Reply with only the word OK', 55);
      const success = patches.find((p) => p.type === 'succeeded');
      expect(success).toMatchObject({ type: 'succeeded', model: 'claude-sonnet-4-6' });
    });

    it('returns an error patch on warm failure and uses bounded retry backoff', async () => {
      const fn = stubWarmFn({
        sessionId: 'test-id',
        usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        model: '',
        costUsd: 0,
        error: 'CLI failed',
      });
      const sched = new Scheduler(fn as unknown as WarmFnSig);
      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const beforeTick = Date.now();
      const patches = await sched.runDueWarmups([session], 'Reply with only the word OK', 55);

      const error = patches.find((p) => p.type === 'failed');
      expect(error).toMatchObject({
        type: 'failed',
        error: 'CLI failed',
        consecutiveErrors: 1,
      });
      if (!error || error.type !== 'failed') throw new Error('expected failed patch');
      expect(error.nextWarmAt).toBeGreaterThanOrEqual(beforeTick + BACKOFF_SCHEDULE_MS[0]);
      expect(error.nextWarmAt).toBeLessThan(beforeTick + 60_000);
    });

    it('increments consecutiveErrors across repeated failures and resets on success', async () => {
      const errResult: WarmResult = {
        sessionId: 'test-id',
        usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        model: '',
        costUsd: 0,
        error: 'CLI failed',
      };
      const queue: WarmResult[] = [
        errResult,
        errResult,
        {
          sessionId: 'test-id',
          usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
          model: 'claude-sonnet-4-6',
          costUsd: 0.015,
          error: null,
        },
      ];
      const fn = spy(async (..._args: Parameters<WarmFnSig>) => {
        return await Promise.resolve(queue.shift()!);
      });
      const sched = new Scheduler(fn as unknown as WarmFnSig);

      let session = makeSession({ nextWarmAt: Date.now() - 1000 });

      const failed1 = (await sched.runDueWarmups([session], 'OK', 55)).find((p) => p.type === 'failed');
      expect(failed1).toMatchObject({ type: 'failed', consecutiveErrors: 1 });
      if (!failed1 || failed1.type !== 'failed') throw new Error('expected first failure');

      session = { ...session, consecutiveErrors: failed1.consecutiveErrors, nextWarmAt: Date.now() - 1000 };
      const failed2 = (await sched.runDueWarmups([session], 'OK', 55)).find((p) => p.type === 'failed');
      expect(failed2).toMatchObject({ type: 'failed', consecutiveErrors: 2 });
      if (!failed2 || failed2.type !== 'failed') throw new Error('expected second failure');

      session = { ...session, consecutiveErrors: failed2.consecutiveErrors, nextWarmAt: Date.now() - 1000 };
      const success = (await sched.runDueWarmups([session], 'OK', 55)).find((p) => p.type === 'succeeded');
      expect(success).toMatchObject({ type: 'succeeded' });
    });

    it('warms sessions sequentially, not in parallel', async () => {
      // Use real timers for this test so the awaited Promise resolves naturally
      // without depending on FakeTime advancement semantics.
      time.restore();
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      const fn = spy(async (..._args: Parameters<WarmFnSig>) => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await new Promise<void>((r) => setTimeout(r, 10));
        concurrentCalls--;
        return {
          sessionId: 'x',
          usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
          model: 'claude-sonnet-4-6',
          costUsd: 0.015,
          error: null,
        };
      });
      const sched = new Scheduler(fn as unknown as WarmFnSig);

      const sessions = [
        makeSession({ sessionId: 'a', nextWarmAt: Date.now() - 1000 }),
        makeSession({ sessionId: 'b', nextWarmAt: Date.now() - 500 }),
      ];

      await sched.runDueWarmups(sessions, 'OK', 55);
      expect(maxConcurrent).toBe(1);
      // re-install a fresh FakeTime for afterEach hygiene
      time = new FakeTime();
    });

    it('uses the interval passed to each run rather than constructor-owned interval state', async () => {
      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const patches = await scheduler.runDueWarmups([session], 'OK', 10);
      const success = patches.find((p) => p.type === 'succeeded');
      expect(success).toMatchObject({ type: 'succeeded' });
      if (!success || success.type !== 'succeeded') throw new Error('expected success patch');
      expect(success.nextWarmAt).toBe(success.warmedAt + 10 * 60 * 1000);
    });
  });

  describe('scheduleFirstWarm', () => {
    it('schedules a warm session within remaining window', () => {
      const session = makeSession({ nextWarmAt: null });
      const updated = scheduler.scheduleFirstWarm(session, 55);
      const windowEnd = session.lastAssistantTimestamp + WARM_THRESHOLD_MS;
      expect(updated.nextWarmAt!).toBeGreaterThanOrEqual(Date.now());
      expect(updated.nextWarmAt!).toBeLessThanOrEqual(windowEnd);
    });

    it('schedules a cold session immediately', () => {
      const session = makeSession({
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
        isWarm: false,
        nextWarmAt: null,
      });
      const updated = scheduler.scheduleFirstWarm(session, 55);
      expect(updated.nextWarmAt!).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('unscheduleWarm', () => {
    it('clears nextWarmAt', () => {
      const session = makeSession({ nextWarmAt: Date.now() + 60_000 });
      const updated = scheduler.unscheduleWarm(session);
      expect(updated.nextWarmAt).toBeNull();
    });
  });

  describe('stop', () => {
    it('clears the timer when one is set', () => {
      const timer = setInterval(() => {}, 1000);
      (scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = timer;

      scheduler.stop();

      expect((scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer).toBeNull();
    });

    it('is a no-op when no timer is set', () => {
      (scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;

      scheduler.stop();

      expect((scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer).toBeNull();
    });
  });
});

// Silence unused-import linting for stub helper imported alongside spy.
const _stubUnused = stub;
void _stubUnused;
