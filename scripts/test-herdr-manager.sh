#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir "$root/bin"
cat > "$root/bin/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HERDR_TEST_CALLS"
echo '{"result":{"type":"ok"}}'
EOF
cat > "$root/bin/agentic-coding" <<'EOF'
#!/usr/bin/env bash
printf 'agentic-coding %s\n' "$*" >> "$HERDR_TEST_CALLS"
EOF
chmod +x "$root/bin/"*
HERDR_ENV=1 HERDR_WORKSPACE_ID=w1 HERDR_TEST_CALLS="$root/calls" PATH="$root/bin:$PATH" pi/bin/herdr-manager
rg -qx 'agentic-coding manager' "$root/calls"
