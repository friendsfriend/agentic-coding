#!/usr/bin/env bash
# Integration test for agent-plugin system (add-agent-plugin-system change)
# Tests: extension discovery, role classification, exclusion config, plugin commands,
#        deep_merge, plugin-assignments persistence, all pi_command branches
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lib="$root/pi/lib"
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

# Override AGENT_DIR
export PI_CODING_AGENT_DIR="$home/.pi/agent"
mkdir -p "$home/.pi/agent/extensions"
mkdir -p "$home/.pi"

# Create test extensions
echo "export const tools = [];" > "$home/.pi/agent/extensions/test-jira.ts"
echo "export const tools = [];" > "$home/.pi/agent/extensions/test-websearch.ts"
echo "export const tools = [];" > "$home/.pi/agent/extensions/test-db.ts"

PASS=0
FAIL=0

pass() {
    PASS=$((PASS+1))
    echo "  PASS  $1"
}

fail() {
    FAIL=$((FAIL+1))
    echo "  FAIL  $1: $2"
}

# Helper: run a Python snippet that has access to the workflow module
run_py() {
    python3 -c "
import json, os, sys, tempfile
from pathlib import Path

sys.path.insert(0, '$lib')
from herdr_workflow import commands, effects, paths, prompts

class _ModuleProxy:
    \"\"\"Forwards mod.X reads/writes to whichever submodule actually defines X,
    so this test script's pre-refactor-style attribute pokes keep working against
    the decomposed herdr_workflow package.\"\"\"
    _targets = (paths, prompts, effects, commands)

    def __getattr__(self, name):
        for target in self._targets:
            if hasattr(target, name):
                return getattr(target, name)
        raise AttributeError(name)

    def __setattr__(self, name, value):
        for target in self._targets:
            if hasattr(target, name):
                setattr(target, name, value)
                return
        setattr(paths, name, value)

mod = _ModuleProxy()
# Override AGENT_DIR to test home
mod.AGENT_DIR = Path('$home/.pi/agent')
mod.PI_EXTENSION_DIRS = [Path('$home/.pi/agent/extensions'), mod.AGENT_DEF_DIR / 'extensions']
# Override AGENT_DEF_DIR to test-isolated path
mod.AGENT_DEF_DIR = Path('$home/agent-definitions')
(mod.AGENT_DEF_DIR / 'extensions').mkdir(parents=True, exist_ok=True)
(mod.AGENT_DEF_DIR / 'skills').mkdir(parents=True, exist_ok=True)
# Create mock herdr extensions and skills for test isolation
(mod.AGENT_DEF_DIR / 'extensions' / 'herdr-telemetry.ts').write_text('export const tools = [];')
(mod.AGENT_DEF_DIR / 'extensions' / 'herdr-workflow.ts').write_text('export const tools = [];')
for role in ['planner','worker','triage','recovery','archive','security-verifier','agents-verifier','quality-verifier','performance-verifier','openspec-verifier','test-verifier']:
    skill_dir = mod.AGENT_DEF_DIR / 'skills' / f'herdr-openspec-{role}'
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / 'SKILL.md').write_text(f'# {role} skill')

$1
" 2>&1
}

# ---------------------------------------------------------------
# Test discover_extensions
# ---------------------------------------------------------------

echo "=== discover_extensions ==="

