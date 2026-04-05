import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  warming: boolean;
  intervalMinutes: number;
  warmPrompt: string;
  refreshIntervalSec: number;
  lastRefreshed: number | null;
}

export function Header({ warming, intervalMinutes, warmPrompt, refreshIntervalSec, lastRefreshed }: HeaderProps) {
  const refreshLabel = lastRefreshed
    ? new Date(lastRefreshed).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '-';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="truncate-end">
        <Text bold color="magenta">Claude Warmer</Text>
        <Text>  </Text>
        {warming ? (
          <Text bold color="green">active</Text>
        ) : (
          <Text dimColor>paused</Text>
        )}
        <Text>  </Text>
        <Text dimColor>int:</Text>
        <Text>{intervalMinutes}m</Text>
        <Text>  </Text>
        <Text dimColor>prompt:</Text>
        <Text>&quot;{warmPrompt}&quot;</Text>
        <Text>  </Text>
        <Text dimColor>refresh:</Text>
        <Text>{refreshIntervalSec}s</Text>
        <Text dimColor> ({refreshLabel})</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color="green">■</Text><Text dimColor> warming  </Text>
        <Text color="yellow">●</Text><Text dimColor> live  </Text>
        <Text color="yellow">■</Text><Text dimColor> warm  </Text>
        <Text dimColor>■ cold</Text>
      </Text>
    </Box>
  );
}
