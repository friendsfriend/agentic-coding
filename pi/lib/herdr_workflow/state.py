"""Workflow state dict: load/save/phase bookkeeping, path helpers."""
import json
from datetime import datetime, timezone
from pathlib import Path


def state_path(repo, change):
    return Path(repo) / ".herdr-workflow" / change / "state.json"


def load_state(repo, change):
    path = state_path(repo, change)
    if not path.exists():
        raise SystemExit(f"workflow not found: {path}")
    return json.loads(path.read_text())


def set_phase(state, phase):
    state["phase"] = phase
    state["phaseStartedAt"] = datetime.now(timezone.utc).isoformat()


def save_state(state):
    paths = {state_path(state["worktree"], state["changeId"]), state_path(state["repository"], state["changeId"])}
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2) + "\n")
    return state_path(state["worktree"], state["changeId"])


def workflow_dir(state):
    return Path(state["worktree"]) / ".herdr-workflow" / state["changeId"]