result=$(run_py '
exts = mod.discover_extensions()
print(json.dumps(sorted(exts.keys())))
')
if echo "$result" | grep -q "test-jira" && echo "$result" | grep -q "test-websearch" && echo "$result" | grep -q "test-db"; then
    pass "discovers all extension files"
else
    fail "discovers all extension files" "got $result"
fi

result=$(run_py '
mod.PI_EXTENSION_DIRS = [Path(tempfile.mkdtemp())]
exts = mod.discover_extensions()
print(json.dumps(exts))
')
if [ "$result" = "{}" ]; then
    pass "empty dir returns empty dict"
else
    fail "empty dir returns empty dict" "got $result"
fi

# Test dedup
result=$(run_py '
import tempfile
d1 = Path(tempfile.mkdtemp())
d2 = Path(tempfile.mkdtemp())
(d1 / "dup.ts").write_text("")
(d2 / "dup.ts").write_text("")
old = mod.PI_EXTENSION_DIRS
mod.PI_EXTENSION_DIRS = [d1, d2]
try:
    exts = mod.discover_extensions()
    print(exts.get("dup", "missing"))
finally:
    mod.PI_EXTENSION_DIRS = old
')
if echo "$result" | grep -q "dup.ts"; then
    pass "dedup keeps first occurrence"
else
    fail "dedup keeps first occurrence" "got $result"
fi

# ---------------------------------------------------------------
# Test _deep_merge
# ---------------------------------------------------------------

echo "=== _deep_merge ==="

result=$(run_py '
base = {"a": 1, "b": {"c": 2}}
merged = mod._deep_merge(base, {})
print(json.dumps(merged, sort_keys=True))
')
if [ "$result" = '{"a": 1, "b": {"c": 2}}' ]; then
    pass "empty overlay does not change base"
else
    fail "empty overlay" "got $result"
fi

result=$(run_py '
base = {"a": 1}
merged = mod._deep_merge(base, {"b": 2})
print(json.dumps(merged, sort_keys=True))
')
if [ "$result" = '{"a": 1, "b": 2}' ]; then
    pass "new keys from overlay added"
else
    fail "new keys" "got $result"
fi

result=$(run_py '
base = {"a": 1, "b": 2}
merged = mod._deep_merge(base, {"b": 3})
print(json.dumps(merged, sort_keys=True))
')
if [ "$result" = '{"a": 1, "b": 3}' ]; then
    pass "scalar overwritten by overlay"
else
    fail "scalar overwrite" "got $result"
fi

result=$(run_py '
base = {"plugins": {"exclude_extensions": ["a"]}}
overlay = {"plugins": {"roles": {"worker": {"exclude_extensions": ["b"]}}}}
merged = mod._deep_merge(base, overlay)
print(json.dumps(merged, sort_keys=True))
')
if echo "$result" | grep -q "worker" && echo "$result" | grep -q '"a"'; then
    pass "nested dict merge preserves both"
else
    fail "nested dict merge" "got $result"
fi

result=$(run_py '
base = {"plugins": {"roles": {"worker": {"x": [1]}}}}
overlay = {"plugins": {"roles": {"worker": {"x": [2]}}}}
merged = mod._deep_merge(base, overlay)
print(json.dumps(merged, sort_keys=True))
')
if echo "$result" | grep -q '2'; then
    pass "nested scalar overwritten"
else
    fail "nested scalar overwrite" "got $result"
fi

# ---------------------------------------------------------------
# Test resolve_exclusions
# ---------------------------------------------------------------

echo "=== resolve_exclusions ==="

result=$(run_py '
ex = mod.resolve_exclusions({}, "planner")
print(sorted(ex))
')
if [ "$result" = "[]" ]; then
    pass "no config returns empty set"
else
    fail "no config" "got $result"
fi

result=$(run_py '
cfg = {"plugins": {"exclude_extensions": ["ext-a", "ext-b"]}}
ex = mod.resolve_exclusions(cfg, "planner")
print(sorted(ex))
')
if [ "$result" = "['ext-a', 'ext-b']" ]; then
    pass "global exclusions returned for any role"
else
    fail "global exclusions" "got $result"
fi

result=$(run_py '
cfg = {"plugins": {"exclude_extensions": ["g"], "roles": {"worker": {"exclude_extensions": ["w"]}}}}
ex_w = mod.resolve_exclusions(cfg, "worker")
ex_p = mod.resolve_exclusions(cfg, "planner")
print(json.dumps({"worker": sorted(ex_w), "planner": sorted(ex_p)}))
')
if echo "$result" | grep -q '"worker".*"g".*"w"' && echo "$result" | grep -q '"planner".*"g"'; then
    pass "per-role exclusions merge with global"
else
    fail "per-role exclusions" "got $result"
fi

# ---------------------------------------------------------------
# Test plugin-assignments.json persistence
# ---------------------------------------------------------------

echo "=== plugin-assignments ==="

result=$(run_py '
a = mod.load_plugin_assignments()
print(json.dumps(a))
')
if [ "$result" = '{"plugins": []}' ]; then
    pass "load empty returns default"
else
    fail "load empty" "got $result"
fi

result=$(run_py '
data = {"plugins": [{"source": "npm:@foo/ext", "agentRoles": ["worker"]}]}
mod.save_plugin_assignments(data)
loaded = mod.load_plugin_assignments()
print(json.dumps(loaded))
')
if echo "$result" | grep -q "npm:@foo/ext" && echo "$result" | grep -q "worker"; then
    pass "save and load roundtrip"
else
    fail "save/load roundtrip" "got $result"
fi

# ---------------------------------------------------------------
# Test pi_command roles
# ---------------------------------------------------------------

echo "=== pi_command role classification ==="

# Unrestricted roles
for role in planner worker; do
    result=$(run_py "
cmd = mod.pi_command('$role', 'test-model', 'high', 'test-change')
print(cmd)
")
    if echo "$result" | grep -q "herdr-telemetry.ts"; then
        : # good
    else
        fail "$role telemetry" "no herdr-telemetry.ts in command"
        continue
    fi
    if echo "$result" | grep -q "herdr-workflow.ts"; then
        : # good
    else
        fail "$role workflow" "no herdr-workflow.ts in command"
        continue
    fi
    if echo "$result" | grep -q -- "--no-extensions"; then
        fail "$role no-extensions" "unrestricted role should not have --no-extensions"
        continue
    fi
    if echo "$result" | grep -q -- "--no-skills"; then
        fail "$role no-skills" "unrestricted role should not have --no-skills"
        continue
    fi
    if echo "$result" | grep -q -- "--tools "; then
        fail "$role tools" "unrestricted role should not have --tools restriction"
        continue
    fi
    pass "$role unrestricted (no --no-extensions, --no-skills, --tools)"
done

# Restricted: verifiers
for role in security-verifier agents-verifier quality-verifier performance-verifier openspec-verifier test-verifier; do
    result=$(run_py "
cmd = mod.pi_command('$role', 'test-model', 'high', 'test-change')
print(cmd)
")
    if ! echo "$result" | grep -q -- "--no-extensions"; then
        fail "$role no-extensions" "restricted verifier should have --no-extensions"
        continue
    fi
    if ! echo "$result" | grep -q -- "--no-skills"; then
        fail "$role no-skills" "restricted verifier should have --no-skills"
        continue
    fi
    if ! echo "$result" | grep -q -- "--tools "; then
        fail "$role tools" "restricted verifier should have --tools"
        continue
    fi
    pass "$role restricted (--no-extensions, --no-skills, --tools)"
done

# Restricted: triage, recovery, archive
for role in triage recovery; do
    result=$(run_py "
cmd = mod.pi_command('$role', 'test-model', 'high', 'test-change')
print(cmd)
")
    if ! echo "$result" | grep -q -- "--no-extensions"; then
        fail "$role no-extensions" "should have --no-extensions"
        continue
    fi
    if ! echo "$result" | grep -q -- "--no-skills"; then
        fail "$role no-skills" "should have --no-skills"
        continue
    fi
    pass "$role restricted (--no-extensions, --no-skills)"
done

# Archive (also has --no-context-files)
result=$(run_py "
cmd = mod.pi_command('archive', 'test-model', 'high', 'test-change')
print(cmd)
")
if echo "$result" | grep -q -- "--no-extensions" && echo "$result" | grep -q -- "--no-skills" && echo "$result" | grep -q -- "--no-context-files"; then
    pass "archive restricted (--no-extensions, --no-skills, --no-context-files)"
else
    fail "archive restricted" "got $result"
fi

# ---------------------------------------------------------------
# Test pi_command with exclusion config
# ---------------------------------------------------------------

echo "=== pi_command with exclusions ==="

result=$(run_py '
import os, tempfile
from pathlib import Path
old_config = mod.CONFIG
config_path = None
try:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False) as f:
        f.write("[plugins]\nexclude_extensions = [\"test-websearch\"]\n")
        config_path = f.name
    mod.CONFIG = Path(config_path)
    cmd = mod.pi_command("planner", "test-model", "high", "test-change")
    print(cmd[:500])
finally:
    mod.CONFIG = old_config
    if config_path:
        os.unlink(config_path)
')
if echo "$result" | grep -q -- "--no-extensions"; then
    : # good
else
    fail "with exclusions --no-extensions" "exclusions should trigger --no-extensions: $result"
fi
if echo "$result" | grep -q "test-websearch"; then
    fail "with exclusions filtered" "excluded extension should not be loaded"
elif echo "$result" | grep -q "herdr-telemetry.ts"; then
    pass "planner with exclusions (--no-extensions, filtered, telemetry loaded)"
else
    fail "with exclusions telemetry" "telemetry should be loaded: $result"
fi

# ---------------------------------------------------------------
# Test load_config merges project config
# ---------------------------------------------------------------

echo "=== load_config merging ==="

result=$(run_py '
import os, tempfile, tomllib
from pathlib import Path
# Create global config
global_cfg = tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False)
global_cfg.write("[workflow]\nmax_verification_rounds = 3\n[plugins]\nexclude_extensions = [\"g\"]\n")
global_cfg.close()
# Create project config
project_dir = Path(tempfile.mkdtemp())
project_cfg = project_dir / ".pi" / "herdr-workflow.toml"
project_cfg.parent.mkdir(parents=True)
project_cfg.write_text("[plugins.roles.worker]\nexclude_extensions = [\"w\"]\n")
# Override CONFIG and cwd
old_cwd = os.getcwd()
os.chdir(str(project_dir))
old_config = mod.CONFIG
mod.CONFIG = Path(global_cfg.name)
try:
    cfg = mod.load_config()
    print(json.dumps(cfg, sort_keys=True))
finally:
    mod.CONFIG = old_config
    os.chdir(old_cwd)
    os.unlink(global_cfg.name)
')
if echo "$result" | grep -q "max_verification_rounds" && echo "$result" | grep -q '"w"' && echo "$result" | grep -q '"g"'; then
    pass "load_config merges project into global"
else
    fail "load_config merge" "got $result"
fi

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
