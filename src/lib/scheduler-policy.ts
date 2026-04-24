import type { Session } from './types.js';
import { WARM_THRESHOLD_MS, SAFETY_MARGIN_MS, BACKOFF_SCHEDULE_MS } from './types.js';

// Pure scheduling policy. Side-effect-free so the arithmetic can be tested
// without fake timers or mocked warmers, and so alternative policies (e.g.
// bounded retry backoff) can be swapped in without touching orchestration.

// Schedule the first warm for a selected session.
//
// Cold sessions (cache window already lapsed) fire immediately. Warm sessions
// pick a random point in `[now, upperBound)` where the upper bound is the
// nearer of (a) the cache-anchor TTL boundary and (b) one user-chosen
// `intervalMs` from now. The intervalMs cap matters when the user picks a
// short interval (e.g. `-i 1`) to validate the warmer end-to-end against an
// already-warm session — without it the first warm could fire up to 55min
// later, regardless of what `--interval` says, because the cache TTL window
// dominates.
export function nextFirstWarm(
  session: Session,
  now: number,
  rng: () => number,
  intervalMs: number,
): number {
  const anchor = session.lastWarmedAt ?? session.lastAssistantTimestamp;
  const windowEnd = anchor + WARM_THRESHOLD_MS;

  if (windowEnd <= now) {
    return now;
  }

  const intervalBound = now + Math.max(intervalMs, 0);
  const upperBound = Math.min(windowEnd, intervalBound);
  if (upperBound <= now) return now;
  const remaining = upperBound - now;
  return now + Math.floor(rng() * remaining);
}

// Clamp the user-chosen interval against `WARM_THRESHOLD_MS - SAFETY_MARGIN_MS`
// so the next warm always has headroom against the 60-min cache TTL even when
// many sessions are warmed sequentially in the same tick.
export function nextAfterSuccess(warmTime: number, intervalMs: number): number {
  const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
  return warmTime + Math.min(intervalMs, cap);
}

// Bounded retry backoff: retry quickly on transient errors so the cache
// window isn't lost, but back off on repeated failures to avoid hammering a
// permanently-broken session. Capped by `intervalMs` so user-chosen
// sub-backoff intervals still win.
export function nextAfterError(warmTime: number, intervalMs: number, consecutiveErrors: number): number {
  const idx = Math.min(Math.max(consecutiveErrors, 0), BACKOFF_SCHEDULE_MS.length - 1);
  const backoff = BACKOFF_SCHEDULE_MS[idx];
  return warmTime + Math.min(backoff, intervalMs);
}
