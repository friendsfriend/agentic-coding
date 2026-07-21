"""cmd_* orchestration: wires pure logic (transitions/tiering/findings/recovery/tracing/gates)
to effects (herdr/git/clock/exporter) via the Context."""
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from . import effects, findings, gates, paths, prompts, recovery, tiering, tracing, transitions
from . import state as state_mod

PROMPT_SUBMIT_ATTEMPTS = 3
PROMPT_VERIFY_WINDOW_MS = 3000  # window to observe the agent leave idle after a submit action
PROMPT_IDLE_TIMEOUT_MS = 8000
LAUNCH_SUBMIT_ATTEMPTS = 3
LAUNCH_SETTLE_TIMEOUT_MS = 10000  # cold pi boot (loading extensions/skills) needs more room than a routine prompt


def _wait_status(ctx, pane_id, status, timeout_ms):
    """True once `pane_id`'s agent reaches `status` (immediately if already there),
    False if the window elapses first. Backs every submission-verification check:
    `herdr agent get` has no sequence counter in this herdr build (no
    `state_change_seq` field), so status transitions are the only observable signal.
    """
    try:
        ctx.herdr.call("wait", "agent-status", pane_id, "--status", status, "--timeout", str(timeout_ms))
        return True
    except SystemExit:
        return False


def _submit_verified(ctx, pane_id, text, confirm_status, confirm_timeout_ms, attempts, not_acknowledged_message):
    """Submit `text` via `pane run`, confirmed by `confirm_status`. `pane run`'s
    Enter can race the target pane's readiness (bracketed-paste ingestion on a
    running pi TUI, or shell-not-settled right after `tab create`) and land the
    text prefilled-but-unsubmitted. An explicit `send-keys enter` nudge handles
    that; a bounded ctrl+c + resubmit handles the rest.
    """
    for attempt in range(attempts):
        ctx.herdr.call("pane", "run", pane_id, text)
        if _wait_status(ctx, pane_id, confirm_status, confirm_timeout_ms):
            return
        ctx.herdr.call("pane", "send-keys", pane_id, "enter")
        if _wait_status(ctx, pane_id, confirm_status, confirm_timeout_ms):
            return
        if attempt == attempts - 1:
            raise SystemExit(not_acknowledged_message)
        ctx.herdr.call("pane", "send-keys", pane_id, "ctrl+c")
        ctx.clock.sleep(0.3)


# ---------------------------------------------------------------------------
# git/ssh/branch helpers
# ---------------------------------------------------------------------------

def ensure_clean(ctx, repo, require_openspec=True):
    if ctx.git.run("status", "--porcelain", cwd=repo):
        raise SystemExit("working tree is dirty; commit or clean it first")
    if require_openspec and not (Path(repo) / "openspec" / "config.yaml").exists():
        raise SystemExit(f"OpenSpec project not found: {repo}/openspec/config.yaml")


def ensure_base_fresh(ctx, state):
    base = state.get("baseBranch", ctx.config["workflow"].get("base_branch", "origin/HEAD"))
    try:
        current = ctx.git.run("rev-parse", "--verify", base, cwd=state["worktree"])
    except SystemExit:
        return  # legacy/local workflow without a tracked remote base
    if current != state.get("baseCommit"):
        raise SystemExit(f"base branch moved: {base} is now {current[:12]}, workflow planned against {state.get('baseCommit', '')[:12]}; rebase/replan explicitly")


def unlock_ssh_keys(ctx, repo, remote, passphrase):
    """Add configured SSH identities to running agent without persisting secret."""
    if not passphrase:
        return
    url = ctx.git.run("remote", "get-url", remote, cwd=repo)
    match = re.match(r"ssh://(?:[^@/]+@)?([^/:]+)", url) or re.match(r"(?:[^@/:]+@)?([^/:]+)(?::|/)", url)
    identities = []
    if match:
        probe = subprocess.run(["ssh", "-G", match.group(1)], text=True, capture_output=True, check=False)
        identities = [str(Path(line.split(None, 1)[1]).expanduser()) for line in probe.stdout.splitlines() if line.startswith("identityfile ") and Path(line.split(None, 1)[1]).expanduser().is_file()]
    passphrase_fd, passphrase_path = tempfile.mkstemp(prefix="herdr-ssh-passphrase-")
    script_fd, script_path = tempfile.mkstemp(prefix="herdr-ssh-askpass-")
    try:
        os.write(passphrase_fd, passphrase.encode())
        os.close(passphrase_fd)
        os.chmod(passphrase_path, 0o600)
        os.write(script_fd, f'#!/bin/sh\ncat "{passphrase_path}"\n'.encode())
        os.close(script_fd)
        os.chmod(script_path, 0o700)
        env = {**os.environ, "SSH_ASKPASS": script_path, "SSH_ASKPASS_REQUIRE": "force", "DISPLAY": os.environ.get("DISPLAY", ":0")}
        result = subprocess.run(["ssh-add", *identities], text=True, capture_output=True, env=env, check=False)
        if result.returncode:
            raise SystemExit("could not unlock SSH key: " + (result.stderr or result.stdout or "ssh-add failed").strip())
    finally:
        for fd in (passphrase_fd, script_fd):
            try:
                os.close(fd)
            except OSError:
                pass
        Path(passphrase_path).unlink(missing_ok=True)
        Path(script_path).unlink(missing_ok=True)


def remote_default_branch(ctx, repo, remote):
    ctx.git.run("fetch", remote, "--prune", cwd=repo)
    return ctx.git.run("symbolic-ref", "--quiet", "--short", f"refs/remotes/{remote}/HEAD", cwd=repo)


def ensure_workflow_branch(ctx, state):
    current = ctx.git.run("branch", "--show-current", cwd=state["worktree"])
    if current != state["branch"]:
        raise SystemExit(f"wrong branch checked out: {current or '(detached)'}; expected {state['branch']}. Switch to the workflow branch before commit/push.")


def create_tab(ctx, workspace, label, role=None, change=None):
    args = ["tab", "create", "--workspace", workspace]
    if role:
        args.extend(prompts.role_env(role, change))
    args.extend(["--label", label])
    return ctx.herdr.call(*args)["root_pane"]


def has_role_pane(state, role):
    return state["panes"].get(role) is not None


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

