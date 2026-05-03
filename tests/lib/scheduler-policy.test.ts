import { describe, it, expect } from 'vitest';
import { nextWarm, nextAfterError } from '../../src/lib/scheduler-policy.js';
import { WARM_THRESHOLD_MS, SAFETY_MARGIN_MS, FIRST_WARM_JITTER_MS, BACKOFF_SCHEDULE_MS } from '../../src/lib/types.js';

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

// 55min default interval - matches the WARM_THRESHOLD_MS so the cap is the
// cache TTL window in nearly every test below.
const DEFAULT_INTERVAL_MS = 55 * 60_000;
const CAP = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;

// Convenience for the first-warm call shape: anchored on a session's last
// interaction time, with ±FIRST_WARM_JITTER_MS jitter and a `now` floor.
function firstWarm(anchor: number, now: number, rng: () => number, intervalMs: number): number {
  return nextWarm(anchor, intervalMs, {
    jitter: { rng, magnitudeMs: FIRST_WARM_JITTER_MS },
    now,
  });
}

describe('scheduler-policy', () => {
  describe('nextWarm (first-warm path: jitter + now floor)', () => {
    it('returns `now` when the cache window has already expired (cold)', () => {
      const now = 10_000_000;
      const anchor = now - 2 * WARM_THRESHOLD_MS;
      expect(firstWarm(anchor, now, () => 0.5, DEFAULT_INTERVAL_MS)).toBe(now);
    });

    it('returns `now` exactly when anchor + WARM_THRESHOLD_MS === now (boundary)', () => {
      const now = 10_000_000;
      const anchor = now - WARM_THRESHOLD_MS;
      expect(firstWarm(anchor, now, () => 0.999, DEFAULT_INTERVAL_MS)).toBe(now);
    });

    it('mirrors the success path (anchor + min(intervalMs, cap)) when rng=0.5 produces zero jitter', () => {
      // rng=0.5 means jitter == 0, so the result is exactly the deterministic base.
      const now = 10_000_000;
      const anchor = now - 5 * 60_000;
      const result = firstWarm(anchor, now, () => 0.5, DEFAULT_INTERVAL_MS);
      expect(result).toBe(anchor + Math.min(DEFAULT_INTERVAL_MS, CAP));
    });

    it('subtracts up to FIRST_WARM_JITTER_MS when rng=0 (lower jitter bound)', () => {
      const now = 10_000_000;
      const anchor = now - 5 * 60_000;
      const result = firstWarm(anchor, now, () => 0, DEFAULT_INTERVAL_MS);
      const base = anchor + Math.min(DEFAULT_INTERVAL_MS, CAP);
      // rng=0 ⇒ jitter = -FIRST_WARM_JITTER_MS exactly.
      expect(result).toBe(base - FIRST_WARM_JITTER_MS);
    });

    it('caps at anchor + WARM_THRESHOLD_MS so positive jitter never crosses the cache TTL', () => {
      const now = 10_000_000;
      const anchor = now - 5 * 60_000;
      // rng→1 would push the result above the TTL without the upper clamp.
      const result = firstWarm(anchor, now, () => 0.9999, DEFAULT_INTERVAL_MS);
      expect(result).toBeLessThanOrEqual(anchor + WARM_THRESHOLD_MS);
    });

    it('honors a short --interval rather than waiting near the cache TTL boundary', () => {
      // Session was just used; user picked --interval 1 (60s). The base
      // time should be anchor + 60s (no cap applies), zero jitter at rng=0.5.
      const now = 10_000_000;
      const anchor = now;
      const result = firstWarm(anchor, now, () => 0.5, 60_000);
      expect(result).toBe(anchor + 60_000);
    });

    it('property: result is always in [now, anchor + WARM_THRESHOLD_MS] for random rng samples', () => {
      const now = 10_000_000;
      const offsetsMs = [0, 1_000, 60_000, 30 * 60_000, WARM_THRESHOLD_MS - 1];
      const intervalSamples = [60_000, 5 * 60_000, DEFAULT_INTERVAL_MS];
      const rngSamples = [0, 0.0001, 0.25, 0.5, 0.75, 0.9999];
      for (const offset of offsetsMs) {
        const anchor = now - offset;
        const ttl = anchor + WARM_THRESHOLD_MS;
        for (const intervalMs of intervalSamples) {
          for (const r of rngSamples) {
            const result = firstWarm(anchor, now, () => r, intervalMs);
            expect(result).toBeGreaterThanOrEqual(now);
            expect(result).toBeLessThanOrEqual(ttl);
          }
        }
      }
    });

    it('deterministic: identical inputs with a seeded rng yield identical output', () => {
      const now = 10_000_000;
      const anchor = now - 5 * 60_000;
      const a = firstWarm(anchor, now, seededRng([0.3, 0.7]), DEFAULT_INTERVAL_MS);
      const b = firstWarm(anchor, now, seededRng([0.3, 0.7]), DEFAULT_INTERVAL_MS);
      expect(a).toBe(b);
    });

    it('treats a non-positive intervalMs as 0', () => {
      // intervalMs<=0 ⇒ base == anchor; for an old anchor the floor at `now` wins.
      const now = 10_000_000;
      const anchor = now - 5 * 60_000;
      expect(firstWarm(anchor, now, () => 0.5, 0)).toBe(now);
      expect(firstWarm(anchor, now, () => 0.5, -1000)).toBe(now);
    });
  });

  describe('nextWarm (post-success path: no jitter, no floor)', () => {
    it('returns warmTime + intervalMs when interval is below the safety cap', () => {
      // 1-min interval is well below the cap, so no clamp.
      const intervalMs = 60_000;
      expect(intervalMs).toBeLessThan(CAP);
      expect(nextWarm(1000, intervalMs)).toBe(1000 + intervalMs);
    });

    it('clamps the interval to (WARM_THRESHOLD_MS - SAFETY_MARGIN_MS) when larger', () => {
      // Default 55min interval == WARM_THRESHOLD_MS, which is above the cap
      // and so MUST be clamped down to leave headroom for the next TTL.
      const warmTime = 10_000_000;
      expect(nextWarm(warmTime, WARM_THRESHOLD_MS)).toBe(warmTime + CAP);
    });

    it('returns warmTime + cap exactly at the threshold (boundary)', () => {
      expect(nextWarm(0, CAP)).toBe(CAP);
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
