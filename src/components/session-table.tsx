import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Session } from '../lib/types.js';
import { SessionRow } from './session-row.js';
import type { ColumnLayout } from '../lib/layout.js';

interface SessionTableProps {
  sessions: Session[];
  highlightedIndex: number;
  scrollOffset: number;
  layout: ColumnLayout;
  warmingActive: boolean;
}

function ColumnHeader({ label, width, align }: { label: string; width: number; align?: 'right' }) {
  return (
    <Box width={width} justifyContent={align === 'right' ? 'flex-end' : undefined}>
      <Text bold dimColor>
        {label}
      </Text>
    </Box>
  );
}

export function SessionTable({ sessions, highlightedIndex, scrollOffset, layout, warmingActive }: SessionTableProps) {
  const { stdout } = useStdout();
  const visibleRows = Math.min((stdout?.rows ?? 24) - 6, 20);
  const visibleSessions = sessions.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2}>
          <Text> </Text>
        </Box>
        <Box width={layout.statusW}>
          <Text> </Text>
        </Box>
        <ColumnHeader label="ID" width={layout.idW} />
        {layout.showDir && <ColumnHeader label="Dir" width={layout.dirW} />}
        <ColumnHeader label="Name" width={layout.nameW} />
        {layout.showModel && <ColumnHeader label="Model" width={layout.modelW} />}
        <ColumnHeader label="R+W" width={layout.cachedW} align="right" />
        {layout.showExpiry && <ColumnHeader label="Expiry" width={layout.numW} align="right" />}
        <ColumnHeader label="Cost" width={layout.numW} align="right" />
        <ColumnHeader label="Warms" width={layout.warmsW} align="right" />
        <ColumnHeader label="Next" width={layout.nextW} align="right" />
      </Box>
      {sessions.length === 0 ? (
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>No sessions found.</Text>
        </Box>
      ) : (
        visibleSessions.map((session, index) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            highlighted={scrollOffset + index === highlightedIndex}
            layout={layout}
            warmingActive={warmingActive}
          />
        ))
      )}
    </Box>
  );
}