def cmd_start(ctx, args):
    config = ctx.config
    args.ticket = args.ticket.strip() if args.ticket else None
    ticket_branch = re.sub(r"[^A-Za-z0-9._-]+", "-", args.ticket).strip(".-") if args.ticket else None
    if args.ticket and not re.search(r"[A-Za-z0-9]", args.ticket):
        raise SystemExit("ticket identifier must contain at least one letter or digit")
    source = str(Path(args.repo).expanduser().resolve())
    passphrase = os.environ.pop("HERDR_SSH_PASSPHRASE", "")
    ensure_clean(ctx, source, require_openspec=getattr(args, "workflow_type", "standard") != "no-openspec")
    remote = config["workflow"]["remote"]
    unlock_ssh_keys(ctx, source, remote, passphrase)
    base_branch = remote_default_branch(ctx, source, remote)
    base = ctx.git.run("rev-parse", "--verify", base_branch, cwd=source)
    branch_name = f"{ticket_branch}-{args.change}" if ticket_branch else args.change
    branch = config["workflow"]["branch_prefix"] + branch_name

    if args.mode == "worktree":
        result = ctx.herdr.call("worktree", "create", "--cwd", source, "--branch", branch, "--base", base, "--no-focus")
        workspace = result["workspace"]["workspace_id"]
        root = result["root_pane"]["pane_id"]
        worktree = result["worktree"]["path"]
    else:
        if ctx.git.run("branch", "--list", branch, cwd=source):
            raise SystemExit(f"branch already exists: {branch}")
        ctx.git.run("switch", "-c", branch, base, cwd=source)
        result = ctx.herdr.call("workspace", "create", "--cwd", source, "--label", args.change)
        workspace = result["workspace"]["workspace_id"]
        root = result["root_pane"]["pane_id"]
        worktree = source

    ctx.herdr.call("workspace", "rename", workspace, args.change)
    first_tab = ctx.herdr.call("tab", "list", "--workspace", workspace)["tabs"][0]["tab_id"]
    ctx.herdr.call("tab", "rename", first_tab, "dashboard")
    git_tab = create_tab(ctx, workspace, "git")
    panes = {"dashboard": root, "git": git_tab["pane_id"]}
    tabs = {"dashboard": first_tab, "git": git_tab["tab_id"]}
    models = config["models"]
    worker = args.worker or models["worker_default"]
    modules = list(transitions.WORKFLOW_TYPES[getattr(args, "workflow_type", "standard")])
    initial_phase = transitions.WORKFLOW_MODULES[modules[0]]["entry"]
    initial_roles = transitions.WORKFLOW_MODULES[modules[0]]["roles"]
    state = {
        "changeId": args.change, "phase": initial_phase, "repository": source,
        "worktree": worktree, "branch": branch, "workspace": workspace,
        "task": args.task, "ticketNumber": args.ticket, "workerModel": worker, "verificationRound": 0,
        "returnWorkspace": os.environ.get("HERDR_WORKSPACE_ID"), "baseBranch": base_branch, "baseCommit": base, "developerApproval": False, "panes": panes, "tabs": tabs,
        "workflowModules": modules,
        "workflowType": getattr(args, "workflow_type", "standard"),
        "createdAt": ctx.clock.now().isoformat(),
        "otelTraceRoot": tracing.child_context(tracing.parse_traceparent(os.environ.get("TRACEPARENT"))),
        "otelTraceRootStartedUnixNano": str(ctx.clock.time_ns()),
    }
    state_mod.save_state(state)
    request = Path(worktree) / ".herdr-workflow" / args.change / "request.md"
    ticket = f"\n**Ticket:** {args.ticket}\n" if args.ticket else ""
    task = args.task.strip() if args.task else ""
    if task:
        request.write_text(f"# {args.change}\n{ticket}{task}\n")
    else:
        request.write_text(f"# {args.change}\n{ticket}")
    if source != worktree:
        source_request = Path(source) / ".herdr-workflow" / args.change / "request.md"
        source_request.parent.mkdir(parents=True, exist_ok=True)
        source_request.write_text(request.read_text())
    for checkout in {source, worktree}:
        exclude = Path(ctx.git.run("rev-parse", "--git-path", "info/exclude", cwd=checkout))
        if not exclude.is_absolute():
            exclude = Path(checkout) / exclude
        exclude.parent.mkdir(parents=True, exist_ok=True)
        if not exclude.exists() or ".herdr-workflow/" not in exclude.read_text():
            with exclude.open("a") as file:
                file.write("\n.herdr-workflow/\n")
    dashboard = shlex.join(["agent-dash", "--repo", worktree, "--change", args.change])
    ctx.herdr.call("pane", "run", panes["dashboard"], dashboard)
    ctx.herdr.call("pane", "run", panes["git"], "lazygit")
    for role in initial_roles:
        start_role(ctx, state, role)
    print(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# role lifecycle: launch, prompt, start
# ---------------------------------------------------------------------------

def provider_unhealthy(ctx, model):
    path = paths.AGENT_DIR / "herdr-provider-health.json"
    if not path.exists():
        return False
    try:
        health = json.loads(path.read_text()).get(model.split("/", 1)[0], {})
        last = datetime.fromisoformat(health.get("lastFailure", "1970-01-01T00:00:00+00:00"))
        return health.get("failures", 0) >= 3 and (ctx.clock.now() - last).total_seconds() < 120
    except (ValueError, TypeError):
        return False


def role_agent_name(state, role):
    return f"{state['changeId']}-{role}"


def _close_old_pane(ctx, state, role):
    old = state.get("panes", {}).get(role)
    if old:
        try:
            ctx.herdr.call("pane", "close", old)
        except SystemExit:
            pass


def launch_role(ctx, state, role):
    """Spawn a role's pi agent: `tab create` -> `pane run "pi ..."` -> optional `agent rename`.

    Replaces the old `agent start` + `pane move --new-tab` path (and its 25x
    "not an available shell" retry loop): `tab create` returns a settled pane,
    so `pane run` lands in a ready shell without the spawn race.
    """
    config = ctx.config
    models = config["models"]
    thinking = config["thinking"]
    model = state["workerModel"] if role == "worker" else models.get(role.replace("-", "_"), models["verifier"]) if role.endswith("-verifier") else models.get(role, models.get("archive", models["verifier"]))
    level = thinking["worker_default"] if role == "worker" else thinking["verifier_lite"] if role.endswith("-verifier") and state.get("verificationTier") == "lite" else thinking["verifier"] if role.endswith("-verifier") else thinking.get(role, thinking.get("archive", thinking["verifier"]))
    if role.endswith("-verifier") and provider_unhealthy(ctx, model) and models.get("verifier_fallback"):
        telemetry(ctx, state, "provider_circuit_open", role=role, model=model, fallback=models["verifier_fallback"])
        model = models["verifier_fallback"]
    label = {"planner": "explore", "worker": "apply"}.get(role, role.removesuffix("-verifier"))
    change = state["changeId"]

    def spawn(spawn_model):
        _close_old_pane(ctx, state, role)
        tab = ctx.herdr.call("tab", "create", "--workspace", state["workspace"], "--label", label, *prompts.role_env(role, change), "--no-focus")
        pane_id = tab["root_pane"]["pane_id"]
        tab_id = tab["root_pane"]["tab_id"]  # `tab create`'s result has no top-level tab_id
        pi_cmd = shlex.join(["pi", *prompts.pi_arguments(role, spawn_model, level, change, config)])
        try:
            # Confirm pi actually started (reaches idle once booted), not just that the
            # launch line landed prefilled in a not-yet-ready shell.
            _submit_verified(ctx, pane_id, pi_cmd, "idle", LAUNCH_SETTLE_TIMEOUT_MS, LAUNCH_SUBMIT_ATTEMPTS, f"agent launch was not acknowledged for role {role}: {pane_id}")
        except SystemExit:
            try:
                ctx.herdr.call("pane", "close", pane_id)
            except SystemExit:
                pass
            raise
        agent_name = role_agent_name(state, role)
        try:
            ctx.herdr.call("agent", "rename", pane_id, agent_name)
        except SystemExit:
            pass  # name addressing is a convenience; pane_id addressing still works
        state.setdefault("panes", {})[role] = pane_id
        state.setdefault("tabs", {})[role] = tab_id
        state_mod.save_state(state)

    try:
        spawn(model)
    except SystemExit:
        fallback = models.get("verifier_fallback") if role.endswith("-verifier") else None
        if not fallback or fallback == model:
            raise
        telemetry(ctx, state, "provider_launch_fallback", role=role, model=model, fallback=fallback)
        spawn(fallback)
        model = fallback

    state.setdefault("verificationModels", {})[role] = model
    if role.endswith("-verifier"):
        state.setdefault("verificationRoleStartedAt", {})[role] = ctx.clock.now().isoformat()
    state_mod.save_state(state)


def prompt_role(ctx, state, role, text=None):
    """Submit a role's prompt, verified against the agent leaving idle.

    `pane run` stays the primary submit. On a running pi TUI its Enter can race
    bracketed-paste ingestion and land prefilled-but-unsubmitted, so submission
    is verified and, if flat, nudged with an explicit `send-keys enter` before
    falling back to a bounded ctrl+c + resubmit retry.
    """
    name = role_agent_name(state, role)
    instructions = text or prompts.role_prompt(role, state["changeId"], state.get("verificationRound"), state.get("workflowType"))
    prompt = f"/skill:herdr-openspec-{role} {instructions}"
    pane_id = state.get("panes", {}).get(role)
    if not pane_id:
        raise SystemExit(f"no pane for role {role} in prompt_role")

    for attempt in range(PROMPT_SUBMIT_ATTEMPTS):
        final_attempt = attempt == PROMPT_SUBMIT_ATTEMPTS - 1
        try:
            ctx.herdr.call("wait", "agent-status", pane_id, "--status", "idle", "--timeout", str(PROMPT_IDLE_TIMEOUT_MS))
        except SystemExit:
            telemetry(ctx, state, "prompt_wait_timeout", role=role)
            if final_attempt:
                raise SystemExit(f"agent did not reach idle before prompt: {name}")

        write_trace_handoff(ctx, state, role)
        ctx.herdr.call("pane", "run", pane_id, prompt)

        if _wait_status(ctx, pane_id, "working", PROMPT_VERIFY_WINDOW_MS):
            return

        ctx.herdr.call("pane", "send-keys", pane_id, "enter")
        if _wait_status(ctx, pane_id, "working", PROMPT_VERIFY_WINDOW_MS):
            return

        if final_attempt:
            (state_mod.workflow_dir(state) / "trace-context" / f"{role}.json").unlink(missing_ok=True)
            raise SystemExit(f"agent prompt was not acknowledged: {name}")
        ctx.herdr.call("pane", "send-keys", pane_id, "ctrl+c")
        ctx.clock.sleep(0.3)


def start_role(ctx, state, role, text=None):
    if has_role_pane(state, role):
        try:
            ctx.herdr.call("agent", "get", role_agent_name(state, role))
        except SystemExit:
            launch_role(ctx, state, role)
    else:
        launch_role(ctx, state, role)
    prompt_role(ctx, state, role, text)


def cmd_planner(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] != "explore":
        raise SystemExit(f"planner restart invalid during phase {state['phase']}")
    start_role(ctx, state, "planner")
    print("planner started")


# ---------------------------------------------------------------------------
# plan quality / task completion gates
# ---------------------------------------------------------------------------

def plan_quality(state):
    root = Path(state["worktree"]) / "openspec" / "changes" / state["changeId"]
    required = {"proposal": root / "proposal.md", "design": root / "design.md", "tasks": root / "tasks.md"}
    missing = [name for name, path in required.items() if not path.exists() or not path.read_text().strip()]
    specs = list((root / "specs").rglob("*.md")) if (root / "specs").is_dir() else []
    task_count = gates.count_tasks(required["tasks"].read_text()) if "tasks" not in missing else 0
    result = gates.evaluate_plan_quality(missing, bool(specs), task_count)
    result["specFiles"] = len(specs)
    result["taskCount"] = task_count
    return result


def ensure_tasks_complete(state):
    path = Path(state["worktree"]) / "openspec" / "changes" / state["changeId"] / "tasks.md"
    if not path.is_file():
        raise SystemExit(f"missing OpenSpec tasks: {path}")
    tasks, incomplete = gates.incomplete_tasks(path.read_text())
    if not tasks:
        raise SystemExit(f"no OpenSpec tasks found: {path}")
    if incomplete:
        raise SystemExit(f"verification requires completed OpenSpec tasks; {len(incomplete)} remain in {path}. Mark each implemented task [x] after focused validation.")


def cmd_apply(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] != "proposed":
        raise SystemExit(f"apply requires approved proposal, found phase {state['phase']}")
    ensure_base_fresh(ctx, state)
    state["planQuality"] = plan_quality(state)
    state_mod.save_state(state)
    if not state["planQuality"]["passed"]:
        raise SystemExit("plan quality gate failed: " + "; ".join(state["planQuality"]["issues"]))
    telemetry(ctx, state, "plan_quality_passed", tasks=state["planQuality"]["taskCount"], specs=state["planQuality"]["specFiles"])
    start_role(ctx, state, "worker")
    state_mod.set_phase(state, "apply")
    state_mod.save_state(state)
    print("worker started")


# ---------------------------------------------------------------------------
# tracing/telemetry orchestration (pure math lives in tracing.py)
# ---------------------------------------------------------------------------

def workspace_context(ctx, state):
    context = state.get("otelTraceRoot")
    if context and tracing.parse_traceparent(tracing.traceparent(context)):
        return context
    context = tracing.child_context(tracing.parse_traceparent(os.environ.get("TRACEPARENT")))
    state["otelTraceRoot"] = context
    state["otelTraceRootStartedUnixNano"] = str(ctx.clock.time_ns())
    return context


def finalize_workspace_trace(ctx, state):
    if state.get("otelTraceRootFinalized"):
        return
    context = workspace_context(ctx, state)
    root = state_mod.workflow_dir(state)
    end = str(ctx.clock.time_ns())
    record = tracing.span_record(context, "workflow.workspace", state.get("otelTraceRootStartedUnixNano", end), end, {"service.name": "herdr-workflow", "herdr.change.id": state["changeId"], "herdr.phase": state.get("phase", "completed")})
    with (root / "traces.jsonl").open("a") as file:
        file.write(json.dumps(record) + "\n")
    ctx.exporter.export(record)
    state["otelTraceRootFinalized"] = True
    state_mod.save_state(state)


def telemetry(ctx, state, event, **fields):
    root = state_mod.workflow_dir(state)
    path = root / "telemetry.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    at = ctx.clock.now()
    with path.open("a") as file:
        file.write(json.dumps({"at": at.isoformat(), "event": event, "change": state["changeId"], **fields}) + "\n")
    parent = tracing.parse_traceparent(os.environ.get("TRACEPARENT")) or workspace_context(ctx, state)
    context = tracing.child_context(parent)
    nanos = str(int(at.timestamp() * 1_000_000_000))
    attributes = {"service.name": "herdr-workflow", "herdr.change.id": state["changeId"], "herdr.phase": state.get("phase", "unknown"), "herdr.verification.round": state.get("verificationRound", 0), **{f"herdr.{key}": value for key, value in fields.items() if isinstance(value, (str, int, float, bool))}}
    record = tracing.span_record(context, f"workflow.{event}", nanos, nanos, attributes, parent_span_id=parent["spanId"] if parent else None)
    with (root / "traces.jsonl").open("a") as file:
        file.write(json.dumps(record) + "\n")
    ctx.exporter.export(record)
    return context


def write_trace_handoff(ctx, state, role):
    root = state_mod.workflow_dir(state) / "trace-context"
    root.mkdir(parents=True, exist_ok=True)
    parent = tracing.parse_traceparent(os.environ.get("TRACEPARENT")) or workspace_context(ctx, state)
    action = tracing.child_context(parent)
    nanos = str(int(ctx.clock.now().timestamp() * 1_000_000_000))
    attributes = {"service.name": "herdr-workflow", "herdr.change.id": state["changeId"], "herdr.role": role, "herdr.phase": state.get("phase", "unknown"), "herdr.verification.round": state.get("verificationRound", 0)}
    record = tracing.span_record(action, f"workflow.prompt.{role}", nanos, nanos, attributes, parent_span_id=parent["spanId"] if parent else None)
    with (state_mod.workflow_dir(state) / "traces.jsonl").open("a") as file:
        file.write(json.dumps(record) + "\n")
    ctx.exporter.export(record)
    payload = {"traceparent": tracing.traceparent(action), "expiresAt": int(ctx.clock.time() * 1000) + 120_000, "messageId": uuid.uuid4().hex, "operation": f"workflow.prompt.{role}", "attributes": attributes}
    path = root / f"{role}.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload))
    temporary.replace(path)


# ---------------------------------------------------------------------------
# verification: triage input, review context, findings consolidation
# ---------------------------------------------------------------------------

def get_review_tier(ctx, state):
    stat = ctx.git.run("diff", "--numstat", "HEAD", cwd=state["worktree"])
    changed_paths = ctx.git.run("diff", "--name-only", "HEAD", cwd=state["worktree"]).splitlines()
    return tiering.review_tier(stat, changed_paths)


def triage_input_path(state):
    return state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-triage-input.json"


def triage_plan_path(state):
    return state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-triage.json"


def get_file_manifest(ctx, root, files):
    numstat = ctx.git.run("diff", "--numstat", "HEAD", cwd=root)
    diff_text = ctx.git.run("diff", "--no-color", "--unified=0", "HEAD", "--", *files, cwd=root) if files else ""
    return tiering.file_manifest(numstat, diff_text, files)


def write_triage_input(ctx, state, tier):
    root = Path(state["worktree"])
    files = ctx.git.run("diff", "--name-only", "HEAD", cwd=root).splitlines()
    # Full diff when previous round never completed (no coordinator verdict)
    prev_completed = bool(state.get("previousVerificationResults", {}).get("coordinator"))
    hashes = {path: hashlib.sha256((root / path).read_bytes()).hexdigest() if (root / path).is_file() else "deleted" for path in files}
    if prev_completed:
        previous = state.get("verificationSnapshots", {}).get(str(state["verificationRound"] - 1), {})
        changed = [path for path in files if hashes.get(path) != previous.get(path)]
    else:
        changed = list(files)
    state.setdefault("verificationSnapshots", {})[str(state["verificationRound"])] = hashes
    checks = {"openSpec": plan_quality(state), "applicableInstructions": tiering.applicable_instructions(root, changed), "triagePlanSchema": "validated by dispatch-verifiers"}
    suggested = tiering.eligible_verifier_roles(changed)
    prior = state.get("previousVerificationResults", {})
    reusable = {role: result for role, result in prior.items() if role in tiering.VERIFIER_ROLES and result.get("verdict") == "PASS"}
    path = triage_input_path(state)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"round": state["verificationRound"], "tier": tier, "fileManifest": get_file_manifest(ctx, root, changed), "allChangedFiles": files, "deterministicChecks": checks, "availableRoles": list(tiering.VERIFIER_ROLES), "suggestedRoles": suggested, "reusablePasses": reusable}, indent=2) + "\n")


