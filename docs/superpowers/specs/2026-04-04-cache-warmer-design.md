# Claude Cache Warmer - Design Spec

A TUI application that keeps Claude Code session caches alive by periodically sending minimal prompts, preventing the 1-hour cache TTL from expiring. Cache reads cost ~10% of cache writes, so keeping warm sessions alive is cost-effective as long as the user intends to resume within ~20 hours.

## Architecture

Single-process Node.js application using Ink (React for CLI). Discovers sessions by scanning Claude Code's local data files, displays them in a professional TUI, and spawns `claude -p --resume` child processes to keep selected sessions warm.

No daemon, no IPC, no server. One process does everything.

## Session Discovery

Two data sources are scanned on startup and periodically refreshed:

### JSONL Transcripts

Location: `~/.claude/projects/{sanitized-project-dir}/{sessionId}.jsonl`

Each file is an append-only JSONL transcript. Relevant record types:

- `custom-title` - Contains `customTitle` (session display name) and `sessionId`
- `last-prompt` - Contains `lastPrompt` (truncated last user message)
- `user` / `assistant` - Conversation messages with `timestamp` field
- Assistant messages contain `message.model` (e.g. `"claude-opus-4-6"`) and `message.usage` with cache token counts

From the last assistant message's `message.usage`:
- `cache_read_input_tokens` - Tokens read from cache (hits)
- `cache_creation_input_tokens` - Tokens written to cache
- `cache_creation.ephemeral_1h_input_tokens` - 1h cache writes specifically
- `input_tokens` - Non-cached input tokens
- `output_tokens` - Output tokens generated

Invalid or corrupted JSONL lines are skipped with a warning. The file is not rejected entirely - valid lines before/after the bad line are still processed.

### PID Files

Location: `~/.claude/sessions/{pid}.json`

Structure:
```json
{
  "pid": 12345,
  "sessionId": "<uuid>",
  "cwd": "/path/to/project",
  "startedAt": 1712345678000,
  "kind": "interactive|bg|daemon|daemon-worker",
  "entrypoint": "cli"
}
```

Used to:
- Cross-reference `sessionId` to get `cwd`
- Check if a session has a live Claude Code process (PID liveness via `process.kill(pid, 0)`)
- Live sessions are excluded from warming (they maintain their own cache)

## Data Model

```typescript
interface Session {
  sessionId: string
  name: string              // customTitle, or truncated lastPrompt, or sessionId
  projectDir: string        // sanitized dir name from JSONL path
  cwd: string               // from PID file or derived from projectDir
  model: string             // from message.model, e.g. "claude-opus-4-6"
  lastAssistantTimestamp: number  // ms epoch
  isWarm: boolean           // lastAssistantTimestamp within (now - 55min)
  isLive: boolean           // has running Claude Code process
  cacheReadTokens: number   // from last usage
  cacheWriteTokens: number  // from last usage
  expiryCostUsd: number     // cost if cache expires (full rewrite)
  selected: boolean         // user selection state in TUI
  warmingStatus: 'idle' | 'warming' | 'success' | 'error'
  warmCostUsd: number       // accumulated cost of all warming calls
  warmCount: number         // number of warming rounds completed
  nextWarmAt: number | null // ms epoch of next scheduled warm
  lastWarmedAt: number | null
  lastWarmError: string | null
}
```

## TUI Design

Professional, Claude Code-inspired aesthetic with box-drawing borders, dimmed secondary info, bold/color status indicators.

### Header

Shows app name, warming state (active/paused), configured interval, warm prompt.

### Session Table

```
 Session Name                   Model       Cached     Expiry Cost  Warm Cost  Warms  Next Warm   Status
 [warm] Refactor auth system    opus-4-6    142,340    $0.85        $0.04      3      12m         idle
 [warm] Fix login bug           sonnet-4-6   89,120    $0.12        $0.01      1      27m         warming...
 [cold] Add unit tests          opus-4-6     52,004    $0.31        $0.00      0      -           idle
 [cold] Old migration work      sonnet-4-6   12,500    $0.03        -          -      -           idle
```

Columns:
- **Session Name** - `customTitle` or truncated `lastPrompt` or session ID
- **Model** - Short model name (e.g. "opus-4-6" not "claude-opus-4-6")
- **Cached** - Total cached tokens from the most recent API response in the transcript (`cache_read_input_tokens + cache_creation_input_tokens`)
- **Expiry Cost** - Cost of a full 1h cache write if cache expires: `cached_tokens * (baseInputPrice * 2) / 1_000_000`
- **Warm Cost** - Accumulated cost across all warming rounds (see Pricing section)
- **Warms** - Number of completed warming rounds
- **Next Warm** - Countdown to next scheduled warm, or `-` if not active
- **Status** - `idle`, `warming...`, `success`, `error`

Visual indicators:
- `[warm]` in green, `[cold]` in dim/gray
- `[live]` for sessions with active Claude Code process
- Selected rows marked with a `>` or highlight
- Deselected rows dimmed
- Error status in red
- Sorted by cached tokens descending

### Footer

Keybinding help: `space/enter: toggle` `a: all` `n: none` `w: warm` `i: interval` `q: quit`

### Interactions

- Up/down arrow keys to navigate
- Space or Enter to toggle selection on highlighted session
- `a` to select all sessions
- `n` to deselect all sessions
- `w` to toggle keep-warm on/off for all selected sessions
- `i` to change warming interval (inline text input)
- `q` to quit

When warming is active and selection changes, the scheduler immediately incorporates the change.

## Warming Scheduler

### Bootstrap (First Warm)

For each selected session, compute its valid window:
- Window start: `lastAssistantTimestamp` (or `lastWarmedAt` if previously warmed)
- Window end: `windowStart + 55 minutes` (5min buffer before 60min TTL)

