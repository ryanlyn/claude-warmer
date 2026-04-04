import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/lib/scheduler.js';
import type { Session, WarmResult } from '../../src/lib/types.js';
import { WARM_THRESHOLD_MS } from '../../src/lib/types.js';

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
    warmingStatus: 'idle',
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
    scheduler = new Scheduler(mockWarmFn, 55);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  describe('bootstrap', () => {
    it('schedules a warm session within its valid window', () => {
      const session = makeSession({ lastAssistantTimestamp: Date.now() - 10 * 60 * 1000 });
      const result = scheduler.bootstrap([session]);

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
      const result = scheduler.bootstrap([session]);

      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt!).toBeLessThanOrEqual(Date.now());
    });

    it('skips live sessions', () => {
      const session = makeSession({ isLive: true });
      const result = scheduler.bootstrap([session]);
      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt).toBeNull();
    });

    it('skips deselected sessions', () => {
      const session = makeSession({ selected: false });
      const result = scheduler.bootstrap([session]);
      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt).toBeNull();
    });
  });

  describe('tick', () => {
    it('warms a session that is due', async () => {
      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const updated = await scheduler.tick([session], 'Reply with only the word OK');

      expect(mockWarmFn).toHaveBeenCalledWith('test-id', 'Reply with only the word OK');
      expect(updated[0].warmCount).toBe(1);
      expect(updated[0].warmingStatus).toBe('success');
      expect(updated[0].lastWarmedAt).toBeGreaterThan(0);
      expect(updated[0].nextWarmAt).toBe(updated[0].lastWarmedAt! + 55 * 60 * 1000);
    });

    it('does not warm a session that is not yet due', async () => {
      const session = makeSession({ nextWarmAt: Date.now() + 60_000 });
      await scheduler.tick([session], 'Reply with only the word OK');
      expect(mockWarmFn).not.toHaveBeenCalled();
    });

    it('marks session as error on warm failure', async () => {
      mockWarmFn.mockResolvedValueOnce({
        sessionId: 'test-id',
        usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        model: '',
        costUsd: 0,
        error: 'CLI failed',
      });

      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const updated = await scheduler.tick([session], 'Reply with only the word OK');

      expect(updated[0].warmingStatus).toBe('error');
      expect(updated[0].lastWarmError).toBe('CLI failed');
      // Should still schedule next attempt
      expect(updated[0].nextWarmAt).toBeGreaterThan(Date.now());
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

      const tickPromise = scheduler.tick(sessions, 'OK');
      await vi.advanceTimersByTimeAsync(100);
      await tickPromise;
      expect(maxConcurrent).toBe(1);
    });
  });

  describe('addSession', () => {
    it('schedules a warm session within remaining window', () => {
      const session = makeSession({ nextWarmAt: null });
      const updated = scheduler.addSession(session);
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
      const updated = scheduler.addSession(session);
      expect(updated.nextWarmAt!).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('removeSession', () => {
    it('clears nextWarmAt', () => {
      const session = makeSession({ nextWarmAt: Date.now() + 60_000 });
      const updated = scheduler.removeSession(session);
      expect(updated.nextWarmAt).toBeNull();
    });
  });
});
