# claude-rename

Auto-name your Claude Code sessions with descriptive, AI-powered titles.

**Before:** `claude --resume` shows `"i need to write some sort of..."` truncated gibberish.

**After:** `claude --resume` shows `"fix-stripe-webhook-retry"`, `"k8s-helm-ingress-setup"`, `"refactor-auth-middleware"`.

**No separate API key needed** — uses your existing Claude Code subscription.

## Install

### One-liner (just the hook)

```bash
curl -sL https://raw.githubusercontent.com/sathwick-p/claude-rename/main/install.sh | bash
```

This downloads the hook file plus its shared prompt helper, then registers the hook in your Claude Code settings. That's it — new sessions auto-name themselves.

### npx (full CLI — no install)

```bash
# Run any command directly from GitHub:
npx github:sathwick-p/claude-rename install
npx github:sathwick-p/claude-rename list
npx github:sathwick-p/claude-rename backfill
npx github:sathwick-p/claude-rename status
```

### From source

```bash
git clone https://github.com/sathwick-p/claude-rename.git
cd claude-rename
npm link           # makes `claude-rename` available globally
claude-rename install
```

## How it works

1. A **Stop hook** fires after each Claude Code assistant turn
2. On the **first meaningful exchange** of a new session, it injects a naming instruction
3. **Claude itself** generates a concise 3-6 word title (max 50 chars) from its full conversation context
4. The title is written to the session file — appears in `claude --resume` immediately
5. If the injection didn't work, a **background fallback** names it via `claude -p` (AI, not heuristic)
6. **Idempotent** — only names each session once, subsequent turns are a no-op

Since Claude generates the title from its own context (not a separate API call), the titles are highly accurate and specific.

## Commands

| Command | Description |
|---|---|
| `claude-rename install` | Install the auto-naming Stop hook |
| `claude-rename uninstall` | Remove the hook cleanly |
| `claude-rename list [--project <filter>]` | List all sessions with their titles |
| `claude-rename backfill [--dry-run] [--model <model>]` | Bulk-name all untitled sessions |
| `claude-rename rename <id> <title>` | Manually rename a specific session by exact session ID |
| `claude-rename status` | Show hook installation status |

## Model selection

Backfill uses AI to generate every title. Choose your model:

```bash
claude-rename backfill                    # default: haiku (fast, cheap)
claude-rename backfill --model sonnet     # balanced quality
claude-rename backfill --model opus       # highest quality
```

The hook's background fallback also uses AI. Set a default model in `~/.claude-rename.json`:

```json
{"model": "haiku"}
```

## Architecture

```
You ask Claude something
        |
Claude responds (Stop event fires)
        |
   Hook checks:
        |-- Already named? -> skip (O(1) marker file check)
        |-- Context limit / abort stop? -> skip (never block)
        |-- No real conversation yet? -> skip
        |
   First time: inject naming instruction into Claude's context
        |
   Claude reads instruction -> generates title -> writes it via Bash
        |
   If Bash was denied or Claude didn't write:
        |-- Next Stop fires -> AI fallback via claude -p (background)
        |
   Marker file created -> skip on all future Stops
```

**Zero separate API calls.** The hook leverages the already-running Claude instance to generate the title. The only "cost" is one brief Bash tool call after your first exchange.

## Backfilling existing sessions

```bash
# Preview what would be named (no changes)
claude-rename backfill --dry-run

# Name all untitled sessions (default: haiku)
claude-rename backfill

# Use a different model
claude-rename backfill --model sonnet

# Filter to a specific project
claude-rename backfill --project my-project
```

## Session storage

Claude Code stores sessions at `~/.claude/projects/<encoded-path>/<uuid>.jsonl`. The tool now preserves the stored project directory as-is instead of trying to reverse that encoding. Titles are written as:

```json
{"type":"custom-title","customTitle":"fix-stripe-webhook-retry","sessionId":"abc-123-..."}
```

This is the same format Claude Code's built-in `/rename` command uses.

## Files

| Path | Purpose |
|---|---|
| `~/.claude/hooks/claude-rename.mjs` | The Stop hook (copied during install) |
| `~/.claude/hooks/title-prompt.mjs` | Shared title prompt and normalization helper |
| `~/.claude/settings.json` | Hook registration (modified during install) |
| `~/.claude-rename.log` | Debug log (append-only) |
| `~/.claude-rename.json` | Config (optional — set default model) |
| `~/.claude/.session-namer-named/` | Marker files for idempotency |

## Uninstalling

```bash
claude-rename uninstall
# or if installed via npm link:
npm unlink -g claude-rename
```

Existing session titles are preserved.

## Requirements

- Node.js >= 18
- Claude Code CLI installed and authenticated

## License

MIT
