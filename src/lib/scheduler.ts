import type { Session, WarmFn } from './types.js';
import { calcExpiryCost } from './pricing.js';
import { nextFirstWarm, nextAfterSuccess, nextAfterError } from './scheduler-policy.js';
import { realClock, type Clock, type Random } from './deps.js';

export class Scheduler {
  private warmFn: WarmFn;
  private intervalMs: number;
  private rng: Random;
  private clock: Clock;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(warmFn: WarmFn, intervalMinutes: number, rng: Random = Math.random, clock: Clock = realClock) {
    this.warmFn = warmFn;
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.rng = rng;
    this.clock = clock;
  }

  bootstrap(sessions: Session[]): Session[] {
    const now = this.clock.now();
    return sessions.map((s) => {
      if (!s.selected) {
        return { ...s, nextWarmAt: null };
      }
      return { ...s, nextWarmAt: nextFirstWarm(s, now, this.rng, this.intervalMs) };
    });
  }

  async tick(sessions: Session[], warmPrompt: string): Promise<Session[]> {
    const now = this.clock.now();
    // Sequential by design: parallelizing would race PTY-driven `claude
    // --resume` spawns on the same JSONL files and would push later sessions
    // past the 60-min cache TTL by the cumulative warm time. See
    // `tests/lib/scheduler-bugs.test.ts > H1`.
    let updated: Session[] | null = null;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (!s.nextWarmAt || s.nextWarmAt > now || !s.selected) {
        continue;
      }

      if (!updated) updated = [...sessions];
      updated[i] = { ...s, warmingStatus: 'warming' };

      const result = await this.warmFn(s.sessionId, warmPrompt, s.cwd, s.projectDir);
      const warmTime = this.clock.now();

      if (result.error) {
        const consecutiveErrors = (s.consecutiveErrors ?? 0) + 1;
        updated[i] = {
          ...updated[i],
          warmingStatus: 'error',
          lastWarmError: result.error,
          consecutiveErrors,
          nextWarmAt: nextAfterError(warmTime, this.intervalMs, consecutiveErrors - 1),
        };
      } else {
        updated[i] = {
          ...updated[i],
          warmingStatus: 'success',
          warmCount: s.warmCount + 1,
          lastWarmedAt: warmTime,
          lastWarmError: null,
          consecutiveErrors: 0,
          nextWarmAt: nextAfterSuccess(warmTime, this.intervalMs),
          cacheReadTokens: result.usage.cacheReadInputTokens,
          cacheWriteTokens: result.usage.cacheCreationInputTokens,
          expiryCostUsd: calcExpiryCost(
            result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens,
            result.model || s.model,
          ),
          isWarm: true,
          model: result.model || s.model,
        };
      }
    }

    // Return original reference when nothing was warmed so callers can
    // skip downstream re-renders via referential equality.
    return updated ?? sessions;
  }

  addSession(session: Session): Session {
    const now = this.clock.now();
    return { ...session, nextWarmAt: nextFirstWarm(session, now, this.rng, this.intervalMs) };
  }

  removeSession(session: Session): Session {
    return { ...session, nextWarmAt: null };
  }

  stop(): void {
    if (this.timer) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
