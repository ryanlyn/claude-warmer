# claude warmer

Keep your Claude Code caches alive while you sleep, go for lunch, or touch grass. Periodically sends lightweight prompts to your sessions via `claude --resume` so that 1h TTL cache writes are refreshed.

Without warming, resuming a session older than 1 hour means a full cache write - $10 per M tokens for Opus 4.6. With warming, you pay $0.5 per M tokens for keep-alive instead. Cache reads and refreshes are [20x cheaper than 1h cache writes](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing).

> **Usage is not recommended yet:** As of Claude Code version `2.1.100`, there is a bug where cross-process `claude --resume` result in non-deterministic plugin skill and tool definitions, which invalidates most of the cached prefix. The fix (an upcoming attachment system) exists behind a feature flag in Claude Code. Once enabled, cross-process cache hits should reach >90%.
>
> Claude Code `2.1.100` introduced `--exclude-dynamic-system-prompt-sections` which moves per-machine state (cwd, env info, memory paths, git status) from the system prompt into the first user message. It is designed for cross-**user** cache reuse and does not fix same-user cross-process warming. The table below captures what each combination of create mode, resume mode, and flag gets on warm 2 (measured against Claude Code `2.1.100`, one prompt round-trip, on the same machine):
>
> | Create mode | Resume mode | Flag | Warm 2 hit rate |
> |---|---|---|---|
> | PTY | PTY | off | ~47% |
> | PTY | PTY | on | ~47% |
> | print | print | off | ~49% |
> | print | print | on | ~0% |
> | PTY | print | off | ~99.7% |
> | PTY | print | on | ~47.6% |
> | print (flag) | PTY | on | ~46.5% |
>
> Two takeaways. First, the PTY resume codepath caps at ~47% regardless of the flag or how the session was created, because the underlying non-determinism lives in that codepath. Second, the only combination that reliably reaches >90% is a PTY-created session resumed through print mode without the flag, which is not the interactive-CLI identity that a user's own `claude --resume` would hit, so it does not solve the warming use case.

<img width="1073" height="652" alt="image" src="https://github.com/user-attachments/assets/92e7a474-3f60-47e2-9f7c-4df41be715d2" />

Not affiliated with or endorsed by Anthropic.

## Install

```
npx claude-warmer
```

Or install globally:
```
npm install -g claude-warmer
claude-warmer
```

Options:
- `-i, --interval <minutes>` - Warming interval (default: 55, just under the 1h cache TTL)
- `--prompt <string>` - Prompt to send (default: "Reply 'ok'")

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

## Development

```
git clone https://github.com/ryanlyn/claude-warmer.git
cd claude-warmer
npm install
npm run dev
```

If node-pty fails with `posix_spawnp` on macOS Apple Silicon, run:
```
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

### Tests

```
npm test          # unit tests (100% coverage required)
npm run check     # lint + format + coverage
npm run test:e2e  # E2E cache hit test (hits real API, slow)
```
