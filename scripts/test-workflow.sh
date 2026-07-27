#!/usr/bin/env bash
# Unit test suite for the agentic-coding workflow engine (consolidate-workflow-to-typescript).
# Pure logic, per-phase cmd_* tests, per-workflow-type end-to-end tests, and the
# characterization test locking the CLI + state.json contract.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root/agentic-coding"

bun install --frozen-lockfile
bun test
