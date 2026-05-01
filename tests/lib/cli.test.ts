import { describe, expect, it } from 'vitest';
import { CliUsageError, parseCliArgs } from '../../src/lib/cli.js';

describe('parseCliArgs', () => {
  it('uses auto warming mode by default', () => {
    expect(parseCliArgs([])).toMatchObject({
      intervalMinutes: 55,
      warmPrompt: "Reply 'ok'",
      initialAutoEnabled: true,
      initialWarmingEnabled: true,
      help: false,
    });
  });

  it('parses interval and prompt while staying in default auto mode', () => {
    expect(parseCliArgs(['--interval', '10', '--prompt', 'ping'])).toMatchObject({
      intervalMinutes: 10,
      warmPrompt: 'ping',
      initialAutoEnabled: true,
      initialWarmingEnabled: true,
    });
  });

  it('reports help without validating interval', () => {
    expect(parseCliArgs(['--help', '--interval', 'not-a-number'])).toMatchObject({ help: true });
  });

  it('rejects the removed auto-start flags with usage errors', () => {
    expect(() => parseCliArgs(['-f'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['--follow'])).toThrow(CliUsageError);
  });

  it('throws a usage error for invalid intervals', () => {
    expect(() => parseCliArgs(['--interval', '0'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['--interval', '60'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['--interval', 'abc'])).toThrow(CliUsageError);
  });
});