def scoped_diff(ctx, root, files, hunks=None, limit=12000):
    chunks = []
    for file in files:
        diff = ctx.git.run("diff", "--no-color", "--unified=0", "HEAD", "--", file, cwd=root)
        selected = set((hunks or {}).get(file, []))
        if selected:
            parts = diff.split("@@")
            chunks.append(parts[0] + "".join("@@" + part for index, part in enumerate(parts[1:], 1) if index in selected))
        else:
            chunks.append(diff)
    diff = "\n".join(chunks)
    return diff[:limit] + ("\n… diff capped; inspect only scoped files if needed.\n" if len(diff) > limit else "")


def write_review_context(ctx, state, tier, plan):
    root = Path(state["worktree"])
    for role, entry in plan.items():
        files = entry["files"]
        path = state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-{role}-context.md"
        path.write_text(f"# Review context\n\nTier: {tier}\nRole: {role}\nReason: {entry['reason']}\n\n## Files in scope\n" + "\n".join(files) + f"\n\n## Scoped diff (max 12000 chars)\n```diff\n{scoped_diff(ctx, root, files, entry.get('hunks'))}\n```\nReview only this context.\n")


def write_test_context(ctx, state):
    root = Path(state["worktree"])
    triage_input = json.loads(triage_input_path(state).read_text())
    files = triage_input["allChangedFiles"]
    tests = [path for path in files if "/test/" in path or "/tests/" in path or path.startswith("test/")]
    results = {role: result.get("verdict") for role, result in state.get("verificationResults", {}).items() if role != "coordinator"}
    path = state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-{tiering.TEST_VERIFIER}-context.md"
    path.write_text("# Test verification context\n\nRun the repository's full configured test suite without filters. Review regression coverage only for scoped changed behavior.\n\n## Changed files\n" + "\n".join(files) + "\n\n## Changed test files\n" + ("\n".join(tests) or "(none)") + "\n\n## Selected verifier verdicts\n```json\n" + json.dumps(results) + f"\n```\n\n## Scoped diff (max 12000 chars)\n```diff\n{scoped_diff(ctx, root, files)}\n```\n")


