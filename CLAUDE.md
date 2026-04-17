# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Build (type-check):** `npm run build` — runs `tsc --noCheck` (validates module resolution, not full type checking since `strict: false`)
- **Lint:** `npm run lint` — currently just runs build
- **Test:** `npm run test` — runs `bun ./src/test.ts && bun ./src/config-modal-test.ts`
- **Full check:** `npm run check` — lint + test
- **Dev environment:** `nix develop` (or `direnv allow`) — provides Node.js 22 and pnpm

Tests use Bun as the runner with `node:assert/strict`. There is no built-in way to run a single test — you must edit the test file to isolate what you want to run.

## Architecture

This is a **Pi coding agent extension** that enforces permission policies on tool calls, bash commands, MCP operations, skills, and special actions. It integrates via Pi's lifecycle hooks.

### Hook-based enforcement pipeline

The extension exports three hooks from `src/index.ts`:

1. **`before_agent_start`** — Pre-filters the agent's available tools, sanitizes denied tools from system prompts, hides denied skills
2. **`tool_call`** — Runtime gate: resolves permission state (`allow`/`deny`/`ask`) for each tool invocation, applies `allowLocalEdits` override for local edit/write, then runs configured PreToolUse hooks (Claude Code-compatible shell commands) that can override the decision
3. **`input`** — Intercepts `/skill:<name>` requests to enforce skill policy

### Permission resolution

`src/permission-manager.ts` is the core policy engine. It loads a global JSONC policy from `~/.pi/agent/pi-permissions.jsonc` and merges per-agent overrides from YAML frontmatter in agent `.md` files. Resolution uses **last-matching-rule-wins** semantics with five categories:

- **tools** — exact tool name matching
- **bash** — wildcard pattern matching on commands (via `src/bash-filter.ts` and `src/wildcard-matcher.ts`)
- **mcp** — `server:tool` or `server:*` pattern matching
- **skills** — skill name pattern matching
- **special** — reserved checks (`doom_loop`, `external_directory`)

### Key modules

| Module | Responsibility |
|---|---|
| `permission-manager.ts` | Policy loading, merging, caching, resolution |
| `bash-filter.ts` | Bash command pattern compilation and matching |
| `wildcard-matcher.ts` | `*`-glob to regex compilation (reused by bash/mcp/skills) |
| `system-prompt-sanitizer.ts` | Strips denied tools from the `Available tools:` prompt section |
| `tool-registry.ts` | Tool name normalization and registration checking |
| `permission-forwarding.ts` | IPC for subagent permission delegation to the main session |
| `permission-dialog.ts` | TUI confirmation prompts |
| `yolo-mode.ts` | Auto-approval bypass logic |
| `local-edit.ts` | Path normalization and `allowLocalEdits` auto-approval predicate |
| `logging.ts` | Structured JSONL logging (debug + review) |
| `extension-config.ts` | Extension config loading/saving (`config.json`) |
| `common.ts` | Shared utilities: YAML frontmatter parsing, type guards |
| `hook-types.ts` | Type definitions for PreToolUse hook configuration and protocol |
| `hook-matcher.ts` | Pi ↔ Claude Code tool name mapping and hook matching |
| `hook-executor.ts` | Subprocess execution engine for external hook commands |
| `hook-runner.ts` | Hook orchestration: match, execute sequentially, merge decisions |

### Performance patterns

The permission manager caches file stamps to avoid re-reading unchanged config files and pre-compiles wildcard patterns to regexes. Merged per-agent permission objects are also cached.
