import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Footer } from '../../src/components/footer.js';

describe('Footer', () => {
  it('renders keybinding help text', () => {
    const { lastFrame } = render(<Footer />);
    const frame = lastFrame()!;
    expect(frame).toContain('space');
    expect(frame).toContain('toggle');
    expect(frame).toContain('enter');
    expect(frame).toContain('warm');
    expect(frame).toContain('active');
    expect(frame).toContain('prompt');
    expect(frame).toContain('copy id');
    expect(frame).toContain('quit');
  });
});
