import { execFile } from 'node:child_process';
import type { WarmResult, SessionUsage } from './types.js';
import { calcWarmCost } from './pricing.js';

interface ParsedOutput {
  usage: SessionUsage;
  model: string;
  error: string | null;
}

export function parseWarmOutput(stdout: string): ParsedOutput {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
      model: '',
      error: `Failed to parse CLI output: ${stdout.slice(0, 100)}`,
    };
  }

  const usage = parsed.usage as Record<string, number> | undefined;
  if (!usage) {
    return {
      usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
      model: (parsed.model as string) || '',
      error: 'No usage data in response',
    };
  }

  return {
    usage: {
      inputTokens: usage.input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    },
    model: (parsed.model as string) || '',
    error: null,
  };
}

export function warmSession(sessionId: string, warmPrompt: string): Promise<WarmResult> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['-p', warmPrompt, '--resume', sessionId, '--output-format', 'json'],
      { timeout: 60_000 },
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
