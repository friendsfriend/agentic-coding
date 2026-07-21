#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir "$root/bin"
cat > "$root/bin/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HERDR_TEST_CALLS"
case "$1 $2" in
  "tab create") echo '{"result":{"root_pane":{"pane_id":"p-otel"}}}' ;;
  "pane process-info") echo '{"result":{"process_info":{"foreground_processes":[{"name":"zsh"}]}}}' ;;
  "pane run") ;;
esac
EOF
cat > "$root/bin/agent-dash" <<'EOF'
#!/usr/bin/env bash
printf 'agent-dash %s\n' "$*" >> "$HERDR_TEST_CALLS"
EOF
cat > "$root/bin/otel-tui" <<'EOF'
#!/usr/bin/env bash
EOF
chmod +x "$root/bin/"*
HERDR_ENV=1 HERDR_WORKSPACE_ID=w1 HERDR_TEST_CALLS="$root/calls" PATH="$root/bin:$PATH" pi/bin/herdr-manager
rg -qx 'tab create --workspace w1 --label otel-tui --no-focus' "$root/calls"
rg -qx 'pane process-info --pane p-otel' "$root/calls"
rg -qx 'pane run p-otel otel-tui' "$root/calls"
rg -qx 'agent-dash --home' "$root/calls"
