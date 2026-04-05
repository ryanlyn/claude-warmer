import { execFile } from 'node:child_process';
import type { WarmResult, SessionUsage } from './types.js';
import { calcWarmCost } from './pricing.js';

interface ParsedOutput {
  usage: SessionUsage;
  model: string;
  error: string | null;
}

export function parseWarmOutput(stdout: string): ParsedOutput {
  const emptyUsage: SessionUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 };

  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { usage: emptyUsage, model: '', error: `Failed to parse CLI output: ${stdout.slice(0, 100)}` };
  }

  // Output is a JSON array of events. Find the result and assistant entries.
  const entries = Array.isArray(data) ? data : [data];
  const resultEntry = entries.find((e: Record<string, unknown>) => e.type === 'result') as Record<string, unknown> | undefined;
  const assistantEntry = entries.find((e: Record<string, unknown>) => e.type === 'assistant') as Record<string, unknown> | undefined;

  const model = (assistantEntry?.message as Record<string, unknown>)?.model as string || '';

  if (!resultEntry) {
    return { usage: emptyUsage, model, error: 'No result entry in response' };
  }

  const usage = resultEntry.usage as Record<string, number> | undefined;
  if (!usage) {
    return { usage: emptyUsage, model, error: 'No usage data in response' };
  }

  return {
    usage: {
      inputTokens: usage.input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    },
    model,
    error: null,
  };
}

export function warmSession(sessionId: string, warmPrompt: string, cwd?: string): Promise<WarmResult> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['-p', warmPrompt, '--resume', sessionId, '--output-format', 'json'],
      { timeout: 60_000, cwd: cwd || undefined },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            sessionId,
            usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
            model: '',
            costUsd: 0,
            error: error.message + (stderr ? `: ${stderr.slice(0, 200)}` : ''),
          });
          return;
        }

        const parsed = parseWarmOutput(stdout);
        const model = parsed.model;
        const costUsd = parsed.error ? 0 : calcWarmCost(parsed.usage, model);

        resolve({
          sessionId,
          usage: parsed.usage,
          model,
          costUsd,
          error: parsed.error,
        });
      },
    );
  });
}
