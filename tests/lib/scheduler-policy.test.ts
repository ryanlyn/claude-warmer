import { describe, it, expect } from 'vitest';
import { nextFirstWarm, nextAfterSuccess, nextAfterError } from '../../src/lib/scheduler-policy.js';
import { WARM_THRESHOLD_MS, SAFETY_MARGIN_MS, BACKOFF_SCHEDULE_MS } from '../../src/lib/types.js';
import type { Session } from '../../src/lib/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'test-id',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-sonnet-4-6',
    lastAssistantTimestamp: 0,
    isWarm: false,
    isLive: false,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    expiryCostUsd: 0,
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

// Deterministic RNG factory for property-style tests: returns the supplied
// sequence, then cycles. Keeps assertions about randomness reproducible
// without actually depending on Math.random.
function seededRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

// 55min default interval — matches the WARM_THRESHOLD_MS so the cap is the
// cache TTL window in nearly every test below.
const DEFAULT_INTERVAL_MS = 55 * 60_000;

describe('scheduler-policy', () => {
  describe('nextFirstWarm', () => {
    it('returns `now` when the cache window has already expired (cold)', () => {
      const now = 10_000_000;
      const session = makeSession({ lastAssistantTimestamp: now - 2 * WARM_THRESHOLD_MS });
      expect(nextFirstWarm(session, now, () => 0.5, DEFAULT_INTERVAL_MS)).toBe(now);
    });

    it('returns `now` exactly when anchor + WARM_THRESHOLD_MS === now (boundary)', () => {
      const now = 10_000_000;
      const session = makeSession({ lastAssistantTimestamp: now - WARM_THRESHOLD_MS });
      expect(nextFirstWarm(session, now, () => 0.999, DEFAULT_INTERVAL_MS)).toBe(now);
    });

    it('returns `now` when rng=0 and session is warm (earliest point in window)', () => {
      const now = 10_000_000;
      const session = makeSession({ lastAssistantTimestamp: now - 5 * 60_000 });
      expect(nextFirstWarm(session, now, () => 0, DEFAULT_INTERVAL_MS)).toBe(now);
    });

    it('approaches but never reaches windowEnd when rng=1 (half-open interval)', () => {
      const now = 10_000_000;
      const anchor = now - 5 * 60_000;
      const windowEnd = anchor + WARM_THRESHOLD_MS;
      const session = makeSession({ lastAssistantTimestamp: anchor });
      // Math.floor of (remaining * 0.9999) stays strictly below remaining.
      const result = nextFirstWarm(session, now, () => 0.9999, DEFAULT_INTERVAL_MS);
      expect(result).toBeLessThan(windowEnd);
      expect(result).toBeGreaterThan(now);
    });

    it('caps the random window at intervalMs so a short --interval is honored', () => {
      // Session is warm with ~50min of cache window remaining; user picked
      // --interval 1 (60s). With rng=1, the random point should land in
      // [now, now+60s), NOT [now, now+50min).
      const now = 10_000_000;
      const session = makeSession({ lastAssistantTimestamp: now - 5 * 60_000 });
      const result = nextFirstWarm(session, now, () => 0.9999, 60_000);
      expect(result).toBeGreaterThan(now);
      expect(result).toBeLessThan(now + 60_000);
    });

    it('uses windowEnd when intervalMs would push the random window past the cache TTL', () => {
      // 50min into the window only ~5min remain; the user-chosen 55min
      // interval would push past, so windowEnd dominates.
      const now = 10_000_000;
      const session = makeSession({ lastAssistantTimestamp: now - 50 * 60_000 });
      const windowEnd = session.lastAssistantTimestamp + WARM_THRESHOLD_MS;
      const result = nextFirstWarm(session, now, () => 0.9999, DEFAULT_INTERVAL_MS);
      expect(result).toBeGreaterThan(now);
      expect(result).toBeLessThan(windowEnd);
    });

    it('prefers lastWarmedAt over lastAssistantTimestamp when present', () => {
      const now = 10_000_000;
      const session = makeSession({
        lastAssistantTimestamp: now - 2 * WARM_THRESHOLD_MS,
        lastWarmedAt: now - 60_000,
      });
      const result = nextFirstWarm(session, now, () => 0.5, DEFAULT_INTERVAL_MS);
      expect(result).toBeGreaterThan(now);
      expect(result).toBeLessThanOrEqual(session.lastWarmedAt! + WARM_THRESHOLD_MS);
    });

    it('property: result is always in [now, min(windowEnd, now+intervalMs)] for random rng samples', () => {
      const now = 10_000_000;
      const offsetsMs = [0, 1_000, 60_000, 30 * 60_000, WARM_THRESHOLD_MS - 1];
      const intervalSamples = [60_000, 5 * 60_000, DEFAULT_INTERVAL_MS];
      const rngSamples = [0, 0.0001, 0.25, 0.5, 0.75, 0.9999];
      for (const offset of offsetsMs) {
        const session = makeSession({ lastAssistantTimestamp: now - offset });
        const windowEnd = session.lastAssistantTimestamp + WARM_THRESHOLD_MS;
        for (const intervalMs of intervalSamples) {
          const upperBound = Math.min(windowEnd, now + intervalMs);
          for (const r of rngSamples) {
            const result = nextFirstWarm(session, now, () => r, intervalMs);
            expect(result).toBeGreaterThanOrEqual(now);
            expect(result).toBeLessThanOrEqual(upperBound);
          }
        }
      }
    });

    it('deterministic: identical (session, now, seeded rng, intervalMs) yields identical output', () => {
      const now = 10_000_000;
      const session = makeSession({ lastAssistantTimestamp: now - 5 * 60_000 });
      const a = nextFirstWarm(session, now, seededRng([0.3, 0.7]), DEFAULT_INTERVAL_MS);
      const b = nextFirstWarm(session, now, seededRng([0.3, 0.7]), DEFAULT_INTERVAL_MS);
      expect(a).toBe(b);
    });

    it('treats a non-positive intervalMs as 0 (defensive: returns now)', () => {
      const now = 10_000_000;
      const session = makeSession({ lastAssistantTimestamp: now - 5 * 60_000 });
      expect(nextFirstWarm(session, now, () => 0.9999, 0)).toBe(now);
      expect(nextFirstWarm(session, now, () => 0.9999, -1000)).toBe(now);
    });
  });

  describe('nextAfterSuccess', () => {
    it('returns warmTime + intervalMs when interval is below the safety cap', () => {
      // 1-min interval is well below the cap, so no clamp.
      const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
      const intervalMs = 60_000;
      expect(intervalMs).toBeLessThan(cap);
      expect(nextAfterSuccess(1000, intervalMs)).toBe(1000 + intervalMs);
    });

    it('clamps the interval to (WARM_THRESHOLD_MS - SAFETY_MARGIN_MS) when larger', () => {
      // Default 55min interval == WARM_THRESHOLD_MS, which is above the cap
      // and so MUST be clamped down to leave headroom for the next TTL.
      const warmTime = 10_000_000;
      const intervalMs = WARM_THRESHOLD_MS;
      const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
      expect(nextAfterSuccess(warmTime, intervalMs)).toBe(warmTime + cap);
    });

    it('returns warmTime + cap exactly at the threshold (boundary)', () => {
      const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
      expect(nextAfterSuccess(0, cap)).toBe(cap);
    });
  });

  describe('nextAfterError', () => {
    it('uses the first backoff slot for the first failure (consecutiveErrors=0)', () => {
      const warmTime = 10_000_000;
      const intervalMs = 55 * 60_000;
      expect(nextAfterError(warmTime, intervalMs, 0)).toBe(warmTime + BACKOFF_SCHEDULE_MS[0]);
    });

    it('walks the backoff schedule for attempts 1, 2, 3', () => {
      const warmTime = 10_000_000;
      const intervalMs = 55 * 60_000;
      expect(nextAfterError(warmTime, intervalMs, 1)).toBe(warmTime + BACKOFF_SCHEDULE_MS[1]);
      expect(nextAfterError(warmTime, intervalMs, 2)).toBe(warmTime + BACKOFF_SCHEDULE_MS[2]);
      expect(nextAfterError(warmTime, intervalMs, 3)).toBe(warmTime + BACKOFF_SCHEDULE_MS[3]);
    });

    it('saturates at the last backoff slot for attempts past the schedule end', () => {
      const warmTime = 10_000_000;
      const intervalMs = 55 * 60_000;
      const last = BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
      expect(nextAfterError(warmTime, intervalMs, 99)).toBe(warmTime + last);
    });

    it('caps the backoff by intervalMs when the user picked a very short interval', () => {
      // 10s interval is shorter than every backoff slot, so the result
      // should be warmTime + 10s no matter the attempt count.
      const warmTime = 10_000_000;
      const intervalMs = 10_000;
      expect(nextAfterError(warmTime, intervalMs, 0)).toBe(warmTime + intervalMs);
      expect(nextAfterError(warmTime, intervalMs, 3)).toBe(warmTime + intervalMs);
    });

    it('treats negative consecutiveErrors as 0 (defensive clamp)', () => {
      const warmTime = 10_000_000;
      const intervalMs = 55 * 60_000;
      expect(nextAfterError(warmTime, intervalMs, -5)).toBe(warmTime + BACKOFF_SCHEDULE_MS[0]);
    });
  });
});
