# claude warmer

Picking back up a long Claude Code session can use a surprising amount of your usage limits. `claude-warmer` keeps your open Claude Code prompt caches alive by periodically sending lightweight prompts to your sessions via the PTY-backed `claude --resume` flow, so a simple follow-up does not burn a big chunk of your next 5 hour window.

Without warming, resuming a session after the cache expires can trigger a full cache write. With warming, you mainly pay for cache reads and refreshes instead. Cache reads and refreshes are [20x cheaper than 1 hour cache writes](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing).

By default it watches live Claude Code processes, warms them on a timer, and drops them from warming as soon as their process closes. Closed sessions stay visible for context, but they are never warmed. You can also switch from auto to manual mode, where it will continue to warm any selected live session until you stop it.

<img width="1073" height="652" alt="image" src="https://github.com/user-attachments/assets/92e7a474-3f60-47e2-9f7c-4df41be715d2" />

Not affiliated with or endorsed by Anthropic.

## Requirements

- Node.js 20 or newer
- Claude Code installed and authenticated so `claude` is available on your `PATH`
- At least one Claude Code session already present in `~/.claude/projects/`

`claude-warmer` reads the default Claude Code state directories under `~/.claude`. If you have no local sessions yet, the TUI opens but there is nothing to warm.

## Install

```bash
npx claude-warmer
```

This starts the TUI in active auto mode. To install globally:

```bash
npm install -g claude-warmer
claude-warmer
```

Options:

- `-i, --interval <minutes>` - Warming interval (default: 55, just under the 1 hour cache TTL)
- `--prompt <string>` - Prompt to send (default: `"Reply 'ok'"`)

No startup mode flag is needed. Use `m` inside the TUI to switch between auto and manual mode.

## Modes

- Auto mode is the default. It selects live sessions, keeps them scheduled, picks up newly live sessions, and removes closed sessions from warming.
- Manual mode keeps selection under your control. Use it when you want a fixed set of live sessions instead of automatic tracking.
- Closed sessions remain visible in both modes, but they cannot be selected or warmed.

## How it works

1. Discovers all Claude Code sessions from `~/.claude/projects/`
2. Cross-checks Claude Code PID files so only live processes are warmable
3. Shows a TUI with session status, cached tokens, estimated costs, and next warm time
4. In auto mode, keeps live sessions selected and scheduled as the session list changes
5. Spawns `claude --resume <id>` in a PTY, sends the warm prompt, waits for a response, then exits
6. Refreshes sessions every 30 seconds to pick up new sessions and updated cache metrics

## Keybindings

| Key   | Action                   |
| ----- | ------------------------ |
| Enter | Start/stop warming       |
| Space | Toggle session selection |
| m     | Toggle auto/manual mode  |
| a     | Select all live sessions |
| n     | Deselect all             |
| i     | Edit interval            |
| p     | Edit prompt              |
| c     | Copy session ID          |
| q     | Quit                     |

The `c` key copies the highlighted session ID with the system clipboard when available.

## Development

```bash
git clone https://github.com/ryanlyn/claude-warmer.git
cd claude-warmer
npm install
npm run dev
```

If `node-pty` fails with `posix_spawnp` on macOS Apple Silicon, run:

```bash
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

### Tests

```bash
npm test          # unit tests (100% coverage required)
npm run check     # lint + format + coverage
npm run test:e2e  # E2E cache benchmark suite (hits real API, slow)
```
