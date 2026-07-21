"""Pure workflow composition: modules, types, and allowed phase transitions."""

OPERATIONAL_PHASES = ("explore", "proposed", "apply", "fix", "triage", "verify", "paused", "developer-review", "committing", "archive", "completed")

# Module-based workflow composition
WORKFLOW_MODULES = {
    "plan": {
        "entry": "explore",
        "exit": "proposed",
        "roles": ["planner"],
        "gate": False,
        "phases": {"explore"},
    },
    "plan-approval": {
        "entry": "proposed",
        "exit": "apply",
        "roles": [],
        "gate": True,
        "phases": {"proposed"},
    },
    "apply-verify": {
        "entry": "apply",
        "exit": "developer-review",
        "roles": ["worker"],
        "gate": False,
        "phases": {"apply", "verify", "fix", "paused", "triage"},
    },
    "developer-approval": {
        "entry": "developer-review",
        "exit": "archive",
        "roles": [],
        "gate": True,
        "phases": {"developer-review"},
    },
    "archive": {
        "entry": "archive",
        "exit": "committing",
        "roles": ["archive"],
        "gate": False,
        "phases": {"archive"},
    },
    "git-operations": {
        "entry": "committing",
        "exit": "completed",
        "roles": [],
        "gate": False,
        "phases": {"committing"},
    },
}

WORKFLOW_TYPES = {
    "standard": ["plan", "plan-approval", "apply-verify", "developer-approval", "archive", "git-operations"],
    "direct-apply": ["apply-verify", "developer-approval", "archive", "git-operations"],
    "no-openspec": ["apply-verify", "developer-approval", "git-operations"],
}


def resolve_modules(state):
    return state.get("workflowModules") or list(WORKFLOW_TYPES["standard"])


def allowed_transitions(state):
    modules = resolve_modules(state)
    allowed = {}
    for i, name in enumerate(modules):
        module = WORKFLOW_MODULES[name]
        for phase in module["phases"]:
            allowed.setdefault(phase, set())
        if name == "apply-verify":
            allowed["apply"].add("verify")
            allowed["verify"].update({"fix", "paused"})
            allowed["fix"].add("verify")
            allowed["paused"].update({"fix", "verify"})
        if not module["gate"]:
            if i + 1 < len(modules):
                next_entry = WORKFLOW_MODULES[modules[i + 1]]["entry"]
                if name == "apply-verify":
                    source = "verify"
                else:
                    source = next(iter(module["phases"]))
                allowed.setdefault(source, set()).add(next_entry)
            elif module["exit"] not in module["phases"]:
                source = next(iter(module["phases"]))
                allowed.setdefault(source, set()).add(module["exit"])
    return allowed
