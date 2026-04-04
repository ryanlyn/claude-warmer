import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, useInput, useApp } from 'ink';
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

export function App({ intervalMinutes, warmPrompt, defaultModel }: AppProps) {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<Session[]>(() => discoverSessions(defaultModel));
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [warming, setWarming] = useState(false);
  const schedulerRef = useRef<Scheduler>(new Scheduler(warmSession, intervalMinutes));
  const tickingRef = useRef(false);

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

  const selectAll = useCallback(() => {
    setSessions((prev) =>
      prev.map((s) => {
        const updated = { ...s, selected: true };
        if (warming) {
          return schedulerRef.current.addSession(updated);
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

    if (input === 'w') {
      toggleWarming();
      return;
    }

    if (input === 'a') {
      selectAll();
      return;
    }

    if (input === 'n') {
      selectNone();
      return;
    }

    if (input === ' ' || key.return) {
      if (sessions.length > 0) {
        toggleSelection(highlightedIndex);
      }
      return;
    }

    if (key.upArrow) {
      setHighlightedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setHighlightedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Header warming={warming} intervalMinutes={intervalMinutes} warmPrompt={warmPrompt} />
      <SessionTable sessions={sessions} highlightedIndex={highlightedIndex} />
      <Footer />
    </Box>
  );
}
