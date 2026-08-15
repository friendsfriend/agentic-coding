#!/usr/bin/env bash
# CLI smoke for new registry/view/action/repair/handoff surface.
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
repo="$root/repo"
mkdir -p "$repo"
git -C "$repo" init -q -b main
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
printf 'smoke\n' > "$repo/README.md"
git -C "$repo" add .
git -C "$repo" commit -qm init
git init -q --bare "$root/remote.git"
git -C "$repo" remote add origin "$root/remote.git"
git -C "$repo" push -q -u origin main

runtime=sh
runtime_path=""
if [[ "${HERDR_LIVE_RUNTIME_SMOKE:-0}" != 1 ]]; then
  mkdir -p "$root/bin"
  cat > "$root/bin/herdr" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"smoke-workspace"}}}' ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"smoke-pane","tab_id":"smoke-tab"}}}' ;;
  "pane process-info") echo '{"result":{"process_info":{"foreground_processes":[{"name":"sh"}]}}}' ;;
  "agent start"|"agent get") echo '{"result":{"agent":{"pane_id":"smoke-pane","tab_id":"smoke-tab","agent_status":"working"}}}' ;;
  "agent prompt"|"agent stop"|"pane close") echo '{"result":{}}' ;;
  *) echo "unsupported fake herdr call: $*" >&2; exit 2 ;;
esac
SH
  chmod +x "$root/bin/herdr"
  runtime_path="$root/bin:"
else
  runtime=${HERDR_LIVE_RUNTIME_EXECUTABLE:-pi}
fi

config="$root/config.toml"
cat > "$config" <<TOML
[agents]
default_profile = "smoke"
[agents.profiles.smoke]
runtime = "pi"
executable = "$runtime"
capabilities = ["prompt", "run-environment", "observe"]
[agents.profiles.smoke-review]
runtime = "pi"
executable = "$runtime"
capabilities = ["prompt", "run-environment", "observe"]
read_only = true
[agents.routes]
"core.triage" = "smoke-review"
"core.verification" = "smoke-review"
"core.archive" = "smoke-review"
[workflow]
max_verification_rounds = 6
remote = "origin"
branch_prefix = "feature/"
base_branch = "main"
[projects]
root = "/tmp"
max_depth = 1
[telemetry]
capture_content = false
[ui]
theme = "catppuccin"
selection_height = 10
TOML

wf() { PATH="${runtime_path}${PATH}" HERDR_WORKFLOW_CONFIG="$config" agentic-coding workflow "$@"; }
wf --help | grep -q 'agent-extension'
wf start --repo "$repo" --change smoke --mode checkout --workflow no-openspec --task 'smoke task' >/dev/null
view=$(wf status --repo "$repo" --change smoke)
revision=$(printf '%s' "$view" | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["definition"]["id"] == "no-openspec"; assert v["currentStep"]["id"] == "core.implementation"; assert v["health"]["valid"]; print(v["revision"])')
wf repair --repo "$repo" --change smoke --revision "$revision" --step core.implementation --reason 'smoke repair' --confirm >/dev/null
wf status --repo "$repo" --change smoke | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["status"] == "paused"; assert [a["id"] for a in v["availableActions"]] == ["resume"]'
if wf verify --repo "$repo" --change smoke >/dev/null 2>&1; then
  echo 'legacy verify command unexpectedly accepted' >&2
  exit 1
fi
printf 'workflow smoke passed\n'
