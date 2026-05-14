import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { spy } from '@std/testing/mock';
import { FakeTime } from '@std/testing/time';
import { realClock, realDeps, realFs, realSpawn } from '../../src/lib/deps.ts';

describe('deps', () => {
  let time: FakeTime | null = null;

  afterEach(() => {
    if (time) {
      time.restore();
      time = null;
    }
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
      time = new FakeTime();
      const cb = spy(() => {});
      const id = realClock.setInterval(cb, 1000);
      time.tick(2500);
      expect(cb.calls.length).toBe(2);
      realClock.clearInterval(id);
      time.tick(5000);
      expect(cb.calls.length).toBe(2);
    });

    it('setTimeout / clearTimeout round-trip', () => {
      time = new FakeTime();
      const cb = spy(() => {});
      const id = realClock.setTimeout(cb, 1000);
      realClock.clearTimeout(id);
      time.tick(2000);
      expect(cb.calls.length).toBe(0);

      const cb2 = spy(() => {});
      realClock.setTimeout(cb2, 500);
      time.tick(1000);
      expect(cb2.calls.length).toBe(1);
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
