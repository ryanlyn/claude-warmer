import type { Session, WarmFn, WarmPatch } from './types.js';
import { nextFirstWarm, nextAfterSuccess, nextAfterError } from './scheduler-policy.js';
import { realClock, type Clock, type Random } from './deps.js';

export class Scheduler {
  private warmFn: WarmFn;
  private rng: Random;
  private clock: Clock;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(warmFn: WarmFn, rng: Random = Math.random, clock: Clock = realClock) {
    this.warmFn = warmFn;
    this.rng = rng;
    this.clock = clock;
  }

  bootstrap(sessions: Session[], intervalMinutes: number): Session[] {
    const now = this.clock.now();
    const intervalMs = intervalMinutes * 60 * 1000;
    return sessions.map((s) => {
      if (!s.selected) {
        return { ...s, nextWarmAt: null };
      }
      return { ...s, nextWarmAt: nextFirstWarm(s, now, this.rng, intervalMs) };
    });
  }

  async runDueWarmups(sessions: Session[], warmPrompt: string, intervalMinutes: number): Promise<WarmPatch[]> {
    const now = this.clock.now();
    const intervalMs = intervalMinutes * 60 * 1000;
    const patches: WarmPatch[] = [];

    // Sequential by design: parallelizing would race PTY-driven `claude
    // --resume` spawns on the same JSONL files and would push later sessions
    // past the 60-min cache TTL by the cumulative warm time. See
    // `tests/lib/scheduler-bugs.test.ts > B4`.
    for (const s of sessions) {
      if (!s.nextWarmAt || s.nextWarmAt > now || !s.selected) {
        continue;
      }

      patches.push({ type: 'started', sessionId: s.sessionId, startedAt: this.clock.now() });

      const result = await this.warmFn(s.sessionId, warmPrompt, s.cwd, s.projectDir);
      const warmTime = this.clock.now();

      if (result.error) {
        const consecutiveErrors = (s.consecutiveErrors ?? 0) + 1;
        patches.push({
          type: 'failed',
          sessionId: s.sessionId,
          failedAt: warmTime,
          nextWarmAt: nextAfterError(warmTime, intervalMs, consecutiveErrors - 1),
          error: result.error,
          consecutiveErrors,
        });
      } else {
        patches.push({
          type: 'succeeded',
          sessionId: s.sessionId,
          warmedAt: warmTime,
          nextWarmAt: nextAfterSuccess(warmTime, intervalMs),
          usage: result.usage,
          model: result.model || s.model,
          costUsd: result.costUsd,
        });
      }
    }

    return patches;
  }

  scheduleFirstWarm(session: Session, intervalMinutes: number): Session {
    const now = this.clock.now();
    const intervalMs = intervalMinutes * 60 * 1000;
    return { ...session, nextWarmAt: nextFirstWarm(session, now, this.rng, intervalMs) };
  }

  unscheduleWarm(session: Session): Session {
    return { ...session, nextWarmAt: null };
  }

  stop(): void {
    if (this.timer) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
