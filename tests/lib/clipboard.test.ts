import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { spy } from '@std/testing/mock';
import { Buffer } from 'node:buffer';
import { copyToClipboard, type ExecSyncFn } from '../../src/lib/clipboard.ts';

let calls: { cmd: string; input: string }[] = [];
let plan: Array<{ throwMsg?: string } | undefined> = [];

function makeExec(): ExecSyncFn {
  return (cmd, options) => {
    const step = plan.shift();
    calls.push({ cmd, input: options.input });
    if (step?.throwMsg) {
      throw new Error(step.throwMsg);
    }
    return Buffer.from('');
  };
}

describe('copyToClipboard', () => {
  beforeEach(() => {
    calls = [];
    plan = [];
  });

  afterEach(() => {
    calls = [];
    plan = [];
  });

  it('uses pbcopy on darwin', () => {
    plan = [{}];
    copyToClipboard('hello', { exec: makeExec(), platform: 'darwin' });
    expect(calls).toEqual([{ cmd: 'pbcopy', input: 'hello' }]);
  });

  it('uses clip on win32', () => {
    plan = [{}];
    copyToClipboard('hello', { exec: makeExec(), platform: 'win32' });
    expect(calls).toEqual([{ cmd: 'clip', input: 'hello' }]);
  });

  it('uses wl-copy on linux when available', () => {
    plan = [{}];
    copyToClipboard('hello', { exec: makeExec(), platform: 'linux' });
    expect(calls).toEqual([{ cmd: 'wl-copy', input: 'hello' }]);
  });

  it('falls back to xclip when wl-copy is missing', () => {
    plan = [{ throwMsg: 'wl-copy not found' }, {}];
    copyToClipboard('hello', { exec: makeExec(), platform: 'linux' });
    expect(calls).toEqual([
      { cmd: 'wl-copy', input: 'hello' },
      { cmd: 'xclip -selection clipboard', input: 'hello' },
    ]);
  });

  it('swallows errors when no provider works', () => {
    plan = [{ throwMsg: 'wl-copy missing' }, { throwMsg: 'xclip missing' }];
    expect(() => copyToClipboard('hello', { exec: makeExec(), platform: 'linux' })).not.toThrow();
  });

  it('swallows errors on darwin too', () => {
    plan = [{ throwMsg: 'pbcopy missing' }];
    expect(() => copyToClipboard('hello', { exec: makeExec(), platform: 'darwin' })).not.toThrow();
  });

  it('defaults to the live execSync + process.platform when no deps are passed', () => {
    // Just verify the no-op path runs without throwing when the platform's
    // clipboard provider isn't installed - matches the "best-effort" contract.
    const exec = spy(() => {
      throw new Error('no clipboard');
    });
    expect(() => copyToClipboard('hello', { exec: exec as unknown as ExecSyncFn })).not.toThrow();
    expect(exec.calls.length).toBeGreaterThan(0);
  });
});
