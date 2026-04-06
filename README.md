# claude warmer

Keep your Claude Code caches alive while you sleep, go for lunch, or touch grass. Periodically sends lightweight prompts to your sessions via `claude --resume` so that 1h TTL cache writes are refreshed.

Without warming, resuming a session older than 1 hour means a full cache write - $10 per M tokens for Opus 4.6. With warming, you pay $0.5 per M tokens for keep-alive instead. Cache reads and refreshes are [20x cheaper than 1h cache writes](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing).

> **Usage is not recommended yet:** As of Claude Code version `2.1.92`, there is a bug where cross-process `claude --resume` result in non-deterministic plugin skill and tool definitions, which invalidates most of the cached prefix. The fix (an upcoming attachment system) exists behind a feature flag in Claude Code. Once enabled, cross-process cache hits should reach >90%.

<img width="1073" height="652" alt="image" src="https://github.com/user-attachments/assets/92e7a474-3f60-47e2-9f7c-4df41be715d2" />

## Install

```
npm install
npm run build
```

If node-pty fails with `posix_spawnp`, run:
```
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

## Usage

```
npx tsx src/index.tsx
```

Or after building:
```
node dist/index.js
```

Options:
- `-i, --interval <minutes>` - Warming interval (default: 55, just under the 1h cache TTL)
- `--prompt <string>` - Prompt to send (default: "Reply 'ok'")
- `--model <model>` - Default model for cost estimates (default: claude-sonnet-4-6)

## How it works

1. Discovers all Claude Code sessions from `~/.claude/projects/`
2. Shows a TUI with session status (warm/cold/live), cached tokens, and estimated costs
3. Select sessions to keep warm, press Enter to start
4. The warmer spawns `claude --resume <id>` in a PTY, sends the prompt, waits for a response, then exits
5. Sessions are refreshed every 30s to pick up new sessions and updated cache metrics

## Keybindings

| Key | Action |
|-----|--------|
| Enter | Start/stop warming |
| Space | Toggle session selection |
| a | Select all live/warm sessions |
| n | Deselect all |
| i | Edit interval |
| p | Edit prompt |
| c | Copy session ID |
| q | Quit |

## Tests

```
npm test          # unit tests
npm run test:e2e  # E2E cache hit test (hits real API, slow)
```

The E2E test creates a session, warms it twice from separate processes, and asserts the second warm gets >90% cache hits. It currently fails due to the limitation above and serves as a regression test for when the fix ships.
