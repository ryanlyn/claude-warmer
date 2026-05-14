import { execSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';

export type ExecSyncFn = (
  cmd: string,
  options: { input: string },
) => Buffer | string;

export interface ClipboardDeps {
  exec?: ExecSyncFn;
  platform?: NodeJS.Platform;
}

/**
 * Copy text to the system clipboard using the platform's native provider.
 * Best-effort: silently swallows errors so the caller never has to branch.
 *
 * Accepts an optional `deps` bag so tests can stub the underlying execSync
 * and platform without patching the node:child_process module at runtime.
 */
export function copyToClipboard(text: string, deps: ClipboardDeps = {}): void {
  const exec = deps.exec ?? (execSync as unknown as ExecSyncFn);
  const platform = deps.platform ?? (process.platform as NodeJS.Platform);
  try {
    if (platform === 'darwin') {
      exec('pbcopy', { input: text });
      return;
    }
    if (platform === 'win32') {
      exec('clip', { input: text });
      return;
    }
    try {
      exec('wl-copy', { input: text });
    } catch {
      exec('xclip -selection clipboard', { input: text });
    }
  } catch {
    // No clipboard provider available. Swallow - this is best-effort UX.
  }
}
