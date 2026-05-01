#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { execFileSync } from 'node:child_process';
import { App } from './app.js';
import { CliUsageError, HELP_TEXT, parseCliArgs, type ParsedCliArgs } from './lib/cli.js';

let cli: ParsedCliArgs;
try {
  cli = parseCliArgs();
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

if (cli.help) {
  console.log(HELP_TEXT);
  process.exit(0);
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

render(
  <App
    intervalMinutes={cli.intervalMinutes}
    warmPrompt={cli.warmPrompt}
    initialAutoEnabled={cli.initialAutoEnabled}
    initialWarmingEnabled={cli.initialWarmingEnabled}
  />,
);
