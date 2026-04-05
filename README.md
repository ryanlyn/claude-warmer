# claude warmer

Keep your Claude Code session caches alive. This tool periodically sends lightweight prompts to your sessions via `claude --resume` so the API prompt cache doesn't expire (1h TTL).

Without warming, resuming a session after the cache expires means a full cache write - potentially several dollars on a large Opus session. With warming, you pay ~$0.04 per keep-alive instead. Cache reads are [20x cheaper than cache writes](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing).

> **Note:** Cross-process `claude --resume` currently gets ~53% cache hit rate due to non-deterministic agent type ordering in Claude Code's tool definitions. The fix (sorting agent types) exists behind a feature flag in CC. Once enabled, cross-process cache hits should reach >90%.

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
