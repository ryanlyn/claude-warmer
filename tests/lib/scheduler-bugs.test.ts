/**
 * Reproducer tests for hypothesized cache-expiry bugs in the scheduler.
 *
 * Background: session fd23508e saw two assistant turns 10.9h apart with
 * cache_read=0 and cache_creation~38K on both. If the warmer was active,
 * at least the second turn should have shown a cache read. These tests
 * stress-test scheduling edge cases that could explain that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/lib/scheduler.js';
import type { Session, WarmResult } from '../../src/lib/types.js';
import { WARM_THRESHOLD_MS, SAFETY_MARGIN_MS, BACKOFF_SCHEDULE_MS } from '../../src/lib/types.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // Anthropic 1-hour prompt cache TTL

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
    warmingStatus: 'idle',
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
    ...overrides,
  };
}

function okResult(sessionId: string): WarmResult {
  return {
    sessionId,
    usage: { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0, outputTokens: 3 },
    model: 'claude-sonnet-4-6',
    costUsd: 0.015,
    error: null,
  };
}

describe('Scheduler bug reproducers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * B4 (formerly H1): with the SAFETY_MARGIN_MS clamp on `nextAfterSuccess`,
   * back-to-back warms in a single `tick` should always finish before the
   * cache TTL expires for any session, even at realistic warm durations
   * (~80s) and the worst case where all sessions are due at the same instant.
   *
   * Setup: previous successful warms scheduled `nextWarmAt = warmTime + cap`
   * where `cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS = 50min`. So the
   * cache anchor sits at `anchor - 50min` and the TTL expires 10min from
   * `anchor`. With 5 sessions @ 80s, session #5 starts ~5.3min in, well
   * within the 10min headroom.
   */
  it('B4: sequential tick keeps every session within the 60min cache TTL after the safety-margin clamp', async () => {
    const anchor = Date.now();
    const WARM_DURATION_MS = 80_000;
    const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;

    const startTimes: number[] = [];
    const warmFn = vi.fn<(sessionId: string) => Promise<WarmResult>>().mockImplementation(async (sessionId) => {
      startTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, WARM_DURATION_MS));
      return okResult(sessionId);
    });
    const scheduler = new Scheduler(warmFn as unknown as Parameters<typeof Scheduler>[0], 55);

    // After the previous tick's successful warm, nextWarmAt was clamped to
    // warmTime + cap. So the cache anchor for each session sits `cap` ago.
    const sessions: Session[] = Array.from({ length: 5 }, (_, i) =>
      makeSession({
        sessionId: `s${i}`,
        lastAssistantTimestamp: anchor - cap,
        lastWarmedAt: anchor - cap,
        nextWarmAt: anchor,
      }),
    );

    const tickPromise = scheduler.tick(sessions, 'Reply ok');
    await vi.advanceTimersByTimeAsync(WARM_DURATION_MS * 5 + 100);
    await tickPromise;

    expect(warmFn).toHaveBeenCalledTimes(5);
    // Cache TTL for each session is anchor - cap + 60min == anchor + (60min - cap).
    const cacheExpiresAt = anchor - cap + CACHE_TTL_MS;
    const startOfFifthWarm = startTimes[4];
    expect(startOfFifthWarm).toBeLessThanOrEqual(cacheExpiresAt);
    expect(cacheExpiresAt - startOfFifthWarm).toBeGreaterThan(0);
  });

  /**
   * H3: computeFirstWarmTime picks a uniform-random point in
   * [now, anchor + 55min]. When combined with tick-loop jitter (up to 30s)
   * and warmSession runtime (up to ~120s), the effective warm-arrival
   * time at the API is [anchor+55min+30s, anchor+57min], which is still
   * inside the 60-min TTL. Verify this bound deterministically.
   */
  it('H3: bootstrap random window never overshoots 60min TTL alone', () => {
    const anchor = Date.now() - 10 * 60 * 1000;
    // Force Math.random to the worst-case (1.0) to pick the very end of window
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);

    const scheduler = new Scheduler(vi.fn() as unknown as Parameters<typeof Scheduler>[0], 55);
    const session = makeSession({ lastAssistantTimestamp: anchor });
    const [bootstrapped] = scheduler.bootstrap([session]);

    const cacheExpiresAt = anchor + CACHE_TTL_MS;
    const warmWindowEnd = anchor + WARM_THRESHOLD_MS; // 55min

    expect(bootstrapped.nextWarmAt!).toBeLessThanOrEqual(warmWindowEnd);
    // Even with tick jitter (30s) + warmSession (120s) we stay under TTL
    const worstCaseArrival = bootstrapped.nextWarmAt! + 30_000 + 120_000;
    expect(worstCaseArrival).toBeLessThan(cacheExpiresAt);
    randSpy.mockRestore();
  });

  /**
   * B5 (formerly H4): on a transient error, the next attempt should fire on
   * the bounded backoff schedule (BACKOFF_SCHEDULE_MS[0] == 30s on the
   * first failure), NOT a full intervalMs later. This keeps the retry
   * comfortably inside the 60-min cache TTL.
   */
  it('B5: error path retries on the bounded backoff well within 60min cache TTL', async () => {
    const anchor = Date.now();

    const warmFn = vi.fn<(sessionId: string) => Promise<WarmResult>>().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10_000));
      return {
        sessionId: 's0',
        usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        model: '',
        costUsd: 0,
        error: 'pty spawn failed',
      };
    });
    const scheduler = new Scheduler(warmFn as unknown as Parameters<typeof Scheduler>[0], 55);

    const lastSuccessfulWarm = anchor - 10 * 60 * 1000;
    const cacheExpiresAt = lastSuccessfulWarm + CACHE_TTL_MS;

    const session = makeSession({
      sessionId: 's0',
      lastAssistantTimestamp: lastSuccessfulWarm,
      lastWarmedAt: lastSuccessfulWarm,
      nextWarmAt: anchor,
    });

    const tickPromise = scheduler.tick([session], 'Reply ok');
    await vi.advanceTimersByTimeAsync(10_100);
    const [updated] = await tickPromise;

    expect(updated.warmingStatus).toBe('error');
    expect(updated.consecutiveErrors).toBe(1);

    // warmTime ~= anchor + 10s, retry at warmTime + BACKOFF_SCHEDULE_MS[0] (30s).
    const retryAt = updated.nextWarmAt!;
    const expectedRetry = anchor + 10_000 + BACKOFF_SCHEDULE_MS[0];
    expect(retryAt).toBe(expectedRetry);
    // Comfortably inside the cache TTL.
    expect(retryAt).toBeLessThan(cacheExpiresAt);
  });
});
