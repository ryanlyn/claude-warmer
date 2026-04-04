import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from '../lib/types.js';
import { formatUsd, shortenModelName, calcEstimatedWarmCost } from '../lib/pricing.js';

interface SessionRowProps {
  session: Session;
  highlighted: boolean;
  nameWidth: number;
  warmingActive: boolean;
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

function StatusBadge({ session, warmingActive }: { session: Session; warmingActive: boolean }) {
  const isActivelyWarming = warmingActive && session.selected && session.isWarm;
  const liveColor = isActivelyWarming ? 'green' : 'yellow';
  const liveIndicator = session.isLive ? <Text color={liveColor}>● </Text> : <Text>  </Text>;
  if (session.isWarm) {
    return <>{liveIndicator}<Text color={isActivelyWarming ? 'green' : 'yellow'}>[warm]</Text></>;
  }
  return <>{liveIndicator}<Text dimColor>[cold]</Text></>;
}

function formatCwd(cwd: string, width: number): string {
  if (!cwd) return '';
  const parts = cwd.split('/');
  const short = parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  if (short.length > width - 1) return short.slice(0, width - 2) + '~';
  return short;
}

export function SessionRow({ session, highlighted, nameWidth, warmingActive }: SessionRowProps) {
  const cachedTotal = session.cacheReadTokens + session.cacheWriteTokens;
  const selectChar = session.selected ? '>' : ' ';
  const bgColor = highlighted ? 'gray' : undefined;
  const isCold = !session.isWarm && !session.isLive;
  const isActivelyWarming = warmingActive && session.selected && session.isWarm;
  const rowColor = isActivelyWarming ? 'green' : undefined;
  const isDim = isActivelyWarming ? false : (isCold || !session.selected);

  const expiryCost = isCold ? '-' : formatUsd(session.expiryCostUsd);

  let warmingCost: string;
  if (isCold) {
    warmingCost = formatUsd(calcEstimatedWarmCost(cachedTotal, false, session.model));
  } else {
    warmingCost = session.selected ? formatUsd(session.warmCostUsd) : '-';
  }

  return (
    <Box>
      <Box width={2}>
        <Text color={highlighted ? 'cyan' : rowColor} backgroundColor={bgColor}>
          {selectChar}
        </Text>
      </Box>
      <Box width={9}>
        <StatusBadge session={session} warmingActive={warmingActive} />
      </Box>
      <Box width={10}>
        <Text color={rowColor} dimColor={isDim}>{session.sessionId.slice(0, 8)}</Text>
      </Box>
      <Box width={14}>
        <Text color={rowColor} dimColor={isDim}>{formatCwd(session.cwd, 14)}</Text>
      </Box>
      <Box width={nameWidth}>
        <Text wrap="truncate-end" bold={highlighted} color={rowColor} dimColor={isDim} backgroundColor={bgColor}>
          {' '}{session.name}
        </Text>
      </Box>
      <Box width={10}>
        <Text color={rowColor} dimColor={isDim}>{shortenModelName(session.model)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{formatTokens(cachedTotal)}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{expiryCost}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{warmingCost}</Text>
      </Box>
      <Box width={6} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{session.selected ? String(session.warmCount) : '-'}</Text>
      </Box>
      <Box width={9} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{formatCountdown(session.nextWarmAt)}</Text>
      </Box>
    </Box>
  );
}
