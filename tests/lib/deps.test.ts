import { describe, it, expect, afterEach, vi } from 'vitest';
import { realDeps, realClock, realFs, realSpawn } from '../../src/lib/deps.js';

describe('deps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('realClock', () => {
    it('now() returns current epoch ms', () => {
      const before = Date.now();
      const got = realClock.now();
      const after = Date.now();
      expect(got).toBeGreaterThanOrEqual(before);
      expect(got).toBeLessThanOrEqual(after);
    });

    it('setInterval / clearInterval round-trip', () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      const id = realClock.setInterval(cb, 1000);
      vi.advanceTimersByTime(2500);
      expect(cb).toHaveBeenCalledTimes(2);
      realClock.clearInterval(id);
      vi.advanceTimersByTime(5000);
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('setTimeout / clearTimeout round-trip', () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      const id = realClock.setTimeout(cb, 1000);
      realClock.clearTimeout(id);
      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();

      const cb2 = vi.fn();
      realClock.setTimeout(cb2, 500);
      vi.advanceTimersByTime(1000);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('realDeps factory', () => {
    it('returns a Deps bag with live bindings', () => {
      const d = realDeps();
      expect(d.clock).toBe(realClock);
      expect(d.fs).toBe(realFs);
      expect(d.spawn).toBe(realSpawn);
      expect(d.random).toBe(Math.random);
    });
  });
});
