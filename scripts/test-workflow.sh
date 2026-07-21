#!/usr/bin/env bash
# Unit test suite for the herdr_workflow package (architecture-refactoring-and-implementation-of-proper-testing).
# Pure logic, per-phase cmd_* tests, per-workflow-type end-to-end tests, and the
# characterization test locking the CLI + state.json contract.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root/pi/lib"

python3 -m unittest discover -s herdr_workflow/tests -t . -v
