#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root/agent-dash"
bun install --frozen-lockfile
bun run install:bin
