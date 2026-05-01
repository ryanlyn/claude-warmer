import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { TextInput } from '@inkjs/ui';
import type { Session, WarmFn } from './lib/types.js';
import { discoverSessions } from './lib/sessions.js';
import { makeWarmer, warmSession } from './lib/warmer.js';
import { Scheduler } from './lib/scheduler.js';
import { copyToClipboard } from './lib/clipboard.js';
import { computeLayout } from './lib/layout.js';
import { appReducer, initialState, type AppSessionState } from './lib/app-reducer.js';
import { realClock, realFs, type Clock, type Fs, type Random } from './lib/deps.js';
import { canWarmSession, markSessionUnwarmable } from './lib/session-policy.js';
import { Header } from './components/header.js';
import { SessionTable } from './components/session-table.js';
import { Footer } from './components/footer.js';

interface AppProps {
  intervalMinutes: number;
  warmPrompt: string;
  initialAutoEnabled?: boolean;
  initialWarmingEnabled?: boolean;
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

function selectWarmableSessions(sessions: Session[]): Session[] {
  return sessions.map((session) =>
    canWarmSession(session) ? { ...session, selected: true } : markSessionUnwarmable(session),
  );
}

function bootstrapWarmableSessions(sessions: Session[], scheduler: Scheduler, intervalMinutes: number): Session[] {
  return scheduler.bootstrap(selectWarmableSessions(sessions), intervalMinutes);
}

function bootstrapWarmableSession(session: Session, scheduler: Scheduler, intervalMinutes: number): Session {
  return bootstrapWarmableSessions([session], scheduler, intervalMinutes)[0];
}

function prepareDiscoverySnapshot(raw: Session[], current: AppSessionState, scheduler: Scheduler): Session[] {
  if (!current.autoEnabled && !current.warmingEnabled) return raw;

  const known = new Map(current.sessions.map((s) => [s.sessionId, s]));

  return raw.map((session) => {
    if (!canWarmSession(session)) return markSessionUnwarmable(session);

    const existing = known.get(session.sessionId);
    if (current.autoEnabled) {
      const shouldSchedule =
        current.warmingEnabled && (!existing?.selected || !existing.nextWarmAt || !existing.isLive);
      if (shouldSchedule) {
        return bootstrapWarmableSession(session, scheduler, current.intervalMinutes);
      }
      return { ...session, selected: true };
    }

    if (current.warmingEnabled && !existing && session.selected) {
      return scheduler.scheduleFirstWarm(session, current.intervalMinutes);
    }

    return session;
  });
}

export function App({
  intervalMinutes: initialInterval,
  warmPrompt: initialPrompt,
  initialAutoEnabled = false,
  initialWarmingEnabled = false,
  deps = {},
}: AppProps) {
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

  // Lazy-init: useRef's initial-value arg is evaluated every render. We only
  // want one Scheduler per mount, hence the construct-on-first-read pattern.
  const schedulerRef = useRef<Scheduler>(null!);
  if (!schedulerRef.current) {
    schedulerRef.current = new Scheduler(warmFn, random, clock);
  }
  const tickingRef = useRef(false);
  const initialRunId = initialWarmingEnabled ? 1 : 0;
  const runIdRef = useRef(initialRunId);

  const [state, dispatch] = useReducer(
    appReducer,
    initialState(initialInterval, initialPrompt, {
      autoEnabled: initialAutoEnabled,
      warmingEnabled: initialWarmingEnabled,
      warmingRunId: initialRunId,
    }),
    (init) => ({
      ...init,
      sessions: prepareDiscoverySnapshot(discoverSessions(fs, clock), init, schedulerRef.current),
    }),
  );
  const { sessions, warmingEnabled, autoEnabled, intervalMinutes, warmPrompt } = state;

  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(clock.now());

  // Latest-state ref so callbacks can read fresh data without depending on
  // useCallback identity / closure capture of each reducer field.
  const stateRef = useRef<AppSessionState>(state);
  stateRef.current = state;

  /* v8 ignore next */
  const cols = stdout?.columns ?? 120;
  const layout = computeLayout(cols);
  const visibleRows = Math.min((stdout?.rows ?? 24) - 6, 20);

  // Periodic session refresh. Auto mode reconciles selection to live
  // processes, while active warming schedules newly selected live sessions
  // before the next tick.
  useEffect(() => {
    const id = clock.setInterval(() => {
      const raw = discoverSessions(fs, clock);
      const fresh = prepareDiscoverySnapshot(raw, stateRef.current, schedulerRef.current);
      dispatch({ type: 'DISCOVERY_SNAPSHOT_RECEIVED', fresh });
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

  const toggleSelection = useCallback((index: number) => {
    const current = stateRef.current;
    const session = current.sessions[index];
    /* v8 ignore next */
    if (!session) return;
    if (!canWarmSession(session) || current.autoEnabled) return;
    const newSelected = !session.selected;
    let next: Session = { ...session, selected: newSelected };
    if (current.warmingEnabled) {
      next = newSelected
        ? schedulerRef.current.scheduleFirstWarm(next, current.intervalMinutes)
        : schedulerRef.current.unscheduleWarm(next);
    }
    dispatch({ type: 'SESSION_REPLACED', sessionId: session.sessionId, next });
  }, []);

  const selectActive = useCallback(() => {
    const current = stateRef.current;
    if (current.autoEnabled) return;
    const next = current.warmingEnabled
      ? bootstrapWarmableSessions(current.sessions, schedulerRef.current, current.intervalMinutes)
      : selectWarmableSessions(current.sessions);
    dispatch({ type: 'SESSION_LIST_REPLACED', next });
  }, []);

  const selectNone = useCallback(() => {
    const current = stateRef.current;
    if (current.autoEnabled) return;
    const next = current.sessions.map((s) => {
      const updated: Session = { ...s, selected: false };
      return current.warmingEnabled ? schedulerRef.current.unscheduleWarm(updated) : updated;
    });
    dispatch({ type: 'SESSION_LIST_REPLACED', next });
  }, []);

  const toggleWarming = useCallback(() => {
    const current = stateRef.current;
    if (!current.warmingEnabled) {
      const runId = ++runIdRef.current;
      const bootstrapped = current.autoEnabled
        ? bootstrapWarmableSessions(current.sessions, schedulerRef.current, current.intervalMinutes)
        : schedulerRef.current.bootstrap(current.sessions, current.intervalMinutes);
      dispatch({ type: 'WARMING_STARTED', runId, bootstrapped });
    } else {
      const runId = ++runIdRef.current;
      schedulerRef.current.stop();
      dispatch({ type: 'WARMING_STOPPED', runId });
    }
  }, []);

  const toggleMode = useCallback(() => {
    const current = stateRef.current;
    if (current.autoEnabled) {
      dispatch({ type: 'AUTO_STOPPED' });
      return;
    }

    const runId = current.warmingEnabled ? current.warmingRunId : ++runIdRef.current;
    const bootstrapped = bootstrapWarmableSessions(current.sessions, schedulerRef.current, current.intervalMinutes);
    dispatch({ type: 'AUTO_STARTED', runId, bootstrapped });
  }, []);

  const copySessionId = useCallback(() => {
    const current = stateRef.current;
    if (current.sessions.length === 0) return;
    const session = current.sessions[highlightedIndex];
    /* v8 ignore next */
    if (!session) return;
    copyToClipboard(session.sessionId);
  }, [highlightedIndex]);

  useEffect(() => {
    if (!warmingEnabled) return;

    const id = clock.setInterval(async () => {
      /* v8 ignore next */
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        const current = stateRef.current;
        const snapshot = current.sessions;
        const runId = current.warmingRunId;
        const patches = await schedulerRef.current.runDueWarmups(snapshot, current.warmPrompt, current.intervalMinutes);
        if (patches.length === 0) return;
        /* v8 ignore next */
        dispatch({ type: 'WARM_PATCHES_RECEIVED', runId, patches });
      } finally {
        tickingRef.current = false;
      }
    }, tickIntervalMs);

    return () => clock.clearInterval(id);
  }, [warmingEnabled, clock, tickIntervalMs]);

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

      if (input === 'm') {
        toggleMode();
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
      dispatch({ type: 'PROMPT_CHANGED', prompt: value.trim() });
    }
    setEditingField(null);
  }, []);

  const handleIntervalSubmit = useCallback((value: string) => {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 59) {
      dispatch({ type: 'INTERVAL_CHANGED', minutes: parsed });
      if (stateRef.current.warmingEnabled) {
        const bootstrapped = schedulerRef.current.bootstrap(stateRef.current.sessions, parsed);
        dispatch({ type: 'SESSION_LIST_REPLACED', next: bootstrapped });
      }
    }
    setEditingField(null);
  }, []);

  return (
    <Box flexDirection="column">
      <Header
        warmingEnabled={warmingEnabled}
        intervalMinutes={intervalMinutes}
        warmPrompt={warmPrompt}
        autoEnabled={autoEnabled}
        refreshIntervalSec={REFRESH_INTERVAL_SEC}
        lastRefreshed={lastRefreshed}
      />
      <SessionTable
        sessions={sessions}
        highlightedIndex={highlightedIndex}
        scrollOffset={scrollOffset}
        layout={layout}
        warmingEnabled={warmingEnabled}
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
