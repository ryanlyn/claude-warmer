import { parseArgs } from 'node:util';

export interface ParsedCliArgs {
  intervalMinutes: number;
  warmPrompt: string;
  initialAutoEnabled: boolean;
  initialWarmingEnabled: boolean;
  help: boolean;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const HELP_TEXT = `
Claude Warmer - Keep Claude Code session caches alive

Usage: claude-warmer [options]

Options:
  -i, --interval <minutes>  Warming interval in minutes (default: 55)
  --prompt <string>         Custom warm prompt (default: "Reply 'ok'")
  -h, --help                Show this help message
`;

export function parseCliArgs(args: string[] = process.argv.slice(2)): ParsedCliArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        interval: { type: 'string', short: 'i', default: '55' },
        prompt: { type: 'string', default: "Reply 'ok'" },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    });
  } catch (error) {
    throw new CliUsageError((error as Error).message);
  }

  const { values } = parsed;

  if (values.help) {
    return {
      intervalMinutes: 55,
      warmPrompt: values.prompt!,
      initialAutoEnabled: true,
      initialWarmingEnabled: true,
      help: true,
    };
  }

  const intervalMinutes = parseInt(values.interval!, 10);
  if (isNaN(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 59) {
    throw new CliUsageError('interval must be between 1 and 59 minutes');
  }

  return {
    intervalMinutes,
    warmPrompt: values.prompt!,
    initialAutoEnabled: true,
    initialWarmingEnabled: true,
    help: false,
  };
}
