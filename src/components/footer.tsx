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
      <KeyHint keyName="space" label="toggle" />
      <KeyHint keyName="enter" label="warm" />
      <KeyHint keyName="a" label="active" />
      <KeyHint keyName="n" label="none" />
      <KeyHint keyName="i" label="interval" />
      <KeyHint keyName="p" label="prompt" />
      <KeyHint keyName="c" label="copy id" />
      <KeyHint keyName="q" label="quit" />
    </Box>
  );
}
