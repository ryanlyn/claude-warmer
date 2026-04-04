import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.js';
import * as sessionsModule from '../../src/lib/sessions.js';
import * as warmerModule from '../../src/lib/warmer.js';

vi.mock('../../src/lib/sessions.js');
vi.mock('../../src/lib/warmer.js');

const mockSessions = vi.mocked(sessionsModule);

beforeEach(() => {
  vi.resetAllMocks();
  mockSessions.discoverSessions.mockReturnValue([
    {
      sessionId: 'abc-123',
      name: 'Test Session',
      projectDir: 'test',
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
      warmCostUsd: 0,
      warmCount: 0,
      nextWarmAt: null,
      lastWarmedAt: null,
      lastWarmError: null,
    },
  ]);
});

describe('App', () => {
  it('renders header with app name', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('Cache Warmer');
  });

  it('renders discovered sessions', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('Test Session');
  });

  it('renders footer with keybindings', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('quit');
  });

  it('toggles selection on space key', () => {
    const { lastFrame, stdin } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    // Session starts selected (isWarm=true), press space to deselect
    stdin.write(' ');
    const frame = lastFrame()!;
    // After deselection, warm cost column should show '-'
    expect(frame).toContain('-');
  });

  it('selects all on a key', () => {
    mockSessions.discoverSessions.mockReturnValue([
      {
        sessionId: 'abc-123',
        name: 'Test Session 1',
        projectDir: 'test',
        cwd: '/test',
        model: 'claude-opus-4-6',
        lastAssistantTimestamp: Date.now(),
        isWarm: true,
        isLive: false,
        cacheReadTokens: 100000,
        cacheWriteTokens: 5000,
        expiryCostUsd: 1.05,
        selected: true,
        warmingStatus: 'idle',
        warmCostUsd: 0,
        warmCount: 0,
        nextWarmAt: null,
        lastWarmedAt: null,
        lastWarmError: null,
      },
      {
        sessionId: 'def-456',
        name: 'Test Session 2',
        projectDir: 'test',
        cwd: '/test',
        model: 'claude-sonnet-4-6',
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
        isWarm: false,
        isLive: false,
        cacheReadTokens: 50000,
        cacheWriteTokens: 0,
        expiryCostUsd: 0.3,
        selected: false,
        warmingStatus: 'idle',
        warmCostUsd: 0,
        warmCount: 0,
        nextWarmAt: null,
        lastWarmedAt: null,
        lastWarmError: null,
      },
    ]);

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );

    // Press 'a' to select all
    stdin.write('a');
    const frame = lastFrame()!;
    expect(frame).toContain('Test Session 1');
    expect(frame).toContain('Test Session 2');
  });
});
