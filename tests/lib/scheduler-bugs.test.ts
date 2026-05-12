/**
 * Reproducer tests for hypothesized cache-expiry bugs in the scheduler.
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { spy, stub } from '@std/testing/mock';
import { FakeTime } from '@std/testing/time';
import { Scheduler } from '../../src/lib/scheduler.ts';
import type { Session, WarmResult } from '../../src/lib/types.ts';
import { BACKOFF_SCHEDULE_MS, SAFETY_MARGIN_MS, WARM_THRESHOLD_MS } from '../../src/lib/types.ts';

type WarmFnSig = (sessionId: string, prompt: string, cwd?: string, projectDir?: string) => Promise<WarmResult>;

const CACHE_TTL_MS = 60 * 60 * 1000;

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
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });

  afterEach(() => {
    time.restore();
  });

  it('B4: sequential tick keeps every session within the 60min cache TTL after the safety-margin clamp', async () => {
    // Drive a virtual clock by hand instead of actually advancing time — the
    // scheduler reads clock.now() on each iteration, so we can simulate an
    // 80-second warm by bumping the clock before warmFn resolves.
    time.restore();
    const anchor = Date.now();
    const WARM_DURATION_MS = 80_000;
    const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;

    let virtualNow = anchor;
    const clock = {
      now: () => virtualNow,
      setInterval: globalThis.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout as unknown as typeof globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };

    const startTimes: number[] = [];
    const warmFn = spy((sessionId: string) => {
      startTimes.push(virtualNow);
      virtualNow += WARM_DURATION_MS;
      return Promise.resolve(okResult(sessionId));
    });
    const scheduler = new Scheduler(warmFn as unknown as WarmFnSig, Math.random, clock);

    const sessions: Session[] = Array.from({ length: 5 }, (_, i) =>
      makeSession({
        sessionId: `s${i}`,
        lastAssistantTimestamp: anchor - cap,
        lastWarmedAt: anchor - cap,
        nextWarmAt: anchor,
      }));

    await scheduler.runDueWarmups(sessions, 'Reply ok', 55);

    expect(warmFn.calls.length).toBe(5);
    const cacheExpiresAt = anchor - cap + CACHE_TTL_MS;
    const startOfFifthWarm = startTimes[4];
    expect(startOfFifthWarm).toBeLessThanOrEqual(cacheExpiresAt);
    expect(cacheExpiresAt - startOfFifthWarm).toBeGreaterThan(0);

    // Re-install FakeTime for afterEach hygiene.
    time = new FakeTime();
  });

  it('H3: bootstrap nextWarmAt never overshoots 60min TTL alone', () => {
    const anchor = Date.now() - 10 * 60 * 1000;
    const randStub = stub(Math, 'random', () => 0.999999);

    try {
      const scheduler = new Scheduler(spy(() => Promise.resolve(okResult('x'))) as unknown as WarmFnSig);
      const session = makeSession({ lastAssistantTimestamp: anchor });
      const [bootstrapped] = scheduler.bootstrap([session], 55);

      const cacheExpiresAt = anchor + CACHE_TTL_MS;
      const warmWindowEnd = anchor + WARM_THRESHOLD_MS;

      expect(bootstrapped.nextWarmAt!).toBeLessThanOrEqual(warmWindowEnd);
      const worstCaseArrival = bootstrapped.nextWarmAt! + 30_000 + 120_000;
      expect(worstCaseArrival).toBeLessThan(cacheExpiresAt);
    } finally {
      randStub.restore();
    }
  });

  it('B5: error path retries on the bounded backoff well within 60min cache TTL', async () => {
    time.restore();
    const anchor = Date.now();
    let virtualNow = anchor;
    const clock = {
      now: () => virtualNow,
      setInterval: globalThis.setInterval as unknown as typeof globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout as unknown as typeof globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };

    const warmFn = spy(() => {
      virtualNow += 10_000;
      return Promise.resolve({
        sessionId: 's0',
        usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        model: '',
        costUsd: 0,
        error: 'pty spawn failed',
      });
    });
    const scheduler = new Scheduler(warmFn as unknown as WarmFnSig, Math.random, clock);

    const lastSuccessfulWarm = anchor - 10 * 60 * 1000;
    const cacheExpiresAt = lastSuccessfulWarm + CACHE_TTL_MS;

    const session = makeSession({
      sessionId: 's0',
      lastAssistantTimestamp: lastSuccessfulWarm,
      lastWarmedAt: lastSuccessfulWarm,
      nextWarmAt: anchor,
    });

    const patches = await scheduler.runDueWarmups([session], 'Reply ok', 55);
    const failed = patches.find((p) => p.type === 'failed');

    expect(failed).toMatchObject({ type: 'failed', consecutiveErrors: 1 });
    if (!failed || failed.type !== 'failed') throw new Error('expected failed patch');

    const retryAt = failed.nextWarmAt;
    const expectedRetry = anchor + 10_000 + BACKOFF_SCHEDULE_MS[0];
    expect(retryAt).toBe(expectedRetry);
    expect(retryAt).toBeLessThan(cacheExpiresAt);

    time = new FakeTime();
  });
});
