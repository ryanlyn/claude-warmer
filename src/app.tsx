import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { TextInput } from '@inkjs/ui';
import { execSync } from 'node:child_process';
import type { Session, WarmFn } from './lib/types.js';
import { discoverSessions } from './lib/sessions.js';
import { makeWarmer, warmSession } from './lib/warmer.js';
import { Scheduler } from './lib/scheduler.js';
import { computeLayout } from './lib/layout.js';
import { appReducer, initialState, type AppSessionState } from './lib/app-reducer.js';
import { realClock, realFs, type Clock, type Fs, type Random } from './lib/deps.js';
import { Header } from './components/header.js';
import { SessionTable } from './components/session-table.js';
import { Footer } from './components/footer.js';

interface AppProps {
  intervalMinutes: number;
  warmPrompt: string;
  /**
   * Optional dependency injection for tests and integration runs. When
   * omitted, real Date/setInterval/node:fs/warmSession are used. When
   * supplied, every timer, filesystem read, warmer call, and RNG draw
   * routes through the injected surface, which lets an accelerated
   * integration run drive multi-hour behavior with fake clocks and
   * in-memory state.
   */
  deps?: {
    clock?: Clock;
    fs?: Fs;
    warmFn?: WarmFn;
    random?: Random;
    /** Polling cadence for the warm-tick loop. Defaults to 30s. */
    tickIntervalMs?: number;
    /** Polling cadence for the discoverSessions refresh. Defaults to 30s. */
    refreshIntervalMs?: number;
  };
}

type EditingField = 'prompt' | 'interval' | null;

const REFRESH_INTERVAL_SEC = 30;
const DEFAULT_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_SEC * 1000;
const DEFAULT_TICK_INTERVAL_MS = 30_000;

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function clampScrollOffset(offset: number, length: number, visibleRows: number): number {
  const maxOffset = Math.max(0, length - visibleRows);
  return Math.min(Math.max(offset, 0), maxOffset);
}

