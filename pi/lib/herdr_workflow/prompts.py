"""Pure(ish) prompt/argument building. Only local filesystem reads for extension/plugin discovery — no subprocess."""
import json
import shlex
from pathlib import Path

from . import paths

UNRESTRICTED_ROLES = {"planner", "worker"}
ONE_SHOT_ROLES = {"recovery", "archive"}
# Herdr extensions loaded by explicit --extension flag, skip in discovery to avoid double-loading
HERDR_EXTENSIONS = {"herdr-telemetry", "herdr-workflow"}
PI_EXTENSION_DIRS = [paths.AGENT_DIR / "extensions", paths.AGENT_DEF_DIR / "extensions", Path.home() / ".config" / "pi" / "extensions"]

ROLE_TOOLS = {
    "planner": "read,bash,edit,write",
    "triage": "read,bash,edit,write",
    "recovery": "read,bash,edit,write",
    "worker": "read,bash,edit,write",
    "security-verifier": "read,bash",
    "agents-verifier": "read,bash",
    "quality-verifier": "read,bash",
    "performance-verifier": "read,bash",
    "openspec-verifier": "read,bash",
    "test-verifier": "read,bash",
    "archive": "read,bash",
}


def is_one_shot(role):
    return role in ONE_SHOT_ROLES


def role_env(role, change):
    return ["--env", f"HERDR_ROLE={role}", "--env", f"HERDR_CHANGE_ID={change}"]


def discover_extensions():
    """Discover all extension files from standard pi locations."""
    extensions = {}
    for directory in PI_EXTENSION_DIRS:
        if not directory.is_dir():
            continue
        for entry in sorted(directory.iterdir()):
            if entry.suffix in {".ts", ".js", ".mjs"}:
                name = entry.stem
                if name not in extensions:
                    extensions[name] = str(entry)
    return extensions


def load_plugin_assignments():
    """Load plugin-assignments.json if it exists."""
    path = paths.AGENT_DIR / "plugin-assignments.json"
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            print(f"warning: corrupt {path}, starting fresh")
    return {"plugins": []}


def save_plugin_assignments(assignments):
    """Save plugin-assignments.json."""
    path = paths.AGENT_DIR / "plugin-assignments.json"
    path.write_text(json.dumps(assignments, indent=2) + "\n")


def resolve_exclusions(config, role):
    """Resolve excluded extension names for a given role."""
    excluded = set()
    plugins = config.get("plugins", {})
    if "exclude_extensions" in plugins:
        excluded.update(plugins["exclude_extensions"])
    role_config = plugins.get("roles", {}).get(role, {})
    if "exclude_extensions" in role_config:
        excluded.update(role_config["exclude_extensions"])
    return excluded


