#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

# First stow: fresh install, no pre-existing herdr symlinks
HOME="$home" "$root/scripts/stow.sh"

# Simulate stale herdr symlinks from previous install
mkdir -p "$home/.pi/agent/skills"
mkdir -p "$home/.pi/agent/extensions"
ln -s /dev/null "$home/.pi/agent/skills/herdr-openspec-planner"
ln -s /dev/null "$home/.pi/agent/skills/herdr-openspec-worker"
ln -s /dev/null "$home/.pi/agent/extensions/herdr-telemetry.ts"
ln -s /dev/null "$home/.pi/agent/extensions/herdr-workflow.ts"
ln -s /dev/null "$home/.pi/agent/skills/herdr-manager"

# Add a local (non-herdr) extension that should be preserved
touch "$home/.pi/agent/extensions/local-work.ts"

# Second stow: cleanup should remove stale herdr symlinks, preserve local
HOME="$home" "$root/scripts/stow.sh"

# Verify stale herdr symlinks are removed
[[ ! -L "$home/.pi/agent/skills/herdr-openspec-planner" ]]
[[ ! -L "$home/.pi/agent/skills/herdr-openspec-worker" ]]
[[ ! -L "$home/.pi/agent/extensions/herdr-telemetry.ts" ]]
[[ ! -L "$home/.pi/agent/extensions/herdr-workflow.ts" ]]
[[ ! -L "$home/.pi/agent/skills/herdr-manager" ]]

# Verify local extension is preserved
[[ -f "$home/.pi/agent/extensions/local-work.ts" ]]
