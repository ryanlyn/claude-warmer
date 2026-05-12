import React from 'react';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { render } from 'ink-testing-library';
import { Footer } from '../../src/components/footer.tsx';

describe({
  name: 'Footer',
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  it('renders keybinding help text', () => {
    const r = render(<Footer />);
    const frame = r.lastFrame()!;
    expect(frame).toContain('toggle');
    expect(frame).toContain('warm');
    expect(frame).toContain('live');
    expect(frame).toContain('none');
    expect(frame).toContain('prompt');
    expect(frame).toContain('copy');
    expect(frame).toContain('quit');
    r.unmount();
  });
});
