#!/usr/bin/env bash
# Downstream verifier gate: frozen install plus complete Bun suite.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root/agentic-coding"
bun install --frozen-lockfile
bun test