def report_path(state, role):
    return state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-{role}.findings.jsonl"


def report_events(state, role):
    path = report_path(state, role)
    if not path.exists():
        raise SystemExit(f"missing JSONL report: {path}")
    if path.stat().st_size > 48000:
        raise SystemExit(f"report exceeds 48KB: {path}")
    events = []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise SystemExit(f"invalid JSONL report {path}:{number}: {error.msg}")
    findings.validate_report_events(events, path)
    return path, events


def consolidate_findings(ctx, state, roles):
    events_by_role = {}
    for role in roles:
        try:
            _path, events = report_events(state, role)
        except SystemExit:
            continue
        events_by_role[role] = events
    history_path = state_mod.workflow_dir(state) / "reviews" / "findings.json"
    history = json.loads(history_path.read_text()) if history_path.exists() else {"rounds": {}}
    prior_round = history["rounds"].get(str(state["verificationRound"] - 1), [])
    accepted_path = state_mod.workflow_dir(state) / "reviews" / "accepted-findings.json"
    accepted = set(json.loads(accepted_path.read_text()).get("ids", [])) if accepted_path.exists() else set()
    findings_list = findings.consolidate(events_by_role, prior_round, accepted)
    history["rounds"][str(state["verificationRound"])] = findings_list
    history_path.write_text(json.dumps(history, indent=2) + "\n")

    verdicts = {role: state.get("verificationResults", {}).get(role, {}).get("verdict", "PENDING") for role in roles}
    overall = "FAIL" if "FAIL" in verdicts.values() else "PASS" if all(verdict == "PASS" for verdict in verdicts.values()) else "PENDING"
    output = state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-consolidated.md"
    lines = ["# Consolidated verification", "", f"Overall verdict: {overall}", "", "## Verdicts", *[f"- {role}: {verdicts[role]}" for role in roles], "", "## Findings by verifier"]
    for role in roles:
        grouped = [item for item in findings_list if item["role"] == role]
        lines += ["", f"### {role}"]
        lines += [f"- [{item['severity']}] {item['id']} {item['status']} | {item['detail']}" for item in grouped] or ["- none"]
    output.write_text("\n".join(lines) + "\n")
    return output


