import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from '../lib/types.js';
import { formatUsd, shortenModelName, calcEstimatedWarmCost } from '../lib/pricing.js';
import type { ColumnLayout } from '../lib/layout.js';

interface SessionRowProps {
  session: Session;
  highlighted: boolean;
  layout: ColumnLayout;
  warmingActive: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
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
  const liveIndicator = session.isLive ? <Text color={liveColor}>●</Text> : <Text> </Text>;
  if (session.isWarm) {
    return <>{liveIndicator}<Text color={isActivelyWarming ? 'green' : 'yellow'}>[w]</Text></>;
  }
  return <>{liveIndicator}<Text dimColor>[c]</Text></>;
}

function formatCwd(cwd: string, width: number): string {
  if (!cwd) return '';
  const parts = cwd.split('/');
  const short = parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  if (short.length > width - 1) return short.slice(0, width - 2) + '~';
  return short;
}

export function SessionRow({ session, highlighted, layout, warmingActive }: SessionRowProps) {
  const cachedTotal = session.cacheReadTokens + session.cacheWriteTokens;
  const selectChar = session.selected ? '>' : ' ';
  const bgColor = highlighted ? 'gray' : undefined;
  const isCold = !session.isWarm && !session.isLive;
  const isActivelyWarming = warmingActive && session.selected && session.isWarm;
  const rowColor = isActivelyWarming ? 'green' : undefined;
  const isDim = isActivelyWarming ? false : (isCold || !session.selected);

  const expiryCost = isCold ? '-' : formatUsd(session.expiryCostUsd);
  const warmingCost = isCold
    ? formatUsd(calcEstimatedWarmCost(cachedTotal, false, session.model))
    : formatUsd(calcEstimatedWarmCost(cachedTotal, true, session.model));

  return (
    <Box>
      <Box width={2}>
        <Text color={highlighted ? 'cyan' : rowColor} backgroundColor={bgColor}>
          {selectChar}
        </Text>
      </Box>
      <Box width={layout.statusW}>
        <StatusBadge session={session} warmingActive={warmingActive} />
      </Box>
      <Box width={layout.idW}>
        <Text color={rowColor} dimColor={isDim}>{session.sessionId.slice(0, 8)}</Text>
      </Box>
      {layout.showDir && (
        <Box width={layout.dirW}>
          <Text color={rowColor} dimColor={isDim}>{formatCwd(session.cwd, layout.dirW)}</Text>
        </Box>
      )}
      <Box width={layout.nameW}>
        <Text wrap="truncate-end" bold={highlighted} color={rowColor} dimColor={isDim} backgroundColor={bgColor}>
          {session.name}
        </Text>
      </Box>
      {layout.showModel && (
        <Box width={layout.modelW}>
          <Text color={rowColor} dimColor={isDim}>{shortenModelName(session.model)}</Text>
        </Box>
      )}
      <Box width={layout.cachedW} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{formatTokens(session.cacheReadTokens)} + {formatTokens(session.cacheWriteTokens)}</Text>
      </Box>
      {layout.showExpiry && (
        <Box width={layout.numW} justifyContent="flex-end">
          <Text color={rowColor} dimColor={isDim}>{expiryCost}</Text>
        </Box>
      )}
      <Box width={layout.numW} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{warmingCost}</Text>
      </Box>
      <Box width={layout.warmsW} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{session.selected ? String(session.warmCount) : '-'}</Text>
      </Box>
      <Box width={layout.nextW} justifyContent="flex-end">
        <Text color={rowColor} dimColor={isDim}>{formatCountdown(session.nextWarmAt)}</Text>
      </Box>
    </Box>
  );
}
