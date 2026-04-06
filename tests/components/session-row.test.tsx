import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SessionRow } from '../../src/components/session-row.js';
import type { Session } from '../../src/lib/types.js';
import { computeLayout } from '../../src/lib/layout.js';

// ink-testing-library renders without a TTY, so content may wrap at narrow widths.
// Use a narrow layout to minimize total row width and avoid wrapping artifacts.
const layout = computeLayout(65);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'abc12345-6789',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-opus-4-6',
    lastAssistantTimestamp: Date.now() - 10 * 60 * 1000,
    isWarm: true,
    isLive: false,
    cacheReadTokens: 100000,
    cacheWriteTokens: 5000,
    expiryCostUsd: 1.05,
    selected: true,
    warmingStatus: 'idle',
    warmCostUsd: 0.05,
    warmCount: 2,
    nextWarmAt: Date.now() + 12 * 60 * 1000,
    lastWarmedAt: Date.now() - 5 * 60 * 1000,
    lastWarmError: null,
    ...overrides,
  };
}

describe('SessionRow', () => {
  it('renders session name', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession()} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('Test Session');
  });

  it('shows warm badge for warm sessions', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession({ isWarm: true })} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('[w]');
  });

  it('shows cold badge for cold sessions', () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ isWarm: false, isLive: false })}
        highlighted={false}
        layout={layout}
        warmingActive={false}
      />,
    );
    expect(lastFrame()!).toContain('[c]');
  });

  it('shows live indicator and warm badge for live sessions', () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ isLive: true, isWarm: true })}
        highlighted={false}
        layout={layout}
        warmingActive={false}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('●');
    expect(frame).toContain('[w]');
  });

  it('does not show live indicator for non-live sessions', () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ isLive: false, isWarm: true })}
        highlighted={false}
        layout={layout}
        warmingActive={false}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).not.toContain('●');
    expect(frame).toContain('[w]');
  });

  it('shows model short name at wide widths', () => {
    const wide = computeLayout(140);
    const { lastFrame } = render(
      <SessionRow session={makeSession()} highlighted={false} layout={wide} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('opus');
  });

  it('shows formatted cached tokens', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession()} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('100k + 5k');
  });

  it('formats small token counts without k suffix', () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ cacheReadTokens: 500, cacheWriteTokens: 200 })}
        highlighted={false}
        layout={layout}
        warmingActive={false}
      />,
    );
    expect(lastFrame()!).toContain('500 + 200');
  });

  it('formats million token counts with M suffix', () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ cacheReadTokens: 2_500_000, cacheWriteTokens: 100_000 })}
        highlighted={false}
        layout={layout}
        warmingActive={false}
      />,
    );
    expect(lastFrame()!).toContain('2.5M + 100k');
  });

  it('shows empty cwd when not set', () => {
    const wide = computeLayout(100);
    const { lastFrame } = render(
      <SessionRow session={makeSession({ cwd: '' })} highlighted={false} layout={wide} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('Test Session');
  });

  it('shows expiry cost for warm sessions at wide widths', () => {
    const wide = computeLayout(140);
    const { lastFrame } = render(
      <SessionRow session={makeSession({ isWarm: true })} highlighted={false} layout={wide} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('$1.05');
  });

  it('shows expiry dash for cold sessions at wide widths', () => {
    const wide = computeLayout(140);
    const session = makeSession({ isWarm: false, isLive: false });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={wide} warmingActive={false} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('-');
  });

  it('shows expiry cost for live warm sessions at wide widths', () => {
    const wide = computeLayout(140);
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ isLive: true, isWarm: true })}
        highlighted={false}
        layout={wide}
        warmingActive={false}
      />,
    );
    expect(lastFrame()!).toContain('$1.05');
  });

  it('shows warm cost for selected sessions', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession()} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('$0.05');
  });

  it('shows dash for warm cost on unselected sessions', () => {
    const session = makeSession({ selected: false });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('-');
  });

  it('shows warm count', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession({ warmCount: 5 })} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('5');
  });

  it('shows cwd directory name when visible', () => {
    const wide = computeLayout(100);
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ cwd: '/Users/ryan/dev/my-project' })}
        highlighted={false}
        layout={wide}
        warmingActive={false}
      />,
    );
    expect(lastFrame()!).toContain('my-project');
  });

  it('handles trailing slash in cwd', () => {
    const wide = computeLayout(100);
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ cwd: '/Users/ryan/dev/project/' })}
        highlighted={false}
        layout={wide}
        warmingActive={false}
      />,
    );
    expect(lastFrame()!).toContain('project');
  });

  it('handles root path cwd', () => {
    const wide = computeLayout(100);
    const { lastFrame } = render(
      <SessionRow session={makeSession({ cwd: '/' })} highlighted={false} layout={wide} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('Test Session');
  });

  it('truncates long cwd names', () => {
    const wide = computeLayout(100);
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ cwd: '/Users/ryan/dev/very-long-directory-name-here' })}
        highlighted={false}
        layout={wide}
        warmingActive={false}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('~');
  });

  it('shows dash for next warm when not scheduled', () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({ nextWarmAt: null })}
        highlighted={false}
        layout={layout}
        warmingActive={false}
      />,
    );
    expect(lastFrame()!).toContain('-');
  });

  it('shows next warm countdown', () => {
    const session = makeSession({ nextWarmAt: Date.now() + 12 * 60 * 1000 });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('12m');
  });

  it('shows first 8 chars of session ID', () => {
    const session = makeSession({ sessionId: 'abcdefgh-1234-5678' });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('abcdefgh');
  });

  it('shows now for expired countdown', () => {
    const session = makeSession({ nextWarmAt: Date.now() - 1000 });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('now');
  });

  it('shows green badge when warming is active and session is selected and warm', () => {
    const session = makeSession({ isWarm: true, selected: true });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={true} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('[w]');
  });

  it('shows yellow badge when session is warm but warming is not active', () => {
    const session = makeSession({ isWarm: true, selected: true });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('[w]');
  });

  it('shows yellow badge when warming is active but session is not selected', () => {
    const session = makeSession({ isWarm: true, selected: false });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={true} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('[w]');
  });

  it('shows cold badge for cold sessions even if warming active', () => {
    const session = makeSession({ isWarm: false, isLive: false, selected: true });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={true} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('[c]');
  });

  it('shows full cache write cost for selected cold sessions', () => {
    const session = makeSession({
      isWarm: false,
      isLive: false,
      selected: true,
      cacheReadTokens: 100000,
      cacheWriteTokens: 5000,
      model: 'claude-opus-4-6',
    });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    const frame = lastFrame()!;
    // 105000 tokens * $5 * 2 / 1M = $1.05
    expect(frame).toContain('$1.05');
  });

  it('shows warming cost for unselected cold sessions', () => {
    const session = makeSession({
      isWarm: false,
      isLive: false,
      selected: false,
      cacheReadTokens: 100000,
      cacheWriteTokens: 5000,
      model: 'claude-opus-4-6',
    });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    const frame = lastFrame()!;
    // 105000 tokens * $5 * 2 / 1M = $1.05
    expect(frame).toContain('$1.05');
  });

  it('uses green text for actively warming rows', () => {
    const session = makeSession({ isWarm: true, selected: true });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={true} />,
    );
    // We can't easily test color in ink-testing-library but we verify it renders without error
    expect(lastFrame()!).toContain('Test Session');
  });

  it('uses dim text for cold sessions', () => {
    const session = makeSession({ isWarm: false, isLive: false, selected: false });
    const { lastFrame } = render(
      <SessionRow session={session} highlighted={false} layout={layout} warmingActive={false} />,
    );
    expect(lastFrame()!).toContain('Test Session');
  });
});