def write_worker_fix_context(state):
    history_path = state_mod.workflow_dir(state) / "reviews" / "findings.json"
    findings_list = json.loads(history_path.read_text()).get("rounds", {}).get(str(state["verificationRound"]), []) if history_path.exists() else []
    failed_roles = {role for role, result in state.get("verificationResults", {}).items() if role != "coordinator" and result.get("verdict") == "FAIL"}
    actionable = [item for item in findings_list if item.get("role") in failed_roles and item.get("status") != "fixed"]
    files = sorted({item.get("path", "") for item in actionable if item.get("path")})
    tests = [path for path in files if "/test/" in path or "/tests/" in path or path.startswith("test/")]
    path = state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-worker-fix-context.md"
    lines = ["# Worker fix context", "", "Fix findings from every failed verifier. Do not read raw verifier reports."]
    for role in sorted(failed_roles):
        grouped = [item for item in actionable if item["role"] == role]
        lines += ["", f"## {role}"]
        lines += [f"- [{item['severity']}] {item['id']} | {item['path']} | {item['detail']} | fix: {item.get('fix') or 'resolve finding'}" for item in grouped] or ["- FAIL verdict reported without findings"]
    lines += ["", "## Files", *([f"- {file}" for file in files] or ["- none"]), "", "## Focused validation", *([f"- {test}" for test in tests] or ["- nearest existing regression test for changed behavior"])]
    path.write_text("\n".join(lines) + "\n")
    return path


def fail_verification(ctx, state):
    worker_context = write_worker_fix_context(state)
    consolidated = state.get("verificationResults", {}).get("coordinator", {}).get("report")
    if not consolidated:
        consolidated = str(state_mod.workflow_dir(state) / "reviews" / f"round-{state['verificationRound']}-consolidated.md")
    if state["verificationRound"] >= ctx.config["workflow"]["max_verification_rounds"]:
        state_mod.set_phase(state, "paused")
        state_mod.save_state(state)
        telemetry(ctx, state, "verification_failed", report=consolidated)
        ctx.herdr.call("notification", "show", "Verification limit reached", "--body", f"{state['changeId']} failed round {state['verificationRound']}; developer instruction required", "--sound", "request")
        print("verification failed at round limit; developer instruction required")
        return
    state_mod.set_phase(state, "fix")
    state_mod.save_state(state)
    telemetry(ctx, state, "verification_failed", report=consolidated)
    start_role(ctx, state, "worker", f"Verification failed. Read only {worker_context}. Fix every blocker, run its focused validation, then run `herdr-workflow verify --repo . --change {state['changeId']}`. Do not report completion until that command succeeds.")
    print("verification failed; worker notified to fix and restart verification")


def write_recovery_context(state):
    root = state_mod.workflow_dir(state) / "reviews"
    root.mkdir(parents=True, exist_ok=True)
    context = {"recoveryId": state.get("recoveryRunId"), "phase": state["phase"], "phaseStartedAt": state.get("phaseStartedAt"), "verificationRound": state["verificationRound"], "roles": state.get("verificationRoles", []), "results": state.get("verificationResults", {}), "timeouts": state.get("verificationTimeoutRoles", []), "allowedActions": [action for action, phases in recovery.RECOVERY_ACTION_PHASES.items() if state["phase"] in phases], "panes": state["panes"]}
    (root / "recovery-context.json").write_text(json.dumps(context, indent=2) + "\n")
    return root / "recovery-context.json"


