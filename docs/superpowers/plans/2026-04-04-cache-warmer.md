# Claude Cache Warmer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Ink TUI that keeps Claude Code session caches warm by periodically resuming sessions with minimal prompts before the 1-hour cache TTL expires.

**Architecture:** Single-process Node.js app using Ink v5 (React for CLI). Scans `~/.claude/projects/` JSONL transcripts and `~/.claude/sessions/` PID files to discover sessions. Spawns `claude -p --resume <id> --output-format json` child processes on a staggered schedule to keep caches alive. All state is in-memory React state.

**Tech Stack:** TypeScript ESM, Ink v5, @inkjs/ui, vitest, tsx, tsup, Node.js >= 18

---

## File Map

```
claude-cache-warmer/
  package.json              # Dependencies, bin entry, scripts
  tsconfig.json             # TypeScript config (ESM, JSX)
  vitest.config.ts          # Vitest config with coverage
  src/
    index.tsx               # CLI entry point, arg parsing, render(<App>)
    app.tsx                 # Root <App> component, wires state + scheduler
    components/
      header.tsx            # App name, warming status, interval, prompt
      session-table.tsx     # Table with keyboard nav, selection, scrolling
      session-row.tsx       # Single row with all columns + visual indicators
      footer.tsx            # Keybinding help bar
    lib/
      types.ts              # Session interface, WarmResult, config types
      pricing.ts            # Model pricing map, cost calculation functions
      sessions.ts           # JSONL + PID file scanning, session discovery
      scheduler.ts          # Bootstrap + steady-state warm scheduling
      warmer.ts             # Spawn claude CLI, parse JSON output
  tests/
    lib/
      pricing.test.ts
      sessions.test.ts
      scheduler.test.ts
      warmer.test.ts
    components/
      header.test.tsx
      footer.test.tsx
      session-row.test.tsx
      session-table.test.tsx
      app.test.tsx
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/ryan/dev/claude-cache-warmer
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install ink@5 react@18 @inkjs/ui
npm install -D typescript @types/react tsx tsup vitest @vitest/coverage-v8 ink-testing-library
```

- [ ] **Step 3: Create package.json overrides**

Edit `package.json` to set these fields:

```json
{
  "name": "claude-cache-warmer",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "claude-cache-warmer": "./dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.tsx",
    "build": "tsup src/index.tsx --format esm --dts --clean",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/index.tsx'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
```

- [ ] **Step 6: Verify setup compiles**

```bash
npx tsc --noEmit
```

Expected: No errors (no source files yet, should succeed).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "scaffold: init project with ink, typescript, vitest"
```

---

### Task 2: Types

**Files:**
- Create: `src/lib/types.ts`

- [ ] **Step 1: Create the shared types file**

```typescript
export interface SessionUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

export type WarmingStatus = 'idle' | 'warming' | 'success' | 'error';

export interface Session {
  sessionId: string;
  name: string;
  projectDir: string;
  cwd: string;
  model: string;
  lastAssistantTimestamp: number;
  isWarm: boolean;
  isLive: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  expiryCostUsd: number;
  selected: boolean;
  warmingStatus: WarmingStatus;
  warmCostUsd: number;
  warmCount: number;
  nextWarmAt: number | null;
  lastWarmedAt: number | null;
  lastWarmError: string | null;
}

export interface WarmResult {
  sessionId: string;
  usage: SessionUsage;
  model: string;
  costUsd: number;
  error: string | null;
}

export interface AppConfig {
  intervalMinutes: number;
  warmPrompt: string;
  defaultModel: string;
}

export const WARM_THRESHOLD_MS = 55 * 60 * 1000;
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add shared type definitions"
```

---

### Task 3: Pricing module

**Files:**
- Create: `src/lib/pricing.ts`
- Create: `tests/lib/pricing.test.ts`

- [ ] **Step 1: Write failing tests for pricing**

Create `tests/lib/pricing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  getModelPricing,
  calcExpiryCost,
  calcWarmCost,
  formatUsd,
  shortenModelName,
} from '../../src/lib/pricing.js';

describe('getModelPricing', () => {
  it('returns opus 4.6 pricing', () => {
    const p = getModelPricing('claude-opus-4-6');
    expect(p.baseInputPerM).toBe(5);
    expect(p.outputPerM).toBe(25);
  });

  it('returns opus 4.5 pricing', () => {
    const p = getModelPricing('claude-opus-4-5');
    expect(p.baseInputPerM).toBe(5);
    expect(p.outputPerM).toBe(25);
  });

  it('returns sonnet 4.6 pricing', () => {
    const p = getModelPricing('claude-sonnet-4-6');
    expect(p.baseInputPerM).toBe(3);
    expect(p.outputPerM).toBe(15);
  });

  it('returns sonnet 4.5 pricing', () => {
    const p = getModelPricing('claude-sonnet-4-5');
    expect(p.baseInputPerM).toBe(3);
  });

  it('returns sonnet 4 pricing', () => {
    const p = getModelPricing('claude-sonnet-4-20250514');
    expect(p.baseInputPerM).toBe(3);
  });

  it('returns haiku 4.5 pricing', () => {
    const p = getModelPricing('claude-haiku-4-5-20251001');
    expect(p.baseInputPerM).toBe(1);
    expect(p.outputPerM).toBe(5);
  });

  it('falls back to sonnet pricing for unknown models', () => {
    const p = getModelPricing('claude-unknown-99');
    expect(p.baseInputPerM).toBe(3);
  });
});

