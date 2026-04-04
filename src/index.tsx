#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { App } from './app.js';

const { values } = parseArgs({
  options: {
    interval: { type: 'string', short: 'i', default: '55' },
    prompt: { type: 'string', default: "Reply 'ok'" },
    model: { type: 'string', default: 'claude-sonnet-4-6' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`
Claude Cache Warmer - Keep Claude Code session caches alive

Usage: claude-cache-warmer [options]

Options:
  -i, --interval <minutes>  Warming interval in minutes (default: 55)
  --prompt <string>         Custom warm prompt (default: "Reply with only the word OK")
  --model <model>           Default model for pricing (default: "claude-sonnet-4-6")
  -h, --help                Show this help message
`);
  process.exit(0);
}

const intervalMinutes = parseInt(values.interval!, 10);
if (isNaN(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 59) {
  console.error('Error: interval must be between 1 and 59 minutes');
  process.exit(1);
}

process.stdout.write('\x1B[2J\x1B[H');

render(
  <App
    intervalMinutes={intervalMinutes}
    warmPrompt={values.prompt!}
    defaultModel={values.model!}
  />,
);