def role_prompt(role, change, verification_round=None, workflow_type=None, task=None):
    request = f".herdr-workflow/{change}/request.md"
    restricted = " Complete assigned role in this Pi process then stop — do not stay active waiting for next step. You will be notified when needed again. Do not invoke another agent executable or invoke another agent or pane. Use herdr-workflow for required workflow handoff exactly as specified."
    persistent = " Complete this round in this Pi process, then go idle and wait in this same process for the next round's prompt — do not exit, restart, or start unrelated work. Do not invoke another agent executable or invoke another agent or pane. Use herdr-workflow for required workflow handoff exactly as specified."
    if role == "planner":
        return f"Planner for OpenSpec change {change}. Read {request}, explore repository context, and discuss unclear requirements with developer. When asked to propose, write proposal, design, tasks, and delta spec scenarios under openspec/changes/{change}/. Submit with herdr-workflow phase --repo . --change {change} proposed; fix PLAN_REJECTED feedback before finishing."
    if role == "worker":
        if workflow_type == "no-openspec":
            description = f" Implement this change: {task}" if task else ""
            return f"Worker for {change}. Use chat for scope, progress, and blockers. No task checklist to read — signal completion by running herdr-workflow verify --repo . --change {change} once the change is applied.{description}"
        return f"Worker for {change}. Follow loaded skill and use chat for scope, progress, and blockers. Apply approved plan. Mark each OpenSpec task [x] only after focused validation; verification rejects unfinished tasks."
    if role == "triage":
        reviews = f".herdr-workflow/{change}/reviews"
        return f"Silent triage for round {verification_round}. Read {reviews}/round-{verification_round}-triage-input.json only. Select minimum needed reviewers and assign relevant files or hunks. Write {reviews}/round-{verification_round}-triage.json, then run herdr-workflow dispatch-verifiers --repo . --change {change}. No chat output." + persistent
    if role == "security-verifier":
        context = f".herdr-workflow/{change}/reviews/round-{verification_round}-security-verifier-context.md"
        report = f".herdr-workflow/{change}/reviews/round-{verification_round}-security-verifier.findings.jsonl"
        return f"Silent security verifier for {change} round {verification_round}. Read {context}. Review changed trust boundaries for introduced injection, auth, secret, crypto, and input-validation defects. Write JSONL findings plus final PASS/FAIL verdict to {report}, then run herdr-workflow verification-result --repo . --change {change} --role security-verifier. No chat output." + persistent
    if role == "agents-verifier":
        context = f".herdr-workflow/{change}/reviews/round-{verification_round}-agents-verifier-context.md"
        report = f".herdr-workflow/{change}/reviews/round-{verification_round}-agents-verifier.findings.jsonl"
        return f"Silent AGENTS instructions verifier for {change} round {verification_round}. Read {context}. Check changed code only against applicable AGENTS.md and CLAUDE.md instructions. Write JSONL findings plus final PASS/FAIL verdict to {report}, then run herdr-workflow verification-result --repo . --change {change} --role agents-verifier. No chat output." + persistent
    if role == "quality-verifier":
        context = f".herdr-workflow/{change}/reviews/round-{verification_round}-quality-verifier-context.md"
        report = f".herdr-workflow/{change}/reviews/round-{verification_round}-quality-verifier.findings.jsonl"
        return f"Silent code quality verifier for {change} round {verification_round}. Read {context}. Run focused formatting, lint, and type checks; review changed code for concrete correctness and maintainability defects. Write JSONL findings plus final PASS/FAIL verdict to {report}, then run herdr-workflow verification-result --repo . --change {change} --role quality-verifier. No chat output." + persistent
    if role == "performance-verifier":
        context = f".herdr-workflow/{change}/reviews/round-{verification_round}-performance-verifier-context.md"
        report = f".herdr-workflow/{change}/reviews/round-{verification_round}-performance-verifier.findings.jsonl"
        return f"Silent performance verifier for {change} round {verification_round}. Read {context}. Review changed hot paths for measurable query, I/O, CPU, blocking, and memory regressions. Write JSONL findings plus final PASS/FAIL verdict to {report}, then run herdr-workflow verification-result --repo . --change {change} --role performance-verifier. No chat output." + persistent
    if role == "openspec-verifier":
        context = f".herdr-workflow/{change}/reviews/round-{verification_round}-openspec-verifier-context.md"
        report = f".herdr-workflow/{change}/reviews/round-{verification_round}-openspec-verifier.findings.jsonl"
        return f"Silent OpenSpec verifier for {change} round {verification_round}. Read {context}. Compare implementation against approved proposal, design, specs, and tasks for missing, incompatible, or out-of-scope behavior. Write JSONL findings plus final PASS/FAIL verdict to {report}, then run herdr-workflow verification-result --repo . --change {change} --role openspec-verifier. No chat output." + persistent
    if role == "test-verifier":
        context = f".herdr-workflow/{change}/reviews/round-{verification_round}-test-verifier-context.md"
        report = f".herdr-workflow/{change}/reviews/round-{verification_round}-test-verifier.findings.jsonl"
        return f"Silent full-suite test verifier for {change} round {verification_round}. Read {context}. Find and run repository's complete configured test suite without filters; PASS requires successful suite and regression coverage. Write JSONL findings plus final PASS/FAIL verdict to {report}, then run herdr-workflow verification-result --repo . --change {change} --role test-verifier. No chat output." + persistent
    if role == "archive":
        return f"Silent archive agent for OpenSpec change {change}. Read .herdr-workflow/{change}/reviews/archive-context.md only; do not read review history or telemetry. Follow its archive instructions, then run herdr-workflow archive --repo . --change {change}. No chat output." + restricted
    if role == "recovery":
        return f"Silent recovery agent for {change}. Read .herdr-workflow/{change}/reviews/recovery-context.json. Write .herdr-workflow/{change}/reviews/recovery-plan.json with matching recoveryId and exactly one allowlisted action: retry-verification, dispatch-triage, or record-verifier-result (include role). Do not execute plan, mutate state, commit, push, or archive. No chat output." + restricted
    raise ValueError(f"unknown role: {role}")


def pi_arguments(role, model, thinking, change, config):
    """Build Pi arguments for a Herdr-managed role agent."""
    skill = paths.SKILLS / f"herdr-openspec-{role}" / "SKILL.md"
    tools = ROLE_TOOLS[role]
    parts = ["--name", f"{change}-{role}", "--model", model, "--thinking", thinking]

    if role in UNRESTRICTED_ROLES:
        exclusions = resolve_exclusions(config, role)
        if exclusions:
            parts.append("--no-extensions")
            parts.extend(["--extension", str(paths.AGENT_DEF_DIR / "extensions" / "herdr-telemetry.ts")])
            parts.extend(["--extension", str(paths.AGENT_DEF_DIR / "extensions" / "herdr-workflow.ts")])
            for name, path in discover_extensions().items():
                if name not in exclusions and name not in HERDR_EXTENSIONS:
                    parts.extend(["--extension", path])
        else:
            parts.extend(["--extension", str(paths.AGENT_DEF_DIR / "extensions" / "herdr-telemetry.ts")])
            parts.extend(["--extension", str(paths.AGENT_DEF_DIR / "extensions" / "herdr-workflow.ts")])
        parts.extend(["--no-prompt-templates", "--skill", str(skill)])
    else:
        parts.extend([
            "--tools", tools, "--no-extensions",
            "--extension", str(paths.AGENT_DEF_DIR / "extensions" / "herdr-telemetry.ts"),
            "--extension", str(paths.AGENT_DEF_DIR / "extensions" / "herdr-workflow.ts"),
            "--no-prompt-templates", "--no-skills", "--skill", str(skill),
        ])

    if is_one_shot(role):
        parts.append("--no-session")
    if role == "archive":
        parts.append("--no-context-files")
    return parts
