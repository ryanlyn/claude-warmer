import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Footer } from '../../src/components/footer.js';

describe('Footer', () => {
  it('renders keybinding help text', () => {
    const { lastFrame } = render(<Footer />);
    const frame = lastFrame()!;
    expect(frame).toContain('toggle');
    expect(frame).toContain('warm');
    expect(frame).toContain('live');
    expect(frame).toContain('none');
    expect(frame).toContain('prompt');
    expect(frame).toContain('copy');
    expect(frame).toContain('quit');
  });
});
