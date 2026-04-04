import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Header } from '../../src/components/header.js';

describe('Header', () => {
  it('shows app name', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={55} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('Claude Warmer');
  });

  it('shows paused state', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={55} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('paused');
  });

  it('shows active state', () => {
    const { lastFrame } = render(
      <Header warming={true} intervalMinutes={55} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('active');
  });

  it('shows configured interval', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={30} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('30');
  });

  it('shows warm prompt', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={55} warmPrompt="Say hi" />,
    );
    expect(lastFrame()!).toContain('Say hi');
  });
});
