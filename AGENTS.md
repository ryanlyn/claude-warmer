# AGENTS.md

## Project

TUI tool that keeps Claude Code session caches warm by periodically resuming sessions via `claude --resume` in a PTY. Built with React/Ink. Sources written for Deno; published to npm via `dnt`.

## Architecture

- `src/index.tsx` - CLI entry, parses args, renders `<App>`
- `src/app.tsx` - Main component. Manages session state, warming toggle, periodic refresh (30s), tick loop (30s)
- `src/lib/warmer.ts` - Spawns `claude --resume <id>` via node-pty, sends prompt after output settles, sends `/exit`, reads usage from JSONL
- `src/lib/scheduler.ts` - Schedules warm times. Cold sessions warm immediately, warm sessions at random point before expiry
- `src/lib/sessions.ts` - Discovers sessions from `~/.claude/projects/` JSONL files, cross-references `~/.claude/sessions/` PID files for liveness
- `src/lib/pricing.ts` - Token cost calculation with cache read (0.1x) and write (2x) multipliers
- `src/lib/layout.ts` - Responsive column widths, hides columns progressively at narrow terminals
- `src/lib/types.ts` - Shared types, `WARM_THRESHOLD_MS` (55 min)
- `scripts/build-npm.ts` - dnt build that transpiles the Deno sources into a Node-compatible npm package in `./npm`

## Commands

- `deno task dev` - Run via Deno
- `deno task test` - Unit + component tests (deno test + @std/expect)
- `deno task test:coverage` - Same, with coverage report
- `deno task test:integration` - Integration tier
- `deno task test:e2e` - E2E cache benchmark suite (slow, hits real API)
- `deno task check` - `deno fmt --check && deno lint && deno task test:coverage`
- `deno task build:npm` - Produce the publishable npm package under `./npm` via dnt

## Key design decisions

- **node-pty for resumption**: `claude --resume` must run in a real PTY to go through the interactive REPL codepath (`cc_entrypoint=cli`). Using `execFile` with `-p` flag goes through the SDK codepath (`cc_entrypoint=sdk-cli`) which has a different system prompt identity.
- **JSONL for metrics**: After a warm completes, usage (cache reads/writes) is read from the session's JSONL file rather than parsing CLI output, since the interactive REPL doesn't emit structured JSON.
- **Settle-based readiness detection**: The warmer waits for PTY output to stop flowing for 3s before sending the prompt, and again before sending `/exit`. This handles variable REPL startup times.
- **Session refresh preserves warmer state**: The 30s refresh re-reads JSONL files for fresh data (tokens, warm/cold, name) but preserves warmer-owned state (selected, warmCount, nextWarmAt, etc.).
- **Deno source, npm artifact**: Sources use `npm:`/`node:` specifiers. `dnt` rewrites them for Node and emits `./npm` for `npm publish`. End users install from npm; only contributors need Deno.

## Known limitation

- Cross-process cache hit rates have varied across Claude Code versions as prompt and tool definitions change. If a benchmark number matters, rerun `deno task test:e2e` against the current Claude Code build rather than relying on an older doc snapshot.

## Testing

- Tests inject typed fakes through the public `Deps`/`Fs`/`SpawnFn`/`Clock`/`WarmFn`/`ExecFileSyncFn`/`ExecSyncFn`/`KillFn` surfaces instead of patching modules at the runtime level. `App.deps` also accepts `copyToClipboard` and `TextInput` overrides for component tests.
- E2E test is excluded from default `deno task test` (separate task; needs a real `claude` binary).
- Coverage targets `src/` excluding `src/index.tsx`. Overall ~97% branch / ~96% line; the few uncovered lines were originally annotated `/* v8 ignore next */` in the vitest era - unreachable defensive guards.
- Linux contributors may need to install `node-gyp` and rebuild node-pty if no prebuilt binary matches the host: `(cd node_modules/.deno/node-pty@*/node_modules/node-pty && node-gyp rebuild)`.
- macOS Apple Silicon: `chmod +x node_modules/.deno/node-pty@*/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` after install if `posix_spawnp` fails.
