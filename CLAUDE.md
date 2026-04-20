# CLAUDE.md

## Project

TUI tool that keeps Claude Code session caches warm by periodically resuming sessions via `claude --resume` in a PTY. Built with React/Ink.

## Architecture

- `src/index.tsx` - CLI entry, parses args, renders `<App>`
- `src/app.tsx` - Main component. Manages session state, warming toggle, periodic refresh (30s), tick loop (30s)
- `src/lib/warmer.ts` - Spawns `claude --resume <id>` via node-pty, sends prompt after output settles, sends `/exit`, reads usage from JSONL
- `src/lib/scheduler.ts` - Schedules warm times. Cold sessions warm immediately, warm sessions at random point before expiry
- `src/lib/sessions.ts` - Discovers sessions from `~/.claude/projects/` JSONL files, cross-references `~/.claude/sessions/` PID files for liveness
- `src/lib/pricing.ts` - Token cost calculation with cache read (0.1x) and write (2x) multipliers
- `src/lib/layout.ts` - Responsive column widths, hides columns progressively at narrow terminals
- `src/lib/types.ts` - Shared types, `WARM_THRESHOLD_MS` (55 min)

## Commands

- `npm run dev` - Run via tsx
- `npm test` - Unit tests (vitest, 100% coverage required)
- `npm run test:e2e` - E2E cache benchmark suite (slow, hits real API)
- `npm run build` - Bundle with tsup

## Key design decisions

- **node-pty for resumption**: `claude --resume` must run in a real PTY to go through the interactive REPL codepath (`cc_entrypoint=cli`). Using `execFile` with `-p` flag goes through the SDK codepath (`cc_entrypoint=sdk-cli`) which has a different system prompt identity.
- **JSONL for metrics**: After a warm completes, usage (cache reads/writes) is read from the session's JSONL file rather than parsing CLI output, since the interactive REPL doesn't emit structured JSON.
- **Settle-based readiness detection**: The warmer waits for PTY output to stop flowing for 3s before sending the prompt, and again before sending `/exit`. This handles variable REPL startup times.
- **Session refresh preserves warmer state**: The 30s refresh re-reads JSONL files for fresh data (tokens, warm/cold, name) but preserves warmer-owned state (selected, warmCount, nextWarmAt, etc.).

## Known limitation

Cross-process cache hit rates have varied across Claude Code versions as prompt and tool definitions change. If an exact benchmark matters, rerun `npm run test:e2e` against the current Claude Code build instead of relying on an older percentage in docs.

## Testing

- Unit tests mock node-pty, node:fs, and node:child_process
- E2E test is excluded from unit test runs (separate vitest config)
- 100% coverage thresholds on unit tests
- `chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` may be needed after `npm install` if node-pty spawn fails with `posix_spawnp`
