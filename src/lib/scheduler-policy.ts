import type { Session } from './types.js';
import { WARM_THRESHOLD_MS, SAFETY_MARGIN_MS, FIRST_WARM_JITTER_MS, BACKOFF_SCHEDULE_MS } from './types.js';

// Pure scheduling policy. Side-effect-free so the arithmetic can be tested
// without fake timers or mocked warmers, and so alternative policies (e.g.
// bounded retry backoff) can be swapped in without touching orchestration.

// Schedule the first warm for a selected session.
//
// Mirrors `nextAfterSuccess` (anchor + min(intervalMs, cap)) but uses the
// session's last interaction time as the anchor instead of a prior warm
// time, then adds symmetric ±FIRST_WARM_JITTER_MS jitter so multiple
// sessions bootstrapped together don't all fire at once. The result is
// floored at `now` (so cold sessions warm immediately) and capped at
// `anchor + WARM_THRESHOLD_MS` (so jitter never pushes a warm past the
// cache TTL).
export function nextFirstWarm(session: Session, now: number, rng: () => number, intervalMs: number): number {
  const anchor = session.lastAssistantTimestamp;
  const cap = WARM_THRESHOLD_MS - SAFETY_MARGIN_MS;
  const base = anchor + Math.min(Math.max(intervalMs, 0), cap);
  const jitter = Math.floor((rng() - 0.5) * 2 * FIRST_WARM_JITTER_MS);
  const candidate = Math.min(base + jitter, anchor + WARM_THRESHOLD_MS);
  return Math.max(now, candidate);
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
