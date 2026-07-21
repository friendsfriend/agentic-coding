#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bun install --cwd "$root/otel-tui" --frozen-lockfile
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/otel-tui/bin/otel-tui" "$HOME/.local/bin/otel-tui"
