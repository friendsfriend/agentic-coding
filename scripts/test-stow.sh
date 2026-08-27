#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

# First stow: fresh install, no pre-existing herdr symlinks
HOME="$home" "$root/scripts/stow.sh"
config="$home/.config/agentic-coding/config.toml"
[[ -f "$config" ]]
[[ ! -L "$config" ]]
cmp "$root/pi/herdr-workflow.toml" "$config"
[[ ! -L "$home/.pi/agent/herdr-workflow.toml" ]]

# An existing user config, including custom entries, must survive reinstall.
printf '\n[agents.profiles.custom]\nruntime = "pi"\nmodel = "user/model"\n' >> "$config"
custom_config=$(mktemp)
trap 'rm -rf "$home" "$custom_config"' EXIT
cp "$config" "$custom_config"
HOME="$home" "$root/scripts/stow.sh"
cmp "$custom_config" "$config"

# An existing config symlink must also remain untouched.
symlink_target="$home/custom-config.toml"
printf 'user-owned config\n' > "$symlink_target"
rm "$config"
ln -s "$symlink_target" "$config"
HOME="$home" "$root/scripts/stow.sh"
[[ -L "$config" ]]
[[ "$(readlink "$config")" == "$symlink_target" ]]
[[ "$(cat "$symlink_target")" == 'user-owned config' ]]

# Simulate stale herdr symlinks from previous install
ln -s "$root/pi/herdr-workflow.toml" "$home/.pi/agent/herdr-workflow.toml"
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
[[ ! -L "$home/.pi/agent/herdr-workflow.toml" ]]
[[ ! -L "$home/.pi/agent/skills/herdr-openspec-planner" ]]
[[ ! -L "$home/.pi/agent/skills/herdr-openspec-worker" ]]
[[ ! -L "$home/.pi/agent/extensions/herdr-telemetry.ts" ]]
[[ ! -L "$home/.pi/agent/extensions/herdr-workflow.ts" ]]
[[ ! -L "$home/.pi/agent/skills/herdr-manager" ]]

# Verify local extension is preserved
[[ -f "$home/.pi/agent/extensions/local-work.ts" ]]
