import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { copyToClipboard } from '../../src/lib/clipboard.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const originalPlatform = process.platform;

function stubPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('copyToClipboard', () => {
  const mockExecSync = vi.mocked(childProcess.execSync);

  beforeEach(() => {
    mockExecSync.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('uses pbcopy on darwin', () => {
    stubPlatform('darwin');
    mockExecSync.mockReturnValue(Buffer.from(''));
    copyToClipboard('hello');
    expect(mockExecSync).toHaveBeenCalledWith('pbcopy', { input: 'hello' });
  });

  it('uses clip on win32', () => {
    stubPlatform('win32');
    mockExecSync.mockReturnValue(Buffer.from(''));
    copyToClipboard('hello');
    expect(mockExecSync).toHaveBeenCalledWith('clip', { input: 'hello' });
  });

  it('uses wl-copy on linux when available', () => {
    stubPlatform('linux');
    mockExecSync.mockReturnValue(Buffer.from(''));
    copyToClipboard('hello');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('wl-copy', { input: 'hello' });
  });

  it('falls back to xclip when wl-copy is missing', () => {
    stubPlatform('linux');
    mockExecSync
      .mockImplementationOnce(() => {
        throw new Error('wl-copy not found');
      })
      .mockReturnValueOnce(Buffer.from(''));
    copyToClipboard('hello');
    expect(mockExecSync).toHaveBeenNthCalledWith(1, 'wl-copy', { input: 'hello' });
    expect(mockExecSync).toHaveBeenNthCalledWith(2, 'xclip -selection clipboard', { input: 'hello' });
  });

  it('swallows errors when no provider works', () => {
    stubPlatform('linux');
    mockExecSync.mockImplementation(() => {
      throw new Error('nothing installed');
    });
    expect(() => copyToClipboard('hello')).not.toThrow();
  });

  it('swallows errors on darwin too', () => {
    stubPlatform('darwin');
    mockExecSync.mockImplementation(() => {
      throw new Error('pbcopy missing');
    });
    expect(() => copyToClipboard('hello')).not.toThrow();
  });
});