If the session is warm (window hasn't closed), schedule its first warm at a uniformly random point within the remaining window (`[now, windowEnd]`) to spread load across sessions.

If the session is cold (window has closed), warm immediately. The first warm for a cold session will incur a full cache write cost (no cache hit possible).

### Steady State

After a session's first warm succeeds, pin it to a fixed schedule:
- `nextWarmAt = lastWarmedAt + configuredInterval`

Since sessions were bootstrapped at different offsets, their fixed-interval cycles naturally remain staggered. No re-randomization needed.

### Adding/Removing Sessions Mid-Run

- **Adding a warm session:** Compute remaining window, schedule first warm within it, then pin to fixed cycle.
- **Adding a cold session:** Warm immediately (accepting cache write cost), then pin to fixed cycle.
- **Removing a session:** Remove from scheduler. No further warming.

### Execution

A timer loop checks every ~30 seconds: "Is any session due for warming now (`now >= nextWarmAt`)?" If so, warm it sequentially (one at a time to avoid concurrent resume issues).

### The Warm Call

```bash
claude -p "<warm_prompt>" --resume <sessionId> --output-format json
```

Default warm prompt: `"Reply with only the word OK"`

The JSON output is parsed to extract `usage` fields. Session data is updated with fresh cache stats and cost.

Timeout: 60 seconds. If exceeded, kill the child process, mark session as error.

## Pricing

### Base Input Prices (per million tokens)

| Model Family | Base Input | Output |
|---|---|---|
| Opus 4.6 / 4.5 | $5 | $25 |
| Sonnet 4.6 / 4.5 / 4 | $3 | $15 |
| Haiku 4.5 | $1 | $5 |

### Cache Multipliers

| Operation | Multiplier |
|---|---|
| 1h cache write | 2x base input |
| 5min cache write | 1.25x base input |
| Cache read (hit) | 0.1x base input |

### Cost Formulas

**Expiry Cost** (cost if cache expires and needs full rewrite):
```
cachedTokens * (baseInputPrice * 2) / 1_000_000
```

**Per-Warm Cost** (actual cost of a single warming call, from API response):
```
cache_read_input_tokens * (baseInputPrice * 0.1) / 1_000_000
+ cache_creation_input_tokens * (baseInputPrice * 2) / 1_000_000
+ output_tokens * outputPrice / 1_000_000
```

This formula naturally handles both warm sessions (mostly reads at 0.1x) and cold sessions (full write at 2x) since the API response indicates exactly what was read vs written.

**Accumulated Warm Cost**: Sum of per-warm costs across all completed warming rounds for the session.

### Model Detection

Read from `message.model` in the last assistant transcript entry. Fall back to configurable default (`--model` CLI flag, defaults to `claude-sonnet-4-6`).

Prices are hardcoded constants. Model name is mapped to a price entry using prefix matching (e.g. `claude-opus-4-6` matches the Opus 4.6/4.5 tier).

## Error Handling

- **Claude CLI not found**: Show error message on startup, exit gracefully
- **Warm call failure**: Mark session as `error` with message, skip to next, retry next cycle
- **Warm call timeout** (>60s): Kill child process, mark as error
- **Corrupted JSONL**: Skip bad lines with warning, process valid lines. Don't crash.
- **No sessions found**: Show empty state message
- **Live sessions**: Sessions with an active Claude Code process (detected via PID liveness) are shown with a `[live]` indicator and excluded from warming - they maintain their own cache
- **Cold session first warm**: Will show as a cache write in the API response (zero cache reads). The warm cost correctly reflects the write cost via the per-warm cost formula

## Tech Stack

- **TypeScript** with ESM modules
- **Ink v5** - React for CLI
- **vitest** - Testing (100% coverage target)
- **tsx** - Development
- **tsup** - Build for npm publishing
- **Node.js >= 18**

## Project Structure

```
claude-cache-warmer/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.tsx          # Entry point, CLI arg parsing
    app.tsx            # Root Ink <App> component
    components/
      header.tsx       # Header bar with status/config
      session-table.tsx # Main table with session rows
      session-row.tsx  # Individual session row
      footer.tsx       # Keybinding help
      status-bar.tsx   # Warming status indicator
    lib/
      sessions.ts      # Session discovery (JSONL + PID scanning)
      scheduler.ts     # Warming scheduler logic
      warmer.ts        # Spawns claude CLI, parses JSON output
      pricing.ts       # Model pricing constants + cost calc
      types.ts         # Shared TypeScript types
  tests/
    lib/
      sessions.test.ts
      scheduler.test.ts
      warmer.test.ts
      pricing.test.ts
    components/
      header.test.tsx
      session-table.test.tsx
      session-row.test.tsx
      footer.test.tsx
      app.test.tsx
```

## CLI Interface

```
npx claude-cache-warmer [options]
  --interval, -i <minutes>   Warming interval in minutes (default: 55)
  --prompt <string>          Custom warm prompt (default: "Reply with only the word OK")
  --model <model>            Default model for pricing if not detectable (default: "claude-sonnet-4-6")
```

## Testing Strategy

100% test coverage with vitest.

- **`sessions.ts`** - Mock filesystem. Test JSONL parsing with various transcript shapes, missing fields, corrupted lines, multiple sessions across projects.
- **`scheduler.ts`** - Test bootstrap distribution across valid windows, steady-state pin timing, add/remove session mid-run, cold session immediate warm.
- **`warmer.ts`** - Mock `child_process.execFile`. Test JSON output parsing, timeout handling, error propagation.
- **`pricing.ts`** - Test cost calculations for each model tier, verify multipliers, test edge cases (zero tokens, unknown model fallback).
- **Components** - Use Ink's `render()` test utility. Test table rendering, selection state, keybinding responses, status transitions.