def cmd_recover(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    root = state_mod.workflow_dir(state) / "reviews"
    root.mkdir(parents=True, exist_ok=True)
    (root / "recovery-plan.json").unlink(missing_ok=True)
    state["recoveryRunId"] = uuid.uuid4().hex
    state_mod.save_state(state)
    write_recovery_context(state)
    telemetry(ctx, state, "recovery_started", phase=state["phase"], round=state["verificationRound"], recovery_id=state["recoveryRunId"])
    start_role(ctx, state, "recovery")
    print("recovery analysis started")


def cmd_apply_recovery(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    plan_path = state_mod.workflow_dir(state) / "reviews" / "recovery-plan.json"
    if not plan_path.exists():
        raise SystemExit("missing recovery plan")
    try:
        plan = json.loads(plan_path.read_text())
    except json.JSONDecodeError:
        raise SystemExit("invalid recovery plan schema")
    if error := recovery.recovery_plan_error(state, plan):
        raise SystemExit(error)
    action = plan["action"]
    if action == "retry-verification":
        cmd_verify(ctx, args)
    elif action == "dispatch-triage":
        cmd_dispatch_verifiers(ctx, args)
    else:
        args.role = plan["role"]
        cmd_verification_result(ctx, args)
    telemetry(ctx, state, "recovery_applied", action=action, role=plan.get("role"), recovery_id=state["recoveryRunId"])


def cmd_verify(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state.get("workflowType") != "no-openspec":
        ensure_tasks_complete(state)
    ensure_base_fresh(ctx, state)
    if state["phase"] == "verify":
        print(f"verification already running: round {state['verificationRound']}")
        return
    if state["phase"] not in {"apply", "fix", "paused"}:
        raise SystemExit(f"verify invalid during phase {state['phase']}")
    if state["verificationRound"] >= ctx.config["workflow"]["max_verification_rounds"]:
        raise SystemExit("verification limit reached; reset explicitly before another round")
    first_round = state["verificationRound"] == 0
    if first_round and state["panes"].get("planner"):
        try:
            ctx.herdr.call("pane", "close", state["panes"]["planner"])
        except SystemExit:
            pass
    state["verificationRound"] += 1
    state_mod.set_phase(state, "verify")
    state["testVerifierStarted"] = False
    state["previousVerificationResults"] = state.get("verificationResults", {})
    state["verificationResults"] = {}
    state["verificationRoleStartedAt"] = {}
    state.pop("verificationTimeoutRoles", None)
    tier, _ = get_review_tier(ctx, state)
    state["verificationTier"] = tier
    state["verificationRoles"] = []
    state_mod.set_phase(state, "triage")
    write_triage_input(ctx, state, tier)
    state_mod.save_state(state)
    start_role(ctx, state, "triage")
    print(f"triage started: round {state['verificationRound']} ({tier})")


def cmd_dispatch_verifiers(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] != "triage":
        raise SystemExit(f"dispatch invalid during phase {state['phase']}")
    plan_path = triage_plan_path(state)
    if not plan_path.exists():
        raise SystemExit(f"missing triage plan: {plan_path}")
    plan = json.loads(plan_path.read_text()).get("roles", {})
    triage_input = json.loads(triage_input_path(state).read_text())
    changed = set(triage_input["allChangedFiles"])
    available = set(triage_input["availableRoles"])
    if not isinstance(plan, dict) or not set(plan).issubset(available):
        raise SystemExit(f"triage plan contains unavailable roles; choose from: {', '.join(sorted(available))}")
    for role, entry in plan.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("reason"), str) or not isinstance(entry.get("files"), list) or not entry["files"] or not set(entry["files"]).issubset(changed) or ("hunks" in entry and (not isinstance(entry["hunks"], dict) or any(path not in entry["files"] or not isinstance(ids, list) or any(not isinstance(item, int) or item < 1 or item > 8 for item in ids) for path, ids in entry["hunks"].items()))):
            raise SystemExit(f"invalid triage plan entry: {role}")
    state["verificationRoles"] = list(plan)
    state["verificationReusedResults"] = {role: result for role, result in triage_input["reusablePasses"].items() if role not in plan}
    state["verificationStartedAt"] = ctx.clock.now().isoformat()

    if not plan:
        state_mod.set_phase(state, "developer-review")
        state_mod.save_state(state)
        telemetry(ctx, state, "developer_review_ready", tier=state["verificationTier"], reused=len(triage_input["reusablePasses"]))
        ctx.herdr.call("notification", "show", "Developer review ready", "--body", f"{state['changeId']} passed verification (nothing changed); approve archive in dashboard", "--sound", "done")
        print("verification passed: no verifiers needed")
        return

    state_mod.set_phase(state, "verify")
    state_mod.save_state(state)
    write_review_context(ctx, state, state["verificationTier"], plan)
    telemetry(ctx, state, "verification_started", tier=state["verificationTier"], roles=list(plan))
    for role in plan:
        start_role(ctx, state, role)
    print(f"verification started: round {state['verificationRound']} ({state['verificationTier']}, {len(plan)} selected verifiers)")


def cmd_verification_result(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] != "verify":
        print(f"verification result ignored: phase {state['phase']}")
        return
    roles = tuple(state.get("verificationRoles", tiering.VERIFIER_ROLES))
    if args.role not in (*roles, tiering.TEST_VERIFIER):
        raise SystemExit(f"unknown verifier role: {args.role}")
    report, events = report_events(state, args.role)
    verdict_event = next((event for event in reversed(events) if event.get("type") == "verdict"), None)
    if not verdict_event or verdict_event.get("verdict") not in {"PASS", "FAIL"}:
        raise SystemExit(f"report must end with JSONL verdict PASS or FAIL: {report}")
    verdict = verdict_event["verdict"]
    state.setdefault("verificationResults", {})[args.role] = {"verdict": verdict, "report": str(report)}
    state_mod.save_state(state)
    started = state.get("verificationRoleStartedAt", {}).get(args.role)
    duration = (ctx.clock.now() - datetime.fromisoformat(started)).total_seconds() if started else None
    telemetry(ctx, state, "verifier_result", role=args.role, verdict=verdict, duration_seconds=duration, model=state.get("verificationModels", {}).get(args.role))
    if args.role == tiering.TEST_VERIFIER:
        consolidated = consolidate_findings(ctx, state, (*roles, tiering.TEST_VERIFIER))
        state["verificationResults"]["coordinator"] = {"verdict": verdict, "report": str(consolidated)}
        state_mod.save_state(state)
        if verdict == "FAIL":
            fail_verification(ctx, state)
            return
        state_mod.set_phase(state, "developer-review")
        state_mod.save_state(state)
        ctx.herdr.call("notification", "show", "Developer review ready", "--body", f"{state['changeId']} passed verification; approve archive in dashboard", "--sound", "done")
        print("verification passed")
        return
    results = state["verificationResults"]
    if all(role in results for role in roles):
        failed = any(results[role]["verdict"] == "FAIL" for role in roles)
        consolidated = consolidate_findings(ctx, state, roles if failed else (*roles, tiering.TEST_VERIFIER))
        if failed:
            results["coordinator"] = {"verdict": "FAIL", "report": str(consolidated)}
            state_mod.save_state(state)
            fail_verification(ctx, state)
            return
        if not state.get("testVerifierStarted"):
            state["testVerifierStarted"] = True
            results["coordinator"] = {"verdict": "PENDING", "report": str(consolidated)}
            write_test_context(ctx, state)
            state_mod.save_state(state)
            start_role(ctx, state, tiering.TEST_VERIFIER)
            print("selected verifiers passed; test verifier started")
            return
    print("verification result recorded; awaiting parallel verifiers")


def cmd_close(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] != "completed":
        raise SystemExit(f"close requires completed phase, found {state['phase']}")
    state_mod.set_phase(state, "closed")
    state_mod.save_state(state)
    ctx.herdr.call("workspace", "close", state["workspace"])
    print("workspace closed; branch and checkout kept")


def write_archive_context(state):
    results = {role: result.get("verdict") for role, result in state.get("verificationResults", {}).items()}
    path = state_mod.workflow_dir(state) / "reviews" / "archive-context.md"
    if state.get("workflowType") == "no-openspec":
        instruction = "No OpenSpec project in this workflow; validate only and do NOT run `openspec archive`."
    else:
        instruction = f"Run `openspec archive {state['changeId']} --yes` to move `openspec/changes/{state['changeId']}/` into `openspec/changes/archive/`, then validate."
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# Archive context\n\nChange: {state['changeId']}\nBranch: {state['branch']}\nTicket: {state.get('ticketNumber') or '(none)'}\nVerification: {json.dumps(results)}\n\n{instruction} Leave a clean, stageable working tree, do not commit or push, then start git operations.\n")


def write_git_context(state):
    results = {role: result.get("verdict") for role, result in state.get("verificationResults", {}).items()}
    path = state_mod.workflow_dir(state) / "reviews" / "git-context.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# Git operations\n\nChange: {state['changeId']}\nBranch: {state['branch']}\nTicket: {state.get('ticketNumber') or '(none)'}\nVerification: {json.dumps(results)}\n\nArchive step already ran; any OpenSpec archive move is already sitting uncommitted in the working tree. Run preflight, stage all changes including that archive move, commit, and push.\n")


def _start_archive(ctx, state):
    """Close non-essential panes, launch archive agent."""
    for role in ("planner", "triage", "worker", *tiering.VERIFIER_ROLES, tiering.TEST_VERIFIER):
        pane = state["panes"].get(role)
        if not pane:
            continue
        try:
            ctx.herdr.call("pane", "close", pane)
        except SystemExit:
            pass
    launch_role(ctx, state, "archive")
    write_archive_context(state)
    prompt_role(ctx, state, "archive")
    state_mod.set_phase(state, "archive")
    state["developerApproval"] = True
    state_mod.save_state(state)


def _start_git_operations(ctx, state):
    """Close lazygit pane, launch git agent."""
    lazygit_pane = state["panes"].get("git")
    if lazygit_pane:
        try:
            ctx.herdr.call("pane", "close", lazygit_pane)
        except SystemExit:
            pass
    launch_role(ctx, state, "git")
    write_git_context(state)
    prompt_role(ctx, state, "git")
    state_mod.set_phase(state, "committing")
    state_mod.save_state(state)


def cmd_git_operations(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] != "archive":
        raise SystemExit(f"git-operations requires archive phase, found {state['phase']}")
    _start_git_operations(ctx, state)
    print("git operations started")


def cmd_archive(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] == "developer-review":
        if state.get("workflowType") != "no-openspec":
            ensure_tasks_complete(state)
        _start_archive(ctx, state)
        print("archive started")
        return
    if state["phase"] == "archive":
        _start_git_operations(ctx, state)
        print("git operations started")
        return
    if state["phase"] == "committing":
        ensure_workflow_branch(ctx, state)
        dirty = ctx.git.run("status", "--porcelain", cwd=state["worktree"])
        if dirty:
            raise SystemExit("working tree is dirty after git operations; commit or clean first")
        ensure_base_fresh(ctx, state)
        for role in ("git", "archive"):
            pane = state["panes"].get(role)
            if not pane:
                continue
            try:
                ctx.herdr.call("pane", "close", pane)
            except SystemExit:
                pass
        finalize_workspace_trace(ctx, state)
        state_mod.set_phase(state, "completed")
        state_mod.save_state(state)
        print("archive complete")
        return
    raise SystemExit(f"archive requires developer-review, archive, or committing phase, found {state['phase']}")


def cmd_preflight_archive(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] not in ("archive", "committing"):
        raise SystemExit(f"archive preflight requires archive or committing phase, found {state['phase']}")
    ensure_workflow_branch(ctx, state)
    print(f"archive preflight passed: {state['branch']}")


def cmd_override_phase(ctx, args):
    if args.phase not in transitions.OPERATIONAL_PHASES:
        raise SystemExit(f"invalid override phase: {args.phase}")
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] == "closed":
        raise SystemExit("cannot override closed workflow")
    source = state["phase"]
    state_mod.set_phase(state, args.phase)
    state_mod.save_state(state)
    telemetry(ctx, state, "workflow_phase_overridden", source=source, target=args.phase)
    print(args.phase)