describe('calcExpiryCost', () => {
  it('computes 1h cache write cost for opus', () => {
    // 100k tokens at opus $5 base * 2x = $10/MTok = $1.00
    const cost = calcExpiryCost(100_000, 'claude-opus-4-6');
    expect(cost).toBeCloseTo(1.0);
  });

  it('computes 1h cache write cost for sonnet', () => {
    // 100k tokens at sonnet $3 base * 2x = $6/MTok = $0.60
    const cost = calcExpiryCost(100_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(0.6);
  });

  it('returns 0 for 0 tokens', () => {
    expect(calcExpiryCost(0, 'claude-opus-4-6')).toBe(0);
  });
});

describe('calcWarmCost', () => {
  it('computes cost for a warm session (cache reads only)', () => {
    // 100k read at opus $5 * 0.1 = $0.50/MTok = $0.05
    // 10 output at opus $25/MTok = negligible
    const cost = calcWarmCost(
      { inputTokens: 0, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 0, outputTokens: 10 },
      'claude-opus-4-6',
    );
    expect(cost).toBeCloseTo(0.05025);
  });

  it('computes cost for a cold session (cache write)', () => {
    // 100k write at opus $5 * 2 = $10/MTok = $1.00
    const cost = calcWarmCost(
      { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 100_000, outputTokens: 10 },
      'claude-opus-4-6',
    );
    expect(cost).toBeCloseTo(1.00025);
  });

  it('computes mixed read/write cost', () => {
    // 50k read at sonnet $3 * 0.1 = $0.30/MTok -> $0.015
    // 10k write at sonnet $3 * 2 = $6/MTok -> $0.06
    // 5 output at sonnet $15/MTok -> negligible
    const cost = calcWarmCost(
      { inputTokens: 0, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 10_000, outputTokens: 5 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.075075);
  });
});

describe('formatUsd', () => {
  it('formats small amounts', () => {
    expect(formatUsd(0.05)).toBe('$0.05');
  });

  it('formats zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('formats larger amounts', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});

describe('shortenModelName', () => {
  it('strips claude- prefix', () => {
    expect(shortenModelName('claude-opus-4-6')).toBe('opus-4-6');
  });

  it('strips date suffix', () => {
    expect(shortenModelName('claude-sonnet-4-20250514')).toBe('sonnet-4');
  });

  it('strips claude- prefix and date suffix', () => {
    expect(shortenModelName('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
  });

  it('returns as-is if no prefix', () => {
    expect(shortenModelName('unknown-model')).toBe('unknown-model');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/pricing.test.ts
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement pricing module**

Create `src/lib/pricing.ts`:

```typescript
import type { SessionUsage } from './types.js';

interface ModelPricing {
  baseInputPerM: number;
  outputPerM: number;
}

const PRICING: { pattern: RegExp; pricing: ModelPricing }[] = [
  { pattern: /opus-4-[56]/, pricing: { baseInputPerM: 5, outputPerM: 25 } },
  { pattern: /opus-4(?:-|$)/, pricing: { baseInputPerM: 15, outputPerM: 75 } },
  { pattern: /sonnet/, pricing: { baseInputPerM: 3, outputPerM: 15 } },
  { pattern: /haiku-4-5/, pricing: { baseInputPerM: 1, outputPerM: 5 } },
  { pattern: /haiku-3-5/, pricing: { baseInputPerM: 0.8, outputPerM: 4 } },
  { pattern: /haiku/, pricing: { baseInputPerM: 1, outputPerM: 5 } },
];

const DEFAULT_PRICING: ModelPricing = { baseInputPerM: 3, outputPerM: 15 };

const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

export function getModelPricing(model: string): ModelPricing {
  for (const entry of PRICING) {
    if (entry.pattern.test(model)) {
      return entry.pricing;
    }
  }
  return DEFAULT_PRICING;
}

export function calcExpiryCost(cachedTokens: number, model: string): number {
  const { baseInputPerM } = getModelPricing(model);
  return (cachedTokens * baseInputPerM * CACHE_WRITE_1H_MULTIPLIER) / 1_000_000;
}

export function calcWarmCost(usage: SessionUsage, model: string): number {
  const { baseInputPerM, outputPerM } = getModelPricing(model);
  const readCost = (usage.cacheReadInputTokens * baseInputPerM * CACHE_READ_MULTIPLIER) / 1_000_000;
  const writeCost = (usage.cacheCreationInputTokens * baseInputPerM * CACHE_WRITE_1H_MULTIPLIER) / 1_000_000;
  const outputCost = (usage.outputTokens * outputPerM) / 1_000_000;
  return readCost + writeCost + outputCost;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function shortenModelName(model: string): string {
  let short = model.replace(/^claude-/, '');
  short = short.replace(/-\d{8}$/, '');
  return short;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/pricing.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricing.ts tests/lib/pricing.test.ts
git commit -m "feat: add pricing module with model lookup and cost calculation"
```

---

### Task 4: Session discovery

**Files:**
- Create: `src/lib/sessions.ts`
- Create: `tests/lib/sessions.test.ts`

- [ ] **Step 1: Write failing tests for session discovery**

Create `tests/lib/sessions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverSessions, parseJsonlFile, checkPidAlive } from '../../src/lib/sessions.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

beforeEach(() => {
  vi.resetAllMocks();
  mockOs.homedir.mockReturnValue('/mock-home');
});

describe('parseJsonlFile', () => {
  it('extracts session data from valid JSONL', () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'My Session', sessionId: 'abc-123' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 100000,
            cache_creation_input_tokens: 5000,
            output_tokens: 50,
          },
        },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'Fix the login bug', sessionId: 'abc-123' }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result.name).toBe('My Session');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.cacheReadTokens).toBe(100000);
    expect(result.cacheWriteTokens).toBe(5000);
    expect(result.lastAssistantTimestamp).toBe(new Date('2026-04-04T17:00:00.000Z').getTime());
  });

  it('falls back to lastPrompt if no custom title', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'A very long prompt that should be truncated after fifty characters for display purposes', sessionId: 'def-456' }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'def-456');
    expect(result.name.length).toBeLessThanOrEqual(53); // 50 + "..."
  });

  it('falls back to sessionId if no title and no lastPrompt', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'def-456-789');
    expect(result.name).toBe('def-456-789');
  });

  it('skips corrupted lines without crashing', () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'Good Session', sessionId: 'abc-123' }),
      'THIS IS NOT JSON {{{',
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, output_tokens: 10 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result.name).toBe('Good Session');
    expect(result.cacheReadTokens).toBe(50000);
  });

  it('returns null if no assistant messages found', () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'Empty', sessionId: 'abc-123' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-04-04T17:00:00.000Z' }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result).toBeNull();
  });

  it('uses the last assistant message for usage data', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, output_tokens: 5 } },
        timestamp: '2026-04-04T16:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000, output_tokens: 20 } },
        timestamp: '2026-04-04T17:00:00.000Z',
      }),
    ].join('\n');

    const result = parseJsonlFile(lines, 'abc-123');
    expect(result!.cacheReadTokens).toBe(90000);
    expect(result!.cacheWriteTokens).toBe(5000);
    expect(result!.lastAssistantTimestamp).toBe(new Date('2026-04-04T17:00:00.000Z').getTime());
  });
});

describe('checkPidAlive', () => {
  it('returns true for a live process', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(checkPidAlive(12345)).toBe(true);
  });

  it('returns false for a dead process', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(checkPidAlive(99999)).toBe(false);
  });
});

describe('discoverSessions', () => {
  it('returns empty array when no project dirs exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    const sessions = discoverSessions('claude-sonnet-4-6');
    expect(sessions).toEqual([]);
  });

  it('discovers sessions from JSONL files and cross-references PID files', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation((dirPath: fs.PathLike) => {
      const p = dirPath.toString();
      if (p.endsWith('/projects')) {
        return ['my-project'] as unknown as fs.Dirent[];
      }
      if (p.includes('my-project')) {
        return ['abc-123.jsonl'] as unknown as fs.Dirent[];
      }
      if (p.endsWith('/sessions')) {
        return ['999.json'] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    });
    mockFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const p = filePath.toString();
      if (p.endsWith('abc-123.jsonl')) {
        return [
          JSON.stringify({ type: 'custom-title', customTitle: 'Test Session', sessionId: 'abc-123' }),
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, cache_read_input_tokens: 80000, cache_creation_input_tokens: 2000, output_tokens: 10 } },
            timestamp: new Date().toISOString(),
          }),
        ].join('\n');
      }
      if (p.endsWith('999.json')) {
        return JSON.stringify({ pid: 999, sessionId: 'abc-123', cwd: '/home/user/project', startedAt: Date.now(), kind: 'interactive' });
      }
      return '';
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const sessions = discoverSessions('claude-sonnet-4-6');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('abc-123');
    expect(sessions[0].name).toBe('Test Session');
    expect(sessions[0].cwd).toBe('/home/user/project');
    expect(sessions[0].isLive).toBe(false);
    expect(sessions[0].isWarm).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/sessions.test.ts
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement session discovery**

Create `src/lib/sessions.ts`:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Session } from './types.js';
import { calcExpiryCost } from './pricing.js';
import { WARM_THRESHOLD_MS } from './types.js';

interface ParsedSession {
  name: string;
  model: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastAssistantTimestamp: number;
}

interface PidEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
}

export function checkPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseJsonlFile(content: string, sessionId: string): ParsedSession | null {
  let customTitle: string | null = null;
  let lastPrompt: string | null = null;
  let lastModel = '';
  let lastCacheRead = 0;
  let lastCacheWrite = 0;
  let lastTimestamp = 0;
  let hasAssistant = false;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      customTitle = record.customTitle;
    }

    if (record.type === 'last-prompt' && typeof record.lastPrompt === 'string') {
      lastPrompt = record.lastPrompt;
    }

    const msg = record.message as Record<string, unknown> | undefined;
    if (msg?.role === 'assistant' && msg.usage) {
      hasAssistant = true;
      const usage = msg.usage as Record<string, unknown>;
      lastModel = (msg.model as string) || lastModel;
      lastCacheRead = (usage.cache_read_input_tokens as number) || 0;
      lastCacheWrite = (usage.cache_creation_input_tokens as number) || 0;
      if (typeof record.timestamp === 'string') {
        lastTimestamp = new Date(record.timestamp).getTime();
      }
    }
  }

  if (!hasAssistant) return null;

  let name = customTitle || lastPrompt || sessionId;
  if (!customTitle && lastPrompt && lastPrompt.length > 50) {
    name = lastPrompt.slice(0, 50) + '...';
  }

  return {
    name,
    model: lastModel,
    cacheReadTokens: lastCacheRead,
    cacheWriteTokens: lastCacheWrite,
    lastAssistantTimestamp: lastTimestamp,
  };
}

function loadPidFiles(): Map<string, { cwd: string; pid: number; isLive: boolean }> {
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  const map = new Map<string, { cwd: string; pid: number; isLive: boolean }>();

  if (!fs.existsSync(sessionsDir)) return map;

  for (const file of fs.readdirSync(sessionsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
      const entry: PidEntry = JSON.parse(content);
      const isLive = checkPidAlive(entry.pid);
      map.set(entry.sessionId, { cwd: entry.cwd, pid: entry.pid, isLive });
    } catch {
      continue;
    }
  }

  return map;
}

export function discoverSessions(defaultModel: string): Session[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const pidMap = loadPidFiles();
  const sessions: Session[] = [];
  const now = Date.now();

  for (const projectDir of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, projectDir);
    let files: string[];
    try {
      files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      let content: string;
      try {
        content = fs.readFileSync(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }

      const parsed = parseJsonlFile(content, sessionId);
      if (!parsed) continue;

      const model = parsed.model || defaultModel;
      const cachedTokens = parsed.cacheReadTokens + parsed.cacheWriteTokens;
      const pidInfo = pidMap.get(sessionId);
      const isWarm = now - parsed.lastAssistantTimestamp < WARM_THRESHOLD_MS;

      sessions.push({
        sessionId,
        name: parsed.name,
        projectDir,
        cwd: pidInfo?.cwd || '',
        model,
        lastAssistantTimestamp: parsed.lastAssistantTimestamp,
        isWarm,
        isLive: pidInfo?.isLive || false,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheWriteTokens: parsed.cacheWriteTokens,
        expiryCostUsd: calcExpiryCost(cachedTokens, model),
        selected: isWarm,
        warmingStatus: 'idle',
        warmCostUsd: 0,
        warmCount: 0,
        nextWarmAt: null,
        lastWarmedAt: null,
        lastWarmError: null,
      });
    }
  }

  sessions.sort((a, b) => {
    const aCached = a.cacheReadTokens + a.cacheWriteTokens;
    const bCached = b.cacheReadTokens + b.cacheWriteTokens;
    return bCached - aCached;
  });

  return sessions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/sessions.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessions.ts tests/lib/sessions.test.ts
git commit -m "feat: add session discovery from JSONL transcripts and PID files"
```

---

### Task 5: Warmer module

**Files:**
- Create: `src/lib/warmer.ts`
- Create: `tests/lib/warmer.test.ts`

- [ ] **Step 1: Write failing tests for warmer**

Create `tests/lib/warmer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { warmSession, parseWarmOutput } from '../../src/lib/warmer.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process');

const mockCp = vi.mocked(child_process);

describe('parseWarmOutput', () => {
  it('parses valid JSON output with usage', () => {
    const output = JSON.stringify({
      result: 'OK',
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 100000,
        cache_creation_input_tokens: 500,
        output_tokens: 5,
      },
    });

    const result = parseWarmOutput(output);
    expect(result.usage.cacheReadInputTokens).toBe(100000);
    expect(result.usage.cacheCreationInputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.error).toBeNull();
  });

  it('handles JSON with missing usage fields gracefully', () => {
    const output = JSON.stringify({
      result: 'OK',
      model: 'claude-opus-4-6',
      usage: {},
    });

    const result = parseWarmOutput(output);
    expect(result.usage.cacheReadInputTokens).toBe(0);
    expect(result.usage.cacheCreationInputTokens).toBe(0);
    expect(result.error).toBeNull();
  });

  it('returns error for invalid JSON', () => {
    const result = parseWarmOutput('NOT JSON AT ALL');
    expect(result.error).toContain('Failed to parse');
  });

  it('returns error for JSON without usage', () => {
    const output = JSON.stringify({ result: 'OK' });
    const result = parseWarmOutput(output);
    expect(result.error).toContain('No usage data');
  });
});

describe('warmSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('spawns claude CLI and returns parsed result on success', async () => {
    const jsonOutput = JSON.stringify({
      result: 'OK',
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 80000,
        cache_creation_input_tokens: 1000,
        output_tokens: 3,
      },
    });

    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, jsonOutput, '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('abc-123', 'Reply with only the word OK');
    expect(result.sessionId).toBe('abc-123');
    expect(result.usage.cacheReadInputTokens).toBe(80000);
    expect(result.error).toBeNull();
  });

  it('returns error when CLI fails', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('Command failed'), '', 'session not found');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('bad-id', 'Reply with only the word OK');
    expect(result.error).toContain('Command failed');
  });

  it('returns error on timeout', async () => {
    mockCp.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error('TIMEOUT') as NodeJS.ErrnoException;
      err.killed = true;
      (callback as Function)(err, '', '');
      return {} as child_process.ChildProcess;
    });

    const result = await warmSession('timeout-id', 'Reply with only the word OK');
    expect(result.error).toContain('TIMEOUT');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/warmer.test.ts
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement warmer**

Create `src/lib/warmer.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/warmer.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/warmer.ts tests/lib/warmer.test.ts
git commit -m "feat: add warmer module to spawn claude CLI and parse output"
```

---

### Task 6: Scheduler module

**Files:**
- Create: `src/lib/scheduler.ts`
- Create: `tests/lib/scheduler.test.ts`

- [ ] **Step 1: Write failing tests for scheduler**

Create `tests/lib/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/lib/scheduler.js';
import type { Session, WarmResult } from '../../src/lib/types.js';
import { WARM_THRESHOLD_MS } from '../../src/lib/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'test-id',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-sonnet-4-6',
    lastAssistantTimestamp: Date.now() - 10 * 60 * 1000, // 10 min ago
    isWarm: true,
    isLive: false,
    cacheReadTokens: 50000,
    cacheWriteTokens: 1000,
    expiryCostUsd: 0.3,
    selected: true,
    warmingStatus: 'idle',
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
    ...overrides,
  };
}

describe('Scheduler', () => {
  let mockWarmFn: ReturnType<typeof vi.fn>;
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWarmFn = vi.fn<(sessionId: string, prompt: string) => Promise<WarmResult>>().mockResolvedValue({
      sessionId: 'test-id',
      usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
      model: 'claude-sonnet-4-6',
      costUsd: 0.015,
      error: null,
    });
    scheduler = new Scheduler(mockWarmFn, 55);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  describe('bootstrap', () => {
    it('schedules a warm session within its valid window', () => {
      const session = makeSession({ lastAssistantTimestamp: Date.now() - 10 * 60 * 1000 });
      const result = scheduler.bootstrap([session]);

      expect(result).toHaveLength(1);
      const nextWarm = result[0].nextWarmAt!;
      const windowEnd = session.lastAssistantTimestamp + WARM_THRESHOLD_MS;
      expect(nextWarm).toBeGreaterThanOrEqual(Date.now());
      expect(nextWarm).toBeLessThanOrEqual(windowEnd);
    });

    it('schedules a cold session immediately (nextWarmAt <= now)', () => {
      const session = makeSession({
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
        isWarm: false,
      });
      const result = scheduler.bootstrap([session]);

      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt!).toBeLessThanOrEqual(Date.now());
    });

    it('skips live sessions', () => {
      const session = makeSession({ isLive: true });
      const result = scheduler.bootstrap([session]);
      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt).toBeNull();
    });

    it('skips deselected sessions', () => {
      const session = makeSession({ selected: false });
      const result = scheduler.bootstrap([session]);
      expect(result).toHaveLength(1);
      expect(result[0].nextWarmAt).toBeNull();
    });
  });

  describe('tick', () => {
    it('warms a session that is due', async () => {
      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const updated = await scheduler.tick([session], 'Reply with only the word OK');

      expect(mockWarmFn).toHaveBeenCalledWith('test-id', 'Reply with only the word OK');
      expect(updated[0].warmCount).toBe(1);
      expect(updated[0].warmingStatus).toBe('success');
      expect(updated[0].lastWarmedAt).toBeGreaterThan(0);
      expect(updated[0].nextWarmAt).toBe(updated[0].lastWarmedAt! + 55 * 60 * 1000);
    });

    it('does not warm a session that is not yet due', async () => {
      const session = makeSession({ nextWarmAt: Date.now() + 60_000 });
      await scheduler.tick([session], 'Reply with only the word OK');
      expect(mockWarmFn).not.toHaveBeenCalled();
    });

    it('marks session as error on warm failure', async () => {
      mockWarmFn.mockResolvedValueOnce({
        sessionId: 'test-id',
        usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        model: '',
        costUsd: 0,
        error: 'CLI failed',
      });

      const session = makeSession({ nextWarmAt: Date.now() - 1000 });
      const updated = await scheduler.tick([session], 'Reply with only the word OK');

      expect(updated[0].warmingStatus).toBe('error');
      expect(updated[0].lastWarmError).toBe('CLI failed');
      // Should still schedule next attempt
      expect(updated[0].nextWarmAt).toBeGreaterThan(Date.now());
    });

    it('warms sessions sequentially, not in parallel', async () => {
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      mockWarmFn.mockImplementation(async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await new Promise((r) => setTimeout(r, 10));
        concurrentCalls--;
        return {
          sessionId: 'x',
          usage: { inputTokens: 0, cacheReadInputTokens: 50000, cacheCreationInputTokens: 0, outputTokens: 3 },
          model: 'claude-sonnet-4-6',
          costUsd: 0.015,
          error: null,
        };
      });

      const sessions = [
        makeSession({ sessionId: 'a', nextWarmAt: Date.now() - 1000 }),
        makeSession({ sessionId: 'b', nextWarmAt: Date.now() - 500 }),
      ];

      await scheduler.tick(sessions, 'OK');
      expect(maxConcurrent).toBe(1);
    });
  });

  describe('addSession', () => {
    it('schedules a warm session within remaining window', () => {
      const session = makeSession({ nextWarmAt: null });
      const updated = scheduler.addSession(session);
      const windowEnd = session.lastAssistantTimestamp + WARM_THRESHOLD_MS;
      expect(updated.nextWarmAt!).toBeGreaterThanOrEqual(Date.now());
      expect(updated.nextWarmAt!).toBeLessThanOrEqual(windowEnd);
    });

    it('schedules a cold session immediately', () => {
      const session = makeSession({
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
        isWarm: false,
        nextWarmAt: null,
      });
      const updated = scheduler.addSession(session);
      expect(updated.nextWarmAt!).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('removeSession', () => {
    it('clears nextWarmAt', () => {
      const session = makeSession({ nextWarmAt: Date.now() + 60_000 });
      const updated = scheduler.removeSession(session);
      expect(updated.nextWarmAt).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/scheduler.test.ts
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement scheduler**

Create `src/lib/scheduler.ts`:

```typescript
import type { Session, WarmResult } from './types.js';
import { WARM_THRESHOLD_MS } from './types.js';
import { calcExpiryCost } from './pricing.js';

type WarmFn = (sessionId: string, prompt: string) => Promise<WarmResult>;

export class Scheduler {
  private warmFn: WarmFn;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(warmFn: WarmFn, intervalMinutes: number) {
    this.warmFn = warmFn;
    this.intervalMs = intervalMinutes * 60 * 1000;
  }

  bootstrap(sessions: Session[]): Session[] {
    const now = Date.now();
    return sessions.map((s) => {
      if (s.isLive || !s.selected) {
        return { ...s, nextWarmAt: null };
      }
      return { ...s, nextWarmAt: this.computeFirstWarmTime(s, now) };
    });
  }

  private computeFirstWarmTime(session: Session, now: number): number {
    const anchor = session.lastWarmedAt || session.lastAssistantTimestamp;
    const windowEnd = anchor + WARM_THRESHOLD_MS;

    if (windowEnd <= now) {
      // Cold session - warm immediately
      return now;
    }

    // Warm session - random point in [now, windowEnd]
    const remaining = windowEnd - now;
    return now + Math.floor(Math.random() * remaining);
  }

  async tick(sessions: Session[], warmPrompt: string): Promise<Session[]> {
    const now = Date.now();
    const updated = [...sessions];

    for (let i = 0; i < updated.length; i++) {
      const s = updated[i];
      if (!s.nextWarmAt || s.nextWarmAt > now || s.isLive || !s.selected) {
        continue;
      }

      updated[i] = { ...s, warmingStatus: 'warming' };

      const result = await this.warmFn(s.sessionId, warmPrompt);
      const warmTime = Date.now();

      if (result.error) {
        updated[i] = {
          ...updated[i],
          warmingStatus: 'error',
          lastWarmError: result.error,
          nextWarmAt: warmTime + this.intervalMs,
        };
      } else {
        updated[i] = {
          ...updated[i],
          warmingStatus: 'success',
          warmCount: s.warmCount + 1,
          warmCostUsd: s.warmCostUsd + result.costUsd,
          lastWarmedAt: warmTime,
          lastWarmError: null,
          nextWarmAt: warmTime + this.intervalMs,
          cacheReadTokens: result.usage.cacheReadInputTokens,
          cacheWriteTokens: result.usage.cacheCreationInputTokens,
          expiryCostUsd: calcExpiryCost(
            result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens,
            result.model || s.model,
          ),
          isWarm: true,
          model: result.model || s.model,
        };
      }
    }

    return updated;
  }

  addSession(session: Session): Session {
    const now = Date.now();
    return { ...session, nextWarmAt: this.computeFirstWarmTime(session, now) };
  }

  removeSession(session: Session): Session {
    return { ...session, nextWarmAt: null };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/scheduler.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler.ts tests/lib/scheduler.test.ts
git commit -m "feat: add warming scheduler with bootstrap and steady-state logic"
```

---

### Task 7: Footer component

**Files:**
- Create: `src/components/footer.tsx`
- Create: `tests/components/footer.test.tsx`

- [ ] **Step 1: Write failing test for footer**

Create `tests/components/footer.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Footer } from '../../src/components/footer.js';

describe('Footer', () => {
  it('renders keybinding help text', () => {
    const { lastFrame } = render(<Footer />);
    const frame = lastFrame()!;
    expect(frame).toContain('space/enter');
    expect(frame).toContain('toggle');
    expect(frame).toContain('warm');
    expect(frame).toContain('quit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/components/footer.test.tsx
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement footer**

Create `src/components/footer.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

function KeyHint({ keyName, label }: { keyName: string; label: string }) {
  return (
    <Box marginRight={2}>
      <Text bold color="cyan">{keyName}</Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

export function Footer() {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <KeyHint keyName="space/enter" label="toggle" />
      <KeyHint keyName="a" label="all" />
      <KeyHint keyName="n" label="none" />
      <KeyHint keyName="w" label="warm" />
      <KeyHint keyName="i" label="interval" />
      <KeyHint keyName="q" label="quit" />
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/components/footer.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/footer.tsx tests/components/footer.test.tsx
git commit -m "feat: add footer component with keybinding help"
```

---

### Task 8: Header component

**Files:**
- Create: `src/components/header.tsx`
- Create: `tests/components/header.test.tsx`

- [ ] **Step 1: Write failing test for header**

Create `tests/components/header.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Header } from '../../src/components/header.js';

describe('Header', () => {
  it('shows app name', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={55} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('Cache Warmer');
  });

  it('shows paused state', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={55} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('paused');
  });

  it('shows active state', () => {
    const { lastFrame } = render(
      <Header warming={true} intervalMinutes={55} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('active');
  });

  it('shows configured interval', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={30} warmPrompt="Reply with only the word OK" />,
    );
    expect(lastFrame()!).toContain('30');
  });

  it('shows warm prompt', () => {
    const { lastFrame } = render(
      <Header warming={false} intervalMinutes={55} warmPrompt="Say hi" />,
    );
    expect(lastFrame()!).toContain('Say hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/components/header.test.tsx
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement header**

Create `src/components/header.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  warming: boolean;
  intervalMinutes: number;
  warmPrompt: string;
}

export function Header({ warming, intervalMinutes, warmPrompt }: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="magenta">Claude Cache Warmer</Text>
        <Text>  </Text>
        {warming ? (
          <Text bold color="green">active</Text>
        ) : (
          <Text dimColor>paused</Text>
        )}
        <Text>  </Text>
        <Text dimColor>interval: </Text>
        <Text>{intervalMinutes}m</Text>
        <Text>  </Text>
        <Text dimColor>prompt: </Text>
        <Text>&quot;{warmPrompt}&quot;</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/components/header.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/header.tsx tests/components/header.test.tsx
git commit -m "feat: add header component with warming status and config display"
```

---

### Task 9: Session row component

**Files:**
- Create: `src/components/session-row.tsx`
- Create: `tests/components/session-row.test.tsx`

- [ ] **Step 1: Write failing test for session row**

Create `tests/components/session-row.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SessionRow } from '../../src/components/session-row.js';
import type { Session } from '../../src/lib/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'abc-123',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-opus-4-6',
    lastAssistantTimestamp: Date.now() - 10 * 60 * 1000,
    isWarm: true,
    isLive: false,
    cacheReadTokens: 100000,
    cacheWriteTokens: 5000,
    expiryCostUsd: 1.05,
    selected: true,
    warmingStatus: 'idle',
    warmCostUsd: 0.05,
    warmCount: 2,
    nextWarmAt: Date.now() + 12 * 60 * 1000,
    lastWarmedAt: Date.now() - 5 * 60 * 1000,
    lastWarmError: null,
    ...overrides,
  };
}

describe('SessionRow', () => {
  it('renders session name', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} />);
    expect(lastFrame()!).toContain('Test Session');
  });

  it('shows warm indicator for warm sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isWarm: true })} highlighted={false} />);
    expect(lastFrame()!).toContain('warm');
  });

  it('shows cold indicator for cold sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isWarm: false })} highlighted={false} />);
    expect(lastFrame()!).toContain('cold');
  });

  it('shows live indicator for live sessions', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ isLive: true })} highlighted={false} />);
    expect(lastFrame()!).toContain('live');
  });

  it('shows model short name', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} />);
    expect(lastFrame()!).toContain('opus-4-6');
  });

  it('shows formatted cached tokens', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} />);
    expect(lastFrame()!).toContain('105,000');
  });

  it('shows expiry cost', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} />);
    expect(lastFrame()!).toContain('$1.05');
  });

  it('shows warm cost', () => {
    const { lastFrame } = render(<SessionRow session={makeSession()} highlighted={false} />);
    expect(lastFrame()!).toContain('$0.05');
  });

  it('shows warm count', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ warmCount: 5 })} highlighted={false} />);
    expect(lastFrame()!).toContain('5');
  });

  it('shows warming status', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ warmingStatus: 'warming' })} highlighted={false} />);
    expect(lastFrame()!).toContain('warming');
  });

  it('shows error status in red', () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession({ warmingStatus: 'error', lastWarmError: 'timeout' })} highlighted={false} />,
    );
    expect(lastFrame()!).toContain('error');
  });

  it('shows dash for next warm when not scheduled', () => {
    const { lastFrame } = render(<SessionRow session={makeSession({ nextWarmAt: null })} highlighted={false} />);
    expect(lastFrame()!).toContain('-');
  });

  it('shows next warm countdown', () => {
    const session = makeSession({ nextWarmAt: Date.now() + 12 * 60 * 1000 });
    const { lastFrame } = render(<SessionRow session={session} highlighted={false} />);
    expect(lastFrame()!).toContain('12m');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/components/session-row.test.tsx
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement session row**

Create `src/components/session-row.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from '../lib/types.js';
import { formatUsd, shortenModelName } from '../lib/pricing.js';

interface SessionRowProps {
  session: Session;
  highlighted: boolean;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCountdown(nextWarmAt: number | null): string {
  if (!nextWarmAt) return '-';
  const diffMs = nextWarmAt - Date.now();
  if (diffMs <= 0) return 'now';
  const minutes = Math.ceil(diffMs / 60_000);
  return `${minutes}m`;
}

function StatusBadge({ session }: { session: Session }) {
  if (session.isLive) {
    return <Text color="blue">[live]</Text>;
  }
  if (session.isWarm) {
    return <Text color="green">[warm]</Text>;
  }
  return <Text dimColor>[cold]</Text>;
}

function WarmingIndicator({ session }: { session: Session }) {
  if (session.warmingStatus === 'warming') {
    return <Text color="yellow">warming...</Text>;
  }
  if (session.warmingStatus === 'error') {
    return <Text color="red">error</Text>;
  }
  if (session.warmingStatus === 'success') {
    return <Text color="green">ok</Text>;
  }
  return <Text dimColor>idle</Text>;
}

export function SessionRow({ session, highlighted }: SessionRowProps) {
  const cachedTotal = session.cacheReadTokens + session.cacheWriteTokens;
  const selectChar = session.selected ? '>' : ' ';
  const bgColor = highlighted ? 'gray' : undefined;

  return (
    <Box>
      <Box width={2}>
        <Text color={highlighted ? 'cyan' : undefined} backgroundColor={bgColor}>
          {selectChar}
        </Text>
      </Box>
      <Box width={3}>
        <StatusBadge session={session} />
      </Box>
      <Box width={30}>
        <Text wrap="truncate-end" bold={highlighted} dimColor={!session.selected} backgroundColor={bgColor}>
          {' '}{session.name}
        </Text>
      </Box>
      <Box width={12}>
        <Text dimColor={!session.selected}>{shortenModelName(session.model)}</Text>
      </Box>
      <Box width={12} justifyContent="flex-end">
        <Text dimColor={!session.selected}>{formatTokens(cachedTotal)}</Text>
      </Box>
      <Box width={12} justifyContent="flex-end">
        <Text dimColor={!session.selected}>{formatUsd(session.expiryCostUsd)}</Text>
      </Box>
      <Box width={12} justifyContent="flex-end">
        <Text dimColor={!session.selected}>
          {session.selected ? formatUsd(session.warmCostUsd) : '-'}
        </Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text dimColor={!session.selected}>{session.selected ? String(session.warmCount) : '-'}</Text>
      </Box>
      <Box width={10} justifyContent="flex-end">
        <Text dimColor={!session.selected}>{formatCountdown(session.nextWarmAt)}</Text>
      </Box>
      <Box width={12} justifyContent="flex-end">
        <WarmingIndicator session={session} />
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/components/session-row.test.tsx
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/session-row.tsx tests/components/session-row.test.tsx
git commit -m "feat: add session row component with all columns and visual indicators"
```

---

### Task 10: Session table component

**Files:**
- Create: `src/components/session-table.tsx`
- Create: `tests/components/session-table.test.tsx`

- [ ] **Step 1: Write failing test for session table**

Create `tests/components/session-table.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SessionTable } from '../../src/components/session-table.js';
import type { Session } from '../../src/lib/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'abc-123',
    name: 'Test Session',
    projectDir: 'test-project',
    cwd: '/test',
    model: 'claude-opus-4-6',
    lastAssistantTimestamp: Date.now(),
    isWarm: true,
    isLive: false,
    cacheReadTokens: 50000,
    cacheWriteTokens: 1000,
    expiryCostUsd: 0.5,
    selected: true,
    warmingStatus: 'idle',
    warmCostUsd: 0,
    warmCount: 0,
    nextWarmAt: null,
    lastWarmedAt: null,
    lastWarmError: null,
    ...overrides,
  };
}

describe('SessionTable', () => {
  it('renders column headers', () => {
    const { lastFrame } = render(
      <SessionTable sessions={[]} highlightedIndex={0} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Session Name');
    expect(frame).toContain('Model');
    expect(frame).toContain('Cached');
    expect(frame).toContain('Expiry Cost');
    expect(frame).toContain('Warm Cost');
    expect(frame).toContain('Warms');
    expect(frame).toContain('Next Warm');
    expect(frame).toContain('Status');
  });

  it('renders session rows', () => {
    const sessions = [
      makeSession({ sessionId: 'a', name: 'Session Alpha' }),
      makeSession({ sessionId: 'b', name: 'Session Beta' }),
    ];
    const { lastFrame } = render(
      <SessionTable sessions={sessions} highlightedIndex={0} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Session Alpha');
    expect(frame).toContain('Session Beta');
  });

  it('shows empty state when no sessions', () => {
    const { lastFrame } = render(
      <SessionTable sessions={[]} highlightedIndex={0} />,
    );
    expect(lastFrame()!).toContain('No sessions found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/components/session-table.test.tsx
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement session table**

Create `src/components/session-table.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from '../lib/types.js';
import { SessionRow } from './session-row.js';

interface SessionTableProps {
  sessions: Session[];
  highlightedIndex: number;
}

function ColumnHeader({ label, width, align }: { label: string; width: number; align?: 'right' }) {
  return (
    <Box width={width} justifyContent={align === 'right' ? 'flex-end' : undefined}>
      <Text bold dimColor>{label}</Text>
    </Box>
  );
}

export function SessionTable({ sessions, highlightedIndex }: SessionTableProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2}><Text> </Text></Box>
        <Box width={3}><Text> </Text></Box>
        <ColumnHeader label="Session Name" width={30} />
        <ColumnHeader label="Model" width={12} />
        <ColumnHeader label="Cached" width={12} align="right" />
        <ColumnHeader label="Expiry Cost" width={12} align="right" />
        <ColumnHeader label="Warm Cost" width={12} align="right" />
        <ColumnHeader label="Warms" width={7} align="right" />
        <ColumnHeader label="Next Warm" width={10} align="right" />
        <ColumnHeader label="Status" width={12} align="right" />
      </Box>
      {sessions.length === 0 ? (
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>No sessions found. Check ~/.claude/projects/ for session transcripts.</Text>
        </Box>
      ) : (
        sessions.map((session, index) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            highlighted={index === highlightedIndex}
          />
        ))
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/components/session-table.test.tsx
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/session-table.tsx tests/components/session-table.test.tsx
git commit -m "feat: add session table component with column headers and rows"
```

---

### Task 11: App component (wiring everything together)

**Files:**
- Create: `src/app.tsx`
- Create: `tests/components/app.test.tsx`

- [ ] **Step 1: Write failing test for app**

Create `tests/components/app.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../../src/app.js';
import * as sessionsModule from '../../src/lib/sessions.js';
import * as warmerModule from '../../src/lib/warmer.js';

vi.mock('../../src/lib/sessions.js');
vi.mock('../../src/lib/warmer.js');

const mockSessions = vi.mocked(sessionsModule);
const mockWarmer = vi.mocked(warmerModule);

beforeEach(() => {
  vi.resetAllMocks();
  mockSessions.discoverSessions.mockReturnValue([
    {
      sessionId: 'abc-123',
      name: 'Test Session',
      projectDir: 'test',
      cwd: '/test',
      model: 'claude-opus-4-6',
      lastAssistantTimestamp: Date.now() - 10 * 60 * 1000,
      isWarm: true,
      isLive: false,
      cacheReadTokens: 100000,
      cacheWriteTokens: 5000,
      expiryCostUsd: 1.05,
      selected: true,
      warmingStatus: 'idle',
      warmCostUsd: 0,
      warmCount: 0,
      nextWarmAt: null,
      lastWarmedAt: null,
      lastWarmError: null,
    },
  ]);
});

describe('App', () => {
  it('renders header with app name', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('Cache Warmer');
  });

  it('renders discovered sessions', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('Test Session');
  });

  it('renders footer with keybindings', () => {
    const { lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    expect(lastFrame()!).toContain('quit');
  });

  it('toggles selection on space key', () => {
    const { lastFrame, stdin } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );
    // Session starts selected (isWarm=true), press space to deselect
    stdin.write(' ');
    const frame = lastFrame()!;
    // After deselection, warm cost column should show '-'
    expect(frame).toContain('-');
  });

  it('selects all on a key', () => {
    mockSessions.discoverSessions.mockReturnValue([
      {
        sessionId: 'abc-123',
        name: 'Test Session 1',
        projectDir: 'test',
        cwd: '/test',
        model: 'claude-opus-4-6',
        lastAssistantTimestamp: Date.now(),
        isWarm: true,
        isLive: false,
        cacheReadTokens: 100000,
        cacheWriteTokens: 5000,
        expiryCostUsd: 1.05,
        selected: true,
        warmingStatus: 'idle',
        warmCostUsd: 0,
        warmCount: 0,
        nextWarmAt: null,
        lastWarmedAt: null,
        lastWarmError: null,
      },
      {
        sessionId: 'def-456',
        name: 'Test Session 2',
        projectDir: 'test',
        cwd: '/test',
        model: 'claude-sonnet-4-6',
        lastAssistantTimestamp: Date.now() - 2 * 60 * 60 * 1000,
        isWarm: false,
        isLive: false,
        cacheReadTokens: 50000,
        cacheWriteTokens: 0,
        expiryCostUsd: 0.3,
        selected: false,
        warmingStatus: 'idle',
        warmCostUsd: 0,
        warmCount: 0,
        nextWarmAt: null,
        lastWarmedAt: null,
        lastWarmError: null,
      },
    ]);

    const { stdin, lastFrame } = render(
      <App intervalMinutes={55} warmPrompt="Reply with only the word OK" defaultModel="claude-sonnet-4-6" />,
    );

    // Press 'a' to select all
    stdin.write('a');
    const frame = lastFrame()!;
    // Both sessions should be rendered (both visible)
    expect(frame).toContain('Test Session 1');
    expect(frame).toContain('Test Session 2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/components/app.test.tsx
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement App component**

Create `src/app.tsx`:

```tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, useInput, useApp } from 'ink';
import type { Session, AppConfig } from './lib/types.js';
import { discoverSessions } from './lib/sessions.js';
import { warmSession } from './lib/warmer.js';
import { Scheduler } from './lib/scheduler.js';
import { Header } from './components/header.js';
import { SessionTable } from './components/session-table.js';
import { Footer } from './components/footer.js';

interface AppProps {
  intervalMinutes: number;
  warmPrompt: string;
  defaultModel: string;
}

export function App({ intervalMinutes, warmPrompt, defaultModel }: AppProps) {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<Session[]>(() => discoverSessions(defaultModel));
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [warming, setWarming] = useState(false);
  const schedulerRef = useRef<Scheduler>(new Scheduler(warmSession, intervalMinutes));
  const tickingRef = useRef(false);

  const toggleSelection = useCallback((index: number) => {
    setSessions((prev) => {
      const updated = [...prev];
      const session = updated[index];
      const newSelected = !session.selected;
      updated[index] = { ...session, selected: newSelected };

      if (warming) {
        if (newSelected) {
          updated[index] = schedulerRef.current.addSession(updated[index]);
        } else {
          updated[index] = schedulerRef.current.removeSession(updated[index]);
        }
      }

      return updated;
    });
  }, [warming]);

  const selectAll = useCallback(() => {
    setSessions((prev) =>
      prev.map((s) => {
        const updated = { ...s, selected: true };
        if (warming) {
          return schedulerRef.current.addSession(updated);
        }
        return updated;
      }),
    );
  }, [warming]);

  const selectNone = useCallback(() => {
    setSessions((prev) =>
      prev.map((s) => {
        const updated = { ...s, selected: false };
        if (warming) {
          return schedulerRef.current.removeSession(updated);
        }
        return updated;
      }),
    );
  }, [warming]);

  const toggleWarming = useCallback(() => {
    setWarming((prev) => {
      if (!prev) {
        setSessions((current) => schedulerRef.current.bootstrap(current));
      } else {
        setSessions((current) =>
          current.map((s) => ({ ...s, nextWarmAt: null, warmingStatus: s.warmingStatus === 'warming' ? 'idle' : s.warmingStatus })),
        );
        schedulerRef.current.stop();
      }
      return !prev;
    });
  }, []);

  useEffect(() => {
    if (!warming) return;

    const interval = setInterval(async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        setSessions((current) => {
          schedulerRef.current.tick(current, warmPrompt).then((updated) => {
            setSessions(updated);
          });
          return current;
        });
      } finally {
        tickingRef.current = false;
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, [warming, warmPrompt]);

  useInput((input, key) => {
    if (input === 'q') {
      schedulerRef.current.stop();
      exit();
      return;
    }

    if (input === 'w') {
      toggleWarming();
      return;
    }

    if (input === 'a') {
      selectAll();
      return;
    }

    if (input === 'n') {
      selectNone();
      return;
    }

    if (input === ' ' || key.return) {
      if (sessions.length > 0) {
        toggleSelection(highlightedIndex);
      }
      return;
    }

    if (key.upArrow) {
      setHighlightedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setHighlightedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Header warming={warming} intervalMinutes={intervalMinutes} warmPrompt={warmPrompt} />
      <SessionTable sessions={sessions} highlightedIndex={highlightedIndex} />
      <Footer />
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/components/app.test.tsx
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.tsx tests/components/app.test.tsx
git commit -m "feat: add App component wiring state, scheduler, and keyboard input"
```

---

### Task 12: CLI entry point

**Files:**
- Create: `src/index.tsx`

- [ ] **Step 1: Create the entry point**

Create `src/index.tsx`:

```tsx
#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { App } from './app.js';

const { values } = parseArgs({
  options: {
    interval: { type: 'string', short: 'i', default: '55' },
    prompt: { type: 'string', default: 'Reply with only the word OK' },
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

render(
  <App
    intervalMinutes={intervalMinutes}
    warmPrompt={values.prompt!}
    defaultModel={values.model!}
  />,
);
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Test the dev script starts**

```bash
npx tsx src/index.tsx --help
```

Expected: Shows help text and exits.

- [ ] **Step 4: Commit**

```bash
git add src/index.tsx
git commit -m "feat: add CLI entry point with arg parsing"
```

---

### Task 13: Build configuration

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify build works**

```bash
npm run build
```

Expected: Creates `dist/index.js` and `dist/index.d.ts`.

- [ ] **Step 2: Test the built binary**

```bash
node dist/index.js --help
```

Expected: Shows help text.

- [ ] **Step 3: Commit any build config changes if needed**

```bash
git add -A
git commit -m "chore: verify build output"
```

---

### Task 14: Full test coverage pass

**Files:**
- Modify: Any test files that need additional cases for 100% coverage

- [ ] **Step 1: Run coverage report**

```bash
npm run test:coverage
```

- [ ] **Step 2: Identify uncovered lines**

Review the coverage report. Add tests for any uncovered branches, lines, or functions.

- [ ] **Step 3: Add missing test cases**

For each uncovered path, write a targeted test case. Common gaps:
- Error branches in `discoverSessions` (e.g., `readdirSync` throwing)
- Edge cases in `formatCountdown` (e.g., `nextWarmAt` in the past)
- The `help` and `interval validation` branches in `index.tsx` (excluded from coverage)
- `selectAll`/`selectNone` with warming active

- [ ] **Step 4: Re-run coverage to verify 100%**

```bash
npm run test:coverage
```

Expected: All thresholds met (100% statements, branches, functions, lines).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: achieve 100% test coverage"
```

---

### Task 15: Manual smoke test and polish

- [ ] **Step 1: Run the TUI against real sessions**

```bash
npx tsx src/index.tsx
```

Verify:
- Sessions are discovered and displayed
- Arrow keys navigate
- Space/enter toggles selection
- `a`/`n` select all/none
- `w` toggles warming (watch for actual warm calls)
- `q` quits cleanly

- [ ] **Step 2: Fix any visual/behavioral issues found**

Common issues to look for:
- Column alignment off on wide/narrow terminals
- Truncation of long session names
- Color rendering on different terminal themes
- Timer updates not reflecting in countdown column

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: polish TUI layout and behavior from smoke testing"
```
