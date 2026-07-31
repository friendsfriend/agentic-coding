#!/usr/bin/env bash
# Build, install, and stow the whole agentic-coding setup: pi/ herdr/ opencode/
# asset links (stow.sh) plus the single self-contained agentic-coding executable
# (workflow engine + TUI) compiled with bun build --compile.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

"$root/scripts/stow.sh"
bun install --cwd "$root/agentic-coding" --frozen-lockfile
bun run --cwd "$root/agentic-coding" build
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/agentic-coding/dist/agentic-coding" "$HOME/.local/bin/agentic-coding"
echo "installed: $(command -v agentic-coding || echo "$HOME/.local/bin/agentic-coding")"
