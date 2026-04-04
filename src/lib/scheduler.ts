import type { Session, WarmResult } from './types.js';
import { WARM_THRESHOLD_MS } from './types.js';
import { calcExpiryCost } from './pricing.js';

type WarmFn = (sessionId: string, prompt: string) => Promise<WarmResult>;

export class Scheduler {
  private warmFn: WarmFn;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(warmFn: WarmFn, intervalMinutes: number) {
    this.warmFn = warmFn;
    this.intervalMs = intervalMinutes * 60 * 1000;
  }

  bootstrap(sessions: Session[]): Session[] {
    const now = Date.now();
    return sessions.map((s) => {
      if (s.isLive || !s.selected) {
        return { ...s, nextWarmAt: null };
      }
      return { ...s, nextWarmAt: this.computeFirstWarmTime(s, now) };
    });
  }

  private computeFirstWarmTime(session: Session, now: number): number {
    const anchor = session.lastWarmedAt || session.lastAssistantTimestamp;
    const windowEnd = anchor + WARM_THRESHOLD_MS;

    if (windowEnd <= now) {
      // Cold session - warm immediately
      return now;
    }

    // Warm session - random point in [now, windowEnd]
    const remaining = windowEnd - now;
    return now + Math.floor(Math.random() * remaining);
  }

  async tick(sessions: Session[], warmPrompt: string): Promise<Session[]> {
    const now = Date.now();
    const updated = [...sessions];

    for (let i = 0; i < updated.length; i++) {
      const s = updated[i];
      if (!s.nextWarmAt || s.nextWarmAt > now || s.isLive || !s.selected) {
        continue;
      }

      updated[i] = { ...s, warmingStatus: 'warming' };

      const result = await this.warmFn(s.sessionId, warmPrompt);
      const warmTime = Date.now();

      if (result.error) {
        updated[i] = {
          ...updated[i],
          warmingStatus: 'error',
          lastWarmError: result.error,
          nextWarmAt: warmTime + this.intervalMs,
        };
      } else {
        updated[i] = {
          ...updated[i],
          warmingStatus: 'success',
          warmCount: s.warmCount + 1,
          warmCostUsd: s.warmCostUsd + result.costUsd,
          lastWarmedAt: warmTime,
          lastWarmError: null,
          nextWarmAt: warmTime + this.intervalMs,
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

    return updated;
  }

  addSession(session: Session): Session {
    const now = Date.now();
    return { ...session, nextWarmAt: this.computeFirstWarmTime(session, now) };
  }

  removeSession(session: Session): Session {
    return { ...session, nextWarmAt: null };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
