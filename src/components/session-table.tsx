import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Session } from '../lib/types.js';
import { SessionRow } from './session-row.js';

interface SessionTableProps {
  sessions: Session[];
  highlightedIndex: number;
  scrollOffset: number;
  nameWidth: number;
}

function ColumnHeader({ label, width, align }: { label: string; width: number; align?: 'right' }) {
  return (
    <Box width={width} justifyContent={align === 'right' ? 'flex-end' : undefined}>
      <Text bold dimColor>{label}</Text>
    </Box>
  );
}

export function SessionTable({ sessions, highlightedIndex, scrollOffset, nameWidth }: SessionTableProps) {
  const { stdout } = useStdout();
  const visibleRows = Math.min((stdout?.rows ?? 24) - 6, 20);
  const visibleSessions = sessions.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2}><Text> </Text></Box>
        <Box width={7}><Text> </Text></Box>
        <ColumnHeader label="ID" width={10} />
        <ColumnHeader label="Session Name" width={nameWidth} />
        <ColumnHeader label="Model" width={10} />
        <ColumnHeader label="Cached" width={10} align="right" />
        <ColumnHeader label="Expiry" width={10} align="right" />
        <ColumnHeader label="Est. Cost" width={10} align="right" />
        <ColumnHeader label="Warms" width={6} align="right" />
        <ColumnHeader label="Next" width={9} align="right" />
        <ColumnHeader label="Status" width={10} align="right" />
      </Box>
      {sessions.length === 0 ? (
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>No sessions found. Check ~/.claude/projects/ for session transcripts.</Text>
        </Box>
      ) : (
        visibleSessions.map((session, index) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            highlighted={scrollOffset + index === highlightedIndex}
            nameWidth={nameWidth}
          />
        ))
      )}
    </Box>
  );
}
