#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bun install --cwd "$root/agentic-coding" --frozen-lockfile
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/agentic-coding/bin/agentic-coding" "$HOME/.local/bin/agentic-coding"
