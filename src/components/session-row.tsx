import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from '../lib/types.js';
import { formatUsd, shortenModelName } from '../lib/pricing.js';

interface SessionRowProps {
  session: Session;
  highlighted: boolean;
  nameWidth: number;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCountdown(nextWarmAt: number | null): string {
  if (!nextWarmAt) return '-';
  const diffMs = nextWarmAt - Date.now();
  if (diffMs <= 0) return 'now';
  const minutes = Math.ceil(diffMs / 60_000);
  return `${minutes}m`;
}

function StatusBadge({ session }: { session: Session }) {
  if (session.isLive) {
    return <Text color="blue">[live]</Text>;
  }
  if (session.isWarm) {
    return <Text color="green">[warm]</Text>;
  }
  return <Text dimColor>[cold]</Text>;
}

function WarmingIndicator({ session }: { session: Session }) {
  if (session.warmingStatus === 'warming') {
    return <Text color="yellow">warming...</Text>;
  }
  if (session.warmingStatus === 'error') {
    return <Text color="red">error</Text>;
  }
  if (session.warmingStatus === 'success') {
    return <Text color="green">ok</Text>;
  }
  return <Text dimColor>idle</Text>;
}

export function SessionRow({ session, highlighted, nameWidth }: SessionRowProps) {
  const cachedTotal = session.cacheReadTokens + session.cacheWriteTokens;
  const selectChar = session.selected ? '>' : ' ';
  const bgColor = highlighted ? 'gray' : undefined;
  const isCold = !session.isWarm && !session.isLive;
  const isDim = isCold || !session.selected;

  return (
    <Box>
      <Box width={2}>
        <Text color={highlighted ? 'cyan' : undefined} backgroundColor={bgColor}>
          {selectChar}
        </Text>
      </Box>
      <Box width={7}>
        <StatusBadge session={session} />
      </Box>
      <Box width={10}>
        <Text dimColor={isDim}>{session.sessionId.slice(0, 8)}</Text>
      </Box>
      <Box width={nameWidth}>
        <Text wrap="truncate-end" bold={highlighted} dimColor={isDim} backgroundColor={bgColor}>
          {' '}{session.name}
        </Text>
      </Box>
      <Box width={10}>
        <Text dimColor={isDim}>{shortenModelName(session.model)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text dimColor={isDim}>{formatTokens(cachedTotal)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text dimColor={isDim}>
          {session.isWarm || session.isLive ? formatUsd(session.expiryCostUsd) : '-'}
        </Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text dimColor={isDim}>
          {session.selected ? formatUsd(session.warmCostUsd) : '-'}
        </Text>
      </Box>
      <Box width={6} justifyContent="flex-end">
        <Text dimColor={isDim}>{session.selected ? String(session.warmCount) : '-'}</Text>
      </Box>
      <Box width={9} justifyContent="flex-end">
        <Text dimColor={isDim}>{formatCountdown(session.nextWarmAt)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <WarmingIndicator session={session} />
      </Box>
    </Box>
  );
}