export function App({ intervalMinutes: initialInterval, warmPrompt: initialPrompt, deps = {} }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const clock = deps.clock ?? realClock;
  const fs = deps.fs ?? realFs;
  // When a caller injects fs/clock, bind them into the default warmFn too so
  // the injection is consistent end-to-end. When neither is overridden we
  // pass the raw warmSession through, which keeps tests that
  // `vi.mock('warmer.js')` working without also having to mock `makeWarmer`.
  const warmFn =
    deps.warmFn ?? (deps.fs !== undefined || deps.clock !== undefined ? makeWarmer({ fs, clock }) : warmSession);
  const random = deps.random ?? Math.random;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const refreshIntervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

  const [state, dispatch] = useReducer(appReducer, initialState(initialInterval, initialPrompt), (init) => ({
    ...init,
    sessions: discoverSessions(fs, clock),
  }));
  const { sessions, warming, intervalMinutes, warmPrompt } = state;

  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(clock.now());

  // Latest-state ref so callbacks can read fresh data without depending on
  // useCallback identity / closure capture of each reducer field.
  const stateRef = useRef<AppSessionState>(state);
  stateRef.current = state;

  // Lazy-init: useRef's initial-value arg is evaluated every render. We only
  // want one Scheduler per mount, hence the construct-on-first-read pattern.
  const schedulerRef = useRef<Scheduler>(undefined as unknown as Scheduler);
  if (!schedulerRef.current) {
    schedulerRef.current = new Scheduler(warmFn, initialInterval, random, clock);
  }
  const tickingRef = useRef(false);

  /* v8 ignore next */
  const cols = stdout?.columns ?? 120;
  const layout = computeLayout(cols);
  const visibleRows = Math.min((stdout?.rows ?? 24) - 6, 20);

  // Periodic session refresh. When warming is active, sessions newly seen
  // AND auto-selected by discovery get scheduled immediately via addSession
  // so the next tick picks them up; otherwise they would render selected
  // but with nextWarmAt:null and never be warmed.
  useEffect(() => {
    const id = clock.setInterval(() => {
      const raw = discoverSessions(fs, clock);
      const known = new Set(stateRef.current.sessions.map((s) => s.sessionId));
      const fresh = stateRef.current.warming
        ? raw.map((s) => (!known.has(s.sessionId) && s.selected ? schedulerRef.current.addSession(s) : s))
        : raw;
      dispatch({ type: 'REFRESH_MERGE', fresh });
      setLastRefreshed(clock.now());
    }, refreshIntervalMs);
    return () => clock.clearInterval(id);
  }, [clock, fs, refreshIntervalMs]);

  useEffect(() => {
    setHighlightedIndex((prev) => clampIndex(prev, sessions.length));
  }, [sessions.length]);

  useEffect(() => {
    setScrollOffset((prev) => {
      const nextIndex = clampIndex(highlightedIndex, sessions.length);
      const nextOffset = clampScrollOffset(prev, sessions.length, visibleRows);

      if (sessions.length === 0) return 0;
      /* v8 ignore next */
      if (nextIndex < nextOffset) return nextIndex;
      if (nextIndex >= nextOffset + visibleRows) {
        return Math.max(0, nextIndex - visibleRows + 1);
      }
      return nextOffset;
    });
  }, [highlightedIndex, sessions.length, visibleRows]);

  const toggleSelection = useCallback(
    (index: number) => {
      const current = stateRef.current;
      const session = current.sessions[index];
      /* v8 ignore next */
      if (!session) return;
      const newSelected = !session.selected;
      let next: Session = { ...session, selected: newSelected };
      if (current.warming) {
        next = newSelected ? schedulerRef.current.addSession(next) : schedulerRef.current.removeSession(next);
      }
      dispatch({ type: 'REPLACE_SESSION', sessionId: session.sessionId, next });
    },
    [],
  );

  const selectActive = useCallback(() => {
    const current = stateRef.current;
    const next = current.sessions.map((s) => {
      const shouldSelect = s.isLive || s.isWarm;
      let updated: Session = { ...s, selected: shouldSelect };
      if (current.warming) {
        updated = shouldSelect ? schedulerRef.current.addSession(updated) : schedulerRef.current.removeSession(updated);
      }
      return updated;
    });
    dispatch({ type: 'REPLACE_ALL', next });
  }, []);

  const selectNone = useCallback(() => {
    const current = stateRef.current;
    const next = current.sessions.map((s) => {
      const updated: Session = { ...s, selected: false };
      return current.warming ? schedulerRef.current.removeSession(updated) : updated;
    });
    dispatch({ type: 'REPLACE_ALL', next });
  }, []);

  const toggleWarming = useCallback(() => {
    const current = stateRef.current;
    if (!current.warming) {
      const bootstrapped = schedulerRef.current.bootstrap(current.sessions);
      dispatch({ type: 'WARMING_ON', bootstrapped });
    } else {
      schedulerRef.current.stop();
      dispatch({ type: 'WARMING_OFF' });
    }
  }, []);

  const copySessionId = useCallback(() => {
    const current = stateRef.current;
    if (current.sessions.length === 0) return;
    const session = current.sessions[highlightedIndex];
    /* v8 ignore next */
    if (!session) return;
    try {
      execSync('pbcopy', { input: session.sessionId });
    } catch {
      // silently ignore clipboard errors
    }
  }, [highlightedIndex]);

  useEffect(() => {
    if (!warming) return;

    const id = clock.setInterval(async () => {
      /* v8 ignore next */
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        const snapshot = stateRef.current.sessions;
        const updated = await schedulerRef.current.tick(snapshot, stateRef.current.warmPrompt);
        /* v8 ignore next */
        dispatch({ type: 'TICK_RESULT', updated });
      } finally {
        tickingRef.current = false;
      }
    }, tickIntervalMs);

    return () => clock.clearInterval(id);
  }, [warming, clock, tickIntervalMs]);

  useInput(
    (input, key) => {
      if (input === 'q') {
        schedulerRef.current.stop();
        exit();
        return;
      }

      if (key.return) {
        toggleWarming();
        return;
      }

      if (input === 'a') {
        selectActive();
        return;
      }

      if (input === 'n') {
        selectNone();
        return;
      }

      if (input === 'p') {
        setEditingField('prompt');
        return;
      }

      if (input === 'i') {
        setEditingField('interval');
        return;
      }

      if (input === 'c') {
        copySessionId();
        return;
      }

      if (input === ' ') {
        if (sessions.length > 0) {
          toggleSelection(highlightedIndex);
        }
        return;
      }

      if (key.upArrow) {
        if (sessions.length === 0) return;
        setHighlightedIndex((prev) => {
          const next = Math.max(0, prev - 1);
          setScrollOffset((offset) => {
            if (next < offset) return next;
            return offset;
          });
          return next;
        });
        return;
      }

      if (key.downArrow) {
        if (sessions.length === 0) return;
        setHighlightedIndex((prev) => {
          const next = Math.min(sessions.length - 1, prev + 1);
          setScrollOffset((offset) => {
            if (next >= offset + visibleRows) return next - visibleRows + 1;
            return offset;
          });
          return next;
        });
        return;
      }
    },
    { isActive: editingField === null },
  );

  const handlePromptSubmit = useCallback((value: string) => {
    if (value.trim()) {
      dispatch({ type: 'SET_PROMPT', prompt: value.trim() });
    }
    setEditingField(null);
  }, []);

  const handleIntervalSubmit = useCallback(
    (value: string) => {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 59) {
        dispatch({ type: 'SET_INTERVAL', minutes: parsed });
        schedulerRef.current = new Scheduler(warmFn, parsed, random, clock);
        if (stateRef.current.warming) {
          const bootstrapped = schedulerRef.current.bootstrap(stateRef.current.sessions);
          dispatch({ type: 'REPLACE_ALL', next: bootstrapped });
        }
      }
      setEditingField(null);
    },
    [clock, random, warmFn],
  );

  return (
    <Box flexDirection="column">
      <Header
        warming={warming}
        intervalMinutes={intervalMinutes}
        warmPrompt={warmPrompt}
        refreshIntervalSec={REFRESH_INTERVAL_SEC}
        lastRefreshed={lastRefreshed}
      />
      <SessionTable
        sessions={sessions}
        highlightedIndex={highlightedIndex}
        scrollOffset={scrollOffset}
        layout={layout}
        warmingActive={warming}
      />
      {editingField === 'prompt' && (
        <Box>
          <Text bold color="cyan">
            Prompt:{' '}
          </Text>
          <TextInput defaultValue={warmPrompt} onSubmit={handlePromptSubmit} />
        </Box>
      )}
      {editingField === 'interval' && (
        <Box>
          <Text bold color="cyan">
            Interval (minutes):{' '}
          </Text>
          <TextInput defaultValue={String(intervalMinutes)} onSubmit={handleIntervalSubmit} />
        </Box>
      )}
      <Footer />
    </Box>
  );
}
