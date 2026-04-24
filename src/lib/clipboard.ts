import { execSync } from 'node:child_process';

/**
 * Copy text to the system clipboard using the platform's native provider.
 * Best-effort: silently swallows errors so the caller never has to branch.
 */
export function copyToClipboard(text: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync('pbcopy', { input: text });
      return;
    }
    if (process.platform === 'win32') {
      execSync('clip', { input: text });
      return;
    }
    try {
      execSync('wl-copy', { input: text });
    } catch {
      execSync('xclip -selection clipboard', { input: text });
    }
  } catch {
    // No clipboard provider available. Swallow — this is best-effort UX.
  }
}
