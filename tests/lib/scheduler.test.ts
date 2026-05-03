import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/lib/scheduler.js';
import type { Session, WarmResult } from '../../src/lib/types.js';
import { WARM_THRESHOLD_MS, SAFETY_MARGIN_MS, BACKOFF_SCHEDULE_MS } from '../../src/lib/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'test-id',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-sonnet-4-6',
    lastAssistantTimestamp: Date.now() - 10 * 60 * 1000, // 10 min ago
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

describe('Scheduler', () => {
  let mockWarmFn: ReturnType<typeof vi.fn>;
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWarmFn = vi.fn<(sessionId: string, prompt: string) => Promise<WarmResult>>().mockResolvedValue({
      sessionId: 'test-id',
      usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
      model: 'claude-sonnet-4-6',
      costUsd: 0.015,
      error: null,
    });
    scheduler = new Scheduler(mockWarmFn);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
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
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
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
      // A prior warm has already happened, but first-warm scheduling must
      // anchor on the session's last user/assistant interaction. Construct
      // a session where the two anchors would produce different upper bounds.
      const lastAssistant = Date.now() - 30 * 60 * 1000;
      const session = makeSession({
        lastAssistantTimestamp: lastAssistant,
        lastWarmedAt: Date.now() - 60 * 1000,
      });
      const result = scheduler.bootstrap([session], 55);
      // Upper bound proves the anchor: capped at lastAssistant + WARM_THRESHOLD_MS,
      // not lastWarmedAt + WARM_THRESHOLD_MS (which would extend ~29min later).
      expect(result[0].nextWarmAt!).toBeLessThanOrEqual(lastAssistant + WARM_THRESHOLD_MS);
    });
  });

  describe('runDueWarmups', () => {
    it('returns warm patches for a session that is due and clamps nextWarmAt by the safety margin', async () => {
      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const patches = await scheduler.runDueWarmups([session], 'Reply with only the word OK', 55);

      expect(mockWarmFn).toHaveBeenCalledWith('test-id', 'Reply with only the word OK', '/test', 'test-project');
      expect(patches[0]).toMatchObject({ type: 'started', sessionId: 'test-id' });
      expect(patches[1]).toMatchObject({ type: 'succeeded', sessionId: 'test-id' });
      const success = patches[1];
      expect(success.type).toBe('succeeded');
      if (success.type !== 'succeeded') throw new Error('expected success patch');
      expect(success.warmedAt).toBeGreaterThan(0);
      // Scheduler was constructed with intervalMinutes=55 == WARM_THRESHOLD_MS,
      // which exceeds the (WARM_THRESHOLD_MS - SAFETY_MARGIN_MS) cap, so the
      // next warm is clamped to that cap rather than the literal 55min.
      const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
      expect(success.nextWarmAt).toBe(success.warmedAt + cap);
    });

    it('does not warm a session that is not yet due', async () => {
      const session = makeSession({ nextWarmAt: Date.now() + 60_000 });
      const patches = await scheduler.runDueWarmups([session], 'Reply with only the word OK', 55);
      expect(mockWarmFn).not.toHaveBeenCalled();
      expect(patches).toEqual([]);
    });

    it('returns no patches when nothing was warmed', async () => {
      const sessions = [makeSession({ nextWarmAt: Date.now() + 60_000 })];
      const result = await scheduler.runDueWarmups(sessions, 'Reply OK', 55);
      expect(result).toEqual([]);
    });

    it('falls back to session model when result model is empty', async () => {
      mockWarmFn.mockResolvedValueOnce({
        sessionId: 'test-id',
        usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
        model: '',
        costUsd: 0.015,
        error: null,
      });

      const session = makeSession({ nextWarmAt: Date.now() - 1000, model: 'claude-sonnet-4-6' });
      const patches = await scheduler.runDueWarmups([session], 'Reply with only the word OK', 55);

      const success = patches.find((p) => p.type === 'succeeded');
      expect(success).toMatchObject({ type: 'succeeded', model: 'claude-sonnet-4-6' });
    });

    it('returns an error patch on warm failure and uses bounded retry backoff', async () => {
      mockWarmFn.mockResolvedValueOnce({
        sessionId: 'test-id',
        usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        model: '',
        costUsd: 0,
        error: 'CLI failed',
      });

      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const beforeTick = Date.now();
      const patches = await scheduler.runDueWarmups([session], 'Reply with only the word OK', 55);

      const error = patches.find((p) => p.type === 'failed');
      expect(error).toMatchObject({
        type: 'failed',
        error: 'CLI failed',
        consecutiveErrors: 1,
      });
      if (!error || error.type !== 'failed') throw new Error('expected failed patch');
      // First-failure retry should land at warmTime + BACKOFF_SCHEDULE_MS[0]
      // (30s), NOT warmTime + intervalMs (55min).
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
      mockWarmFn
        .mockResolvedValueOnce(errResult)
        .mockResolvedValueOnce(errResult)
        .mockResolvedValueOnce({
          sessionId: 'test-id',
          usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
          model: 'claude-sonnet-4-6',
          costUsd: 0.015,
          error: null,
        });

      let session = makeSession({ nextWarmAt: Date.now() - 1000 });

      const failed1 = (await scheduler.runDueWarmups([session], 'OK', 55)).find((p) => p.type === 'failed');
      expect(failed1).toMatchObject({ type: 'failed', consecutiveErrors: 1 });
      if (!failed1 || failed1.type !== 'failed') throw new Error('expected first failure');

      session = { ...session, consecutiveErrors: failed1.consecutiveErrors, nextWarmAt: Date.now() - 1000 };
      const failed2 = (await scheduler.runDueWarmups([session], 'OK', 55)).find((p) => p.type === 'failed');
      expect(failed2).toMatchObject({ type: 'failed', consecutiveErrors: 2 });
      if (!failed2 || failed2.type !== 'failed') throw new Error('expected second failure');

      session = { ...session, consecutiveErrors: failed2.consecutiveErrors, nextWarmAt: Date.now() - 1000 };
      const success = (await scheduler.runDueWarmups([session], 'OK', 55)).find((p) => p.type === 'succeeded');
      expect(success).toMatchObject({ type: 'succeeded' });
    });

    it('warms sessions sequentially, not in parallel', async () => {
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      mockWarmFn.mockImplementation(async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await new Promise((r) => setTimeout(r, 10));
        concurrentCalls--;
        return {
          sessionId: 'x',
          usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
          model: 'claude-sonnet-4-6',
          costUsd: 0.015,
          error: null,
        };
      });

      const sessions = [
        makeSession({ sessionId: 'a', nextWarmAt: Date.now() - 1000 }),
        makeSession({ sessionId: 'b', nextWarmAt: Date.now() - 500 }),
      ];

      const tickPromise = scheduler.runDueWarmups(sessions, 'OK', 55);
      await vi.advanceTimersByTimeAsync(100);
      await tickPromise;
      expect(maxConcurrent).toBe(1);
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
      // Set a timer on the scheduler by accessing its private field
      const timer = setInterval(() => {}, 1000);
      (scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = timer;

      scheduler.stop();

      expect((scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer).toBeNull();
    });

    it('is a no-op when no timer is set', () => {
      // Ensure timer is null
      (scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;

      // Should not throw
      scheduler.stop();

      expect((scheduler as unknown as { timer: ReturnType<typeof setInterval> | null }).timer).toBeNull();
    });
  });
});
