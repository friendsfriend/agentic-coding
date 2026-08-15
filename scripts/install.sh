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
for runtime in opencode opencode2; do
    command -v "$runtime" >/dev/null 2>&1 || echo "optional runtime not found (not installed automatically): $runtime" >&2
done
