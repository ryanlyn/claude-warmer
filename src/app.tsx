import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { TextInput } from '@inkjs/ui';
import { execSync } from 'node:child_process';
import type { Session } from './lib/types.js';
import { discoverSessions } from './lib/sessions.js';
import { warmSession } from './lib/warmer.js';
import { Scheduler } from './lib/scheduler.js';
import { Header } from './components/header.js';
import { SessionTable } from './components/session-table.js';
import { Footer } from './components/footer.js';

interface AppProps {
  intervalMinutes: number;
  warmPrompt: string;
  defaultModel: string;
}

type EditingField = 'prompt' | 'interval' | null;

export function App({ intervalMinutes: initialInterval, warmPrompt: initialPrompt, defaultModel }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [sessions, setSessions] = useState<Session[]>(() => discoverSessions(defaultModel));
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [warming, setWarming] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(initialInterval);
  const [warmPrompt, setWarmPrompt] = useState(initialPrompt);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const schedulerRef = useRef<Scheduler>(new Scheduler(warmSession, initialInterval));
  const tickingRef = useRef(false);

  const fixedColumns = 84;
  /* v8 ignore next */
  const nameWidth = Math.max(15, (stdout?.columns ?? 120) - fixedColumns);
  const visibleRows = Math.min((stdout?.rows ?? 24) - 6, 20);

  const toggleSelection = useCallback((index: number) => {
    setSessions((prev) => {
      const updated = [...prev];
      const session = updated[index];
      const newSelected = !session.selected;
      updated[index] = { ...session, selected: newSelected };

      if (warming) {
        if (newSelected) {
          updated[index] = schedulerRef.current.addSession(updated[index]);
        } else {
          updated[index] = schedulerRef.current.removeSession(updated[index]);
        }
      }

      return updated;
    });
  }, [warming]);

  const selectActive = useCallback(() => {
    setSessions((prev) =>
      prev.map((s) => {
        const shouldSelect = s.isLive || s.isWarm;
        const updated = { ...s, selected: shouldSelect };
        if (warming) {
          if (shouldSelect) {
            return schedulerRef.current.addSession(updated);
          }
          return schedulerRef.current.removeSession(updated);
        }
        return updated;
      }),
    );
  }, [warming]);

  const selectNone = useCallback(() => {
    setSessions((prev) =>
      prev.map((s) => {
        const updated = { ...s, selected: false };
        if (warming) {
          return schedulerRef.current.removeSession(updated);
        }
        return updated;
      }),
    );
  }, [warming]);

  const toggleWarming = useCallback(() => {
    setWarming((prev) => {
      if (!prev) {
        setSessions((current) => schedulerRef.current.bootstrap(current));
      } else {
        setSessions((current) =>
          current.map((s) => ({ ...s, nextWarmAt: null, warmingStatus: s.warmingStatus === 'warming' ? 'idle' : s.warmingStatus })),
        );
        schedulerRef.current.stop();
      }
      return !prev;
    });
  }, []);

  const copySessionId = useCallback(() => {
    if (sessions.length === 0) return;
    const session = sessions[highlightedIndex];
    /* v8 ignore next */
    if (!session) return;
    try {
      execSync(`printf '%s' '${session.sessionId}' | pbcopy`);
    } catch {
      // silently ignore clipboard errors
    }
  }, [sessions, highlightedIndex]);

  useEffect(() => {
    if (!warming) return;

    const interval = setInterval(async () => {
      /* v8 ignore next */
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        setSessions((current) => {
          schedulerRef.current.tick(current, warmPrompt).then((updated) => {
            setSessions(updated);
          });
          return current;
        });
      } finally {
        tickingRef.current = false;
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, [warming, warmPrompt]);

  useInput((input, key) => {
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
  }, { isActive: editingField === null });

  const handlePromptSubmit = useCallback((value: string) => {
    if (value.trim()) {
      setWarmPrompt(value.trim());
    }
    setEditingField(null);
  }, []);

  const handleIntervalSubmit = useCallback((value: string) => {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 59) {
      setIntervalMinutes(parsed);
      schedulerRef.current = new Scheduler(warmSession, parsed);
    }
    setEditingField(null);
  }, []);

  return (
    <Box flexDirection="column">
      <Header warming={warming} intervalMinutes={intervalMinutes} warmPrompt={warmPrompt} />
      <SessionTable sessions={sessions} highlightedIndex={highlightedIndex} scrollOffset={scrollOffset} nameWidth={nameWidth} warmingActive={warming} />
      {editingField === 'prompt' && (
        <Box>
          <Text bold color="cyan">Prompt: </Text>
          <TextInput defaultValue={warmPrompt} onSubmit={handlePromptSubmit} />
        </Box>
      )}
      {editingField === 'interval' && (
        <Box>
          <Text bold color="cyan">Interval (minutes): </Text>
          <TextInput defaultValue={String(intervalMinutes)} onSubmit={handleIntervalSubmit} />
        </Box>
      )}
      <Footer />
    </Box>
  );
}