def cmd_phase(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    allowed = transitions.allowed_transitions(state)
    if args.phase == "completed":
        ensure_workflow_branch(ctx, state)
    if args.phase not in allowed.get(state["phase"], set()):
        raise SystemExit(f"invalid transition: {state['phase']} -> {args.phase}")
    if args.phase == "proposed":
        state["planQuality"] = plan_quality(state)
        state_mod.save_state(state)
        if not state["planQuality"]["passed"]:
            issues = "; ".join(state["planQuality"]["issues"])
            telemetry(ctx, state, "plan_quality_rejected", issues=state["planQuality"]["issues"])
            raise SystemExit(f"PLAN_REJECTED: {issues}. Fix every issue and rerun the proposed transition before ending.")
    if args.phase == "fix" and state["verificationRound"] >= ctx.config["workflow"]["max_verification_rounds"]:
        args.phase = "paused"
    state_mod.set_phase(state, args.phase)
    state_mod.save_state(state)
    if args.phase == "completed":
        finalize_workspace_trace(ctx, state)
    print(args.phase)


def cmd_message(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    pane = state["panes"].get(args.target)
    if not pane:
        raise SystemExit(f"unknown target: {args.target}")
    directory = Path(state["worktree"]) / ".herdr-workflow" / args.change / "messages"
    directory.mkdir(parents=True, exist_ok=True)
    stamp = ctx.clock.now().strftime("%Y%m%dT%H%M%S%fZ")
    artifact = directory / f"{stamp}-{args.sender}-to-{args.target}.md"
    artifact.write_text(f"# {args.sender} → {args.target}\n\n{args.text}\n")
    prompt_role(ctx, state, args.target, f"Message from {args.sender}: {args.text} Full message: {artifact}")
    print(artifact)


def cmd_check_timeout(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    if state["phase"] != "verify" or not state.get("verificationStartedAt"):
        print("verification timeout not applicable")
        return
    timeout = int(ctx.config["workflow"].get("verification_timeout_seconds", 600))
    started = state.get("verificationRoleStartedAt", {})
    roles = [*state.get("verificationRoles", tiering.VERIFIER_ROLES), tiering.TEST_VERIFIER]
    pending = [role for role in roles if role in started and role not in state.get("verificationResults", {}) and (ctx.clock.now() - datetime.fromisoformat(started[role])).total_seconds() >= timeout]
    if not pending:
        print("verification within timeout")
        return
    state_mod.set_phase(state, "paused")
    state["verificationTimeoutRoles"] = pending
    state_mod.save_state(state)
    telemetry(ctx, state, "verification_timeout", pending=pending)
    ctx.herdr.call("notification", "show", "Verification timed out", "--body", f"{state['changeId']}: {', '.join(pending)}", "--sound", "request")
    print(f"verification timed out: {', '.join(pending)}")


def cmd_status(ctx, args):
    print(json.dumps(state_mod.load_state(args.repo, args.change), indent=2))


def cmd_projects(ctx, args):
    config = ctx.config["projects"]
    root = Path(config["root"]).expanduser().resolve()
    max_depth = int(config.get("max_depth", 3))
    if not root.is_dir():
        raise SystemExit(f"project discovery root not found: {root}")
    projects = []
    for current, directories, _files in os.walk(root):
        path = Path(current)
        depth = len(path.relative_to(root).parts)
        directories[:] = [name for name in directories if not name.startswith(".") and name not in {"node_modules", "build", "dist", "target"}]
        if (path / ".git").exists():
            projects.append({"name": str(path.relative_to(root)), "path": str(path), "openspec": (path / "openspec" / "config.yaml").exists()})
            directories.clear()
        elif depth >= max_depth:
            directories.clear()
    print(json.dumps(sorted(projects, key=lambda item: item["name"].lower())))


def cmd_config(ctx, args):
    print(json.dumps(ctx.config))


def cmd_set_return(ctx, args):
    state = state_mod.load_state(args.repo, args.change)
    state["returnWorkspace"] = args.workspace
    state_mod.save_state(state)
    print(json.dumps(state, indent=2))


def pi_command(role, model, thinking, change, verification_round=None):
    """Printable Pi invocation retained for diagnostics and plugin checks; loads config fresh."""
    config = effects.load_config()
    return shlex.join(["pi", *prompts.pi_arguments(role, model, thinking, change, config)])


# ---------------------------------------------------------------------------
# plugin subcommands
# ---------------------------------------------------------------------------

def cmd_plugin(ctx, args):
    if args.plugin_command == "list":
        _plugin_list(ctx)
    elif args.plugin_command == "install":
        _plugin_install(args)
    elif args.plugin_command == "install-local":
        _plugin_install_local(args)


def _plugin_list(ctx):
    """List all discovered extensions with their role status."""
    config = ctx.config
    extensions = prompts.discover_extensions()
    assignments = prompts.load_plugin_assignments()
    assigned_roles_by_stem = {}
    for plugin in assignments.get("plugins", []):
        roles = plugin.get("agentRoles", [])
        if not roles:
            continue
        stem = Path(plugin["source"]).stem
        if stem not in assigned_roles_by_stem:
            assigned_roles_by_stem[stem] = roles

    if not extensions:
        print("No extensions found.")
        return

    print(f"{'Extension':<40} {'Active for':<20} {'Status':<30}")
    print("-" * 90)
    for name, path in sorted(extensions.items()):
        roles_status = []
        for role in sorted(prompts.UNRESTRICTED_ROLES):
            exclusions = prompts.resolve_exclusions(config, role)
            roles_status.append(f"{role}={'' if name not in exclusions else 'excluded'}")
        status = ", ".join(roles_status)
        assignment_roles = assigned_roles_by_stem.get(name, [])
        role_tag = ",".join(assignment_roles) if assignment_roles else "all"
        print(f"{name:<40} {role_tag:<20} {status:<30}")


def _plugin_install(args):
    """Install a plugin via pi install and optionally record role assignments."""
    source = args.source
    roles = []
    if args.worker:
        roles.append("worker")
    if args.planner:
        roles.append("planner")

    print(f"Installing {source}...")
    result = subprocess.run(["pi", "install", source], text=True, capture_output=True)
    if result.returncode:
        print(result.stderr or result.stdout)
        raise SystemExit(f"pi install failed: {result.stderr or result.stdout}")
    print(result.stdout or "Installation successful.")

    if roles:
        assignments = prompts.load_plugin_assignments()
        found = False
        for plugin in assignments["plugins"]:
            if plugin["source"] == source:
                plugin["agentRoles"] = list(set(plugin.get("agentRoles", []) + roles))
                found = True
                break
        if not found:
            assignments["plugins"].append({"source": source, "agentRoles": roles})
        prompts.save_plugin_assignments(assignments)
        print(f"Registered roles {roles} for {source}")


def _plugin_install_local(args):
    """Install a local extension file into the pi extensions directory."""
    source_path = Path(args.path).expanduser().resolve()
    if not source_path.exists():
        raise SystemExit(f"extension file not found: {source_path}")

    roles = []
    if args.worker:
        roles.append("worker")
    if args.planner:
        roles.append("planner")

    target_dir = paths.AGENT_DIR / "extensions"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / source_path.name

    try:
        if target.exists() or target.is_symlink():
            target.unlink()
        target.symlink_to(str(source_path))
        print(f"Linked {source_path} -> {target}")
    except OSError:
        shutil.copy2(str(source_path), str(target))
        print(f"Copied {source_path} -> {target}")

    if roles:
        assignments = prompts.load_plugin_assignments()
        found = False
        for plugin in assignments["plugins"]:
            if plugin["source"] == str(source_path):
                plugin["agentRoles"] = list(set(plugin.get("agentRoles", []) + roles))
                found = True
                break
        if not found:
            assignments["plugins"].append({"source": str(source_path), "agentRoles": roles})
        prompts.save_plugin_assignments(assignments)
        print(f"Registered roles {roles} for {source_path.name}")
    else:
        print("Extension installed. Use --worker or --planner to assign roles.")
