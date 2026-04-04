import React from 'react';
import { Box, Text } from 'ink';

function KeyHint({ keyName, label }: { keyName: string; label: string }) {
  return (
    <Box marginRight={2}>
      <Text bold color="cyan">{keyName}</Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

export function Footer() {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <KeyHint keyName="space/enter" label="toggle" />
      <KeyHint keyName="a" label="all" />
      <KeyHint keyName="n" label="none" />
      <KeyHint keyName="w" label="warm" />
      <KeyHint keyName="i" label="interval" />
      <KeyHint keyName="q" label="quit" />
    </Box>
  );
}
