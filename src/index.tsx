#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { App } from './app.js';

const { values } = parseArgs({
  options: {
    interval: { type: 'string', short: 'i', default: '55' },
    prompt: { type: 'string', default: "Reply 'ok'" },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`
Claude Warmer - Keep Claude Code session caches alive

Usage: claude-warmer [options]

Options:
  -i, --interval <minutes>  Warming interval in minutes (default: 55)
  --prompt <string>         Custom warm prompt (default: "Reply 'ok'")
  -h, --help                Show this help message
`);
  process.exit(0);
}

const intervalMinutes = parseInt(values.interval!, 10);
if (isNaN(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 59) {
  console.error('Error: interval must be between 1 and 59 minutes');
  process.exit(1);
}

// CLAUDE_PATH is an integration-test escape hatch that also lets advanced users
// point at a non-PATH binary. Skip the availability probe in that case.
if (!process.env.CLAUDE_PATH) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, ['claude'], { stdio: 'ignore' });
  } catch {
    console.error(
      "Error: 'claude' CLI not found in PATH.\n\n" +
        'claude-warmer resumes your Claude Code sessions, so it needs the\n' +
        '`claude` CLI installed and authenticated. Install it first:\n' +
        '  https://docs.claude.com/en/docs/claude-code/setup\n',
    );
    process.exit(1);
  }
}

process.stdout.write('\x1B[2J\x1B[H');

render(<App intervalMinutes={intervalMinutes} warmPrompt={values.prompt!} />);
