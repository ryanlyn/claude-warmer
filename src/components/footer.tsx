import React from 'react';
import { Box, Text } from 'ink';

function KeyHint({ keyName, label }: { keyName: string; label: string }) {
  return (
    <Text>
      <Text bold color="cyan">{keyName}</Text>
      <Text dimColor> {label}  </Text>
    </Text>
  );
}

export function Footer() {
  return (
    <Box>
      <Text wrap="truncate-end">
        <KeyHint keyName="ent" label="warm" />
        <KeyHint keyName="spc" label="toggle" />
        <KeyHint keyName="a" label="live" />
        <KeyHint keyName="n" label="none" />
        <KeyHint keyName="i" label="int" />
        <KeyHint keyName="p" label="prompt" />
        <KeyHint keyName="c" label="copy" />
        <KeyHint keyName="q" label="quit" />
      </Text>
    </Box>
  );
}
