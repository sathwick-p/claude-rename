#!/bin/bash
# claude-rename installer — sets up the auto-naming hook for Claude Code
# Usage: curl -sL https://raw.githubusercontent.com/sathwick-p/claude-rename/main/install.sh | bash

set -e

HOOK_URL="https://raw.githubusercontent.com/sathwick-p/claude-rename/main/src/hook.mjs"
HOOK_DIR="$HOME/.claude/hooks"
HOOK_FILE="$HOOK_DIR/claude-rename.mjs"
SETTINGS_FILE="$HOME/.claude/settings.json"
HOOK_COMMAND='node "$HOME/.claude/hooks/claude-rename.mjs"'

echo "Installing claude-rename hook..."
echo ""

# 1. Download hook file
mkdir -p "$HOOK_DIR"
curl -sL "$HOOK_URL" -o "$HOOK_FILE"
echo "  Hook downloaded to $HOOK_FILE"

# 2. Register in settings.json using Node (always available with Claude Code)
node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const cmd = '$HOOK_COMMAND';

let settings = {};
try { settings = JSON.parse(fs.readFileSync(path, 'utf-8')); } catch {}

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.Stop) settings.hooks.Stop = [];

const already = settings.hooks.Stop.some(e =>
  (e.hooks || []).some(h => h.command && h.command.includes('claude-rename'))
);

if (!already) {
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: cmd }] });
  fs.writeFileSync(path, JSON.stringify(settings, null, 4));
  console.log('  Hook registered in settings.json');
} else {
  console.log('  Hook already registered in settings.json');
}
"

echo ""
echo "Done! New sessions will be auto-named after the first exchange."
echo "No API key needed — uses your existing Claude Code subscription."
echo ""
echo "For CLI tools (list, backfill, rename), run:"
echo "  npx github:sathwick-p/claude-rename <command>"
echo ""
