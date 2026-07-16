#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

HOME="$home" "$root/scripts/stow.sh"
touch "$home/.pi/agent/extensions/local-work.ts"
HOME="$home" "$root/scripts/stow.sh"

[[ -L "$home/.pi/agent/extensions/herdr-workflow.ts" ]]
[[ -f "$home/.pi/agent/extensions/local-work.ts" ]]
