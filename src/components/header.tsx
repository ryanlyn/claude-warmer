import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  warming: boolean;
  intervalMinutes: number;
  warmPrompt: string;
}

export function Header({ warming, intervalMinutes, warmPrompt }: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="magenta">Claude Warmer</Text>
        <Text>  </Text>
        {warming ? (
          <Text bold color="green">active</Text>
        ) : (
          <Text dimColor>paused</Text>
        )}
        <Text>  </Text>
        <Text dimColor>interval: </Text>
        <Text>{intervalMinutes}m</Text>
        <Text>  </Text>
        <Text dimColor>prompt: </Text>
        <Text>&quot;{warmPrompt}&quot;</Text>
      </Box>
      <Box>
        <Text color="green">■</Text><Text dimColor> warming active    </Text>
        <Text color="yellow">●</Text><Text dimColor> live process    </Text>
        <Text color="yellow">■</Text><Text dimColor> warm (idle)    </Text>
        <Text dimColor>■ cold (expired)</Text>
      </Box>
    </Box>
  );
}
