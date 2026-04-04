import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from '../lib/types.js';
import { SessionRow } from './session-row.js';

interface SessionTableProps {
  sessions: Session[];
  highlightedIndex: number;
}

function ColumnHeader({ label, width, align }: { label: string; width: number; align?: 'right' }) {
  return (
    <Box width={width} justifyContent={align === 'right' ? 'flex-end' : undefined}>
      <Text bold dimColor>{label}</Text>
    </Box>
  );
}

export function SessionTable({ sessions, highlightedIndex }: SessionTableProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2}><Text> </Text></Box>
        <Box width={7}><Text> </Text></Box>
        <ColumnHeader label="Session Name" width={20} />
        <ColumnHeader label="Model" width={10} />
        <ColumnHeader label="Cached" width={10} align="right" />
        <ColumnHeader label="Expiry Cost" width={12} align="right" />
        <ColumnHeader label="Warm Cost" width={10} align="right" />
        <ColumnHeader label="Warms" width={7} align="right" />
        <ColumnHeader label="Next Warm" width={10} align="right" />
        <ColumnHeader label="Status" width={12} align="right" />
      </Box>
      {sessions.length === 0 ? (
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>No sessions found. Check ~/.claude/projects/ for session transcripts.</Text>
        </Box>
      ) : (
        sessions.map((session, index) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            highlighted={index === highlightedIndex}
          />
        ))
      )}
    </Box>
  );
}
