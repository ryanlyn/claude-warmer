import { BACKOFF_SCHEDULE_MS, SAFETY_MARGIN_MS, WARM_THRESHOLD_MS } from './types.ts';

// Pure scheduling policy. Side-effect-free so the arithmetic can be tested
// without fake timers or mocked warmers, and so alternative policies (e.g.
// bounded retry backoff) can be swapped in without touching orchestration.

export interface NextWarmOpts {
  // Random source + magnitude for symmetric jitter around the base time.
  // Omit for deterministic scheduling (post-success path).
  jitter?: { rng: () => number; magnitudeMs: number };
  // Lower-bound floor for the result. Used by the first-warm path so a cold
  // session (anchor far in the past) fires immediately rather than at a
  // computed past time.
  now?: number;
}

// Compute the next warm time for a session.
//
// Shared by the first-warm path (anchored on the session's last interaction
// time, with ±jitter and a `now` floor) and the post-success path (anchored
// on the most recent warm time, no jitter, no floor):
//
//   base      = anchor + min(intervalMs, WARM_THRESHOLD_MS - SAFETY_MARGIN_MS)
//   candidate = min(base ± jitter, anchor + WARM_THRESHOLD_MS)
//   result    = max(opts.now, candidate)
//
// The `cap` (50min) leaves headroom for cumulative serial-warm latency
// against the 60-min cache TTL. The upper clamp at `anchor + WARM_THRESHOLD_MS`
// keeps positive jitter from crossing the TTL.
export function nextWarm(anchor: number, intervalMs: number, opts: NextWarmOpts = {}): number {
  const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
  const base = anchor + Math.min(Math.max(intervalMs, 0), cap);
  const jitter = opts.jitter ? Math.floor((opts.jitter.rng() - 0.5) * 2 * opts.jitter.magnitudeMs) : 0;
  const candidate = Math.min(base + jitter, anchor + WARM_THRESHOLD_MS);
  return Math.max(opts.now ?? -Infinity, candidate);
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
