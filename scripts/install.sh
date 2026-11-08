#!/usr/bin/env bash
# Build, install, and stow the whole agentic-coding setup: pi/ herdr/ opencode/
# asset links (stow.sh), the compiled agentic-coding executable, and
# agentic-coding-v2's built bundle with its installed native runtime dependencies.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

"$root/scripts/stow.sh"
bun install --cwd "$root/agentic-coding" --frozen-lockfile
bun run --cwd "$root/agentic-coding" build
bun install --cwd "$root/agentic-coding-v2" --frozen-lockfile
bun run --cwd "$root/agentic-coding-v2" build
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/agentic-coding/dist/agentic-coding" "$HOME/.local/bin/agentic-coding"
ln -sfn "$root/agentic-coding-v2/bin/agentic-coding-v2" "$HOME/.local/bin/agentic-coding-v2"
echo "installed: $HOME/.local/bin/agentic-coding"
echo "installed: $HOME/.local/bin/agentic-coding-v2"
echo "Keep the checkout and installed v2 dependencies: v2 uses Bun and the package-relative OpenTUI native runtime."
for runtime in opencode opencode2; do
    command -v "$runtime" >/dev/null 2>&1 || echo "optional runtime not found (not installed automatically): $runtime" >&2
done
