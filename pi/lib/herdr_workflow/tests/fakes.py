"""Test doubles for the Herdr/Git/Clock/TraceExporter seams, plus a tmp-repo helper.

ponytail: real git in a tmp dir beats mocking diff output; upgrade to a pure
fake only if git-in-CI proves flaky.
"""
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from herdr_workflow import effects

DEFAULT_CONFIG = {
    "models": {
        "worker_default": "test/worker",
        "verifier": "test/verifier",
        "verifier_fallback": "test/verifier-fallback",
        "archive": "test/archive",
        "git": "test/git",
        "planner": "test/planner",
        "triage": "test/triage",
        "recovery": "test/recovery",
    },
    "thinking": {
        "worker_default": "high",
        "verifier": "high",
        "verifier_lite": "medium",
        "planner": "high",
        "triage": "high",
        "recovery": "high",
        "archive": "high",
    },
    "workflow": {
        "max_verification_rounds": 6,
        "verification_timeout_seconds": 600,
        "remote": "origin",
        "branch_prefix": "feature/",
        "base_branch": "origin/HEAD",
    },
    "projects": {"root": "~/development", "max_depth": 3},
    "plugins": {},
}


class FakeHerdr:
    """Records every call(*args); returns scripted or generated responses.

    Agent state is tracked by pane_id (the source of truth), matching the real
    herdr API where `wait agent-status`, `pane run`, and `pane send-keys` all
    target a pane_id and `agent get` has no sequence counter (no
    `state_change_seq` field) — only `agent_status`. `agent get <name>` resolves
    name -> pane_id via the `agent rename` mapping, exactly as production code
    relies on.
    """

    def __init__(self):
        self.calls = []
        self._pane_to_agent = {}   # pane_id -> name, set by `agent rename` (or register_pane)
        self._agent_to_pane = {}   # reverse of the above
        self._pane_status = {}     # pane_id -> agent_status; absent until first touched
        self._tab_seq = 0
        self._pane_seq = 0
        self.handlers = []      # [(predicate(args) -> bool, handler(args) -> dict)]
        self.after_hooks = []   # [(predicate(args) -> bool, effect(args) -> None)]
        # Default: `pane run` settles the target pane into the status a real
        # submission would reach — "idle" for a pi cold-boot (first `pane run` on a
        # pane), "working" for a prompt on an already-launched agent (any later
        # `pane run`). Tests exercising the verification/nudge/failure paths set
        # this False and script transitions explicitly via `.after(...)`.
        self.auto_advance_on_submit = True

    def on(self, predicate, handler):
        self.handlers.append((predicate, handler))

    def after(self, predicate, effect):
        self.after_hooks.append((predicate, effect))

    def register_pane(self, pane_id, name):
        """Associate a pane with an agent name, as `agent rename` would."""
        self._pane_to_agent[pane_id] = name
        self._agent_to_pane[name] = pane_id

    def set_agent(self, name, pane_id=None, agent_status=None, **_ignored):
        """Test convenience: register/update an agent's pane and/or status directly."""
        if pane_id:
            self.register_pane(pane_id, name)
        target_pane = pane_id or self._agent_to_pane.get(name)
        if agent_status is not None and target_pane:
            self._pane_status[target_pane] = agent_status

    def set_status(self, pane_id_or_name, status):
        pane_id = self._agent_to_pane.get(pane_id_or_name, pane_id_or_name)
        self._pane_status[pane_id] = status

    def call(self, *args):
        self.calls.append(args)
        result = None
        matched = False
        for predicate, handler in self.handlers:
            if predicate(args):
                result = handler(args)
                matched = True
                break
        if not matched:
            result = self._default(args)
        for predicate, effect in self.after_hooks:
            if predicate(args):
                effect(args)
        return result

    def _default(self, args):
        if args[:2] == ("tab", "create"):
            self._tab_seq += 1
            self._pane_seq += 1
            tab_id, pane_id = f"tab-{self._tab_seq}", f"pane-{self._pane_seq}"
            # Real `herdr tab create` result has no top-level tab_id: it's nested in
            # root_pane (and in "tab"). Both launch_role and create_tab() read it
            # from root_pane["tab_id"].
            return {"root_pane": {"pane_id": pane_id, "tab_id": tab_id}, "tab": {"tab_id": tab_id}}
        if args[:2] == ("agent", "start"):
            # Real `agent start` launches inside the caller-supplied `--pane`; it
            # never fabricates a new pane. Registering anything else here would
            # desync `state["panes"][role]` from what `agent get` resolves.
            name = args[2]
            pane_id = args[args.index("--pane") + 1]
            self.register_pane(pane_id, name)
            self._pane_status[pane_id] = "idle"
            return {"agent": {"pane_id": pane_id, "name": name}}
        if args[:2] == ("agent", "prompt"):
            name = args[2]
            pane_id = self._agent_to_pane.get(name)
            if pane_id is None:
                raise SystemExit(f"agent not found: {name}")
            if self.auto_advance_on_submit:
                self._pane_status[pane_id] = "working"
            return {"agent": {"pane_id": pane_id, "agent_status": self._pane_status.get(pane_id, "working")}}
        if args[:2] == ("agent", "rename"):
            self.register_pane(args[2], args[3])
            return {}
        if args[:2] == ("pane", "process-info"):
            return {"process_info": {"foreground_processes": [{"name": "zsh"}]}}
        if args[:2] == ("pane", "read"):
            return {"read": {"text": "❯ "}}
        if args[:2] == ("pane", "run"):
            pane_id = args[2]
            if self.auto_advance_on_submit:
                # First `pane run` on a pane is the pi launch (settles to idle once
                # booted); any later one is a prompt on an already-running agent
                # (settles to working).
                self._pane_status[pane_id] = "working" if pane_id in self._pane_status else "idle"
            return {}
        if args[:2] in {("pane", "close"), ("pane", "send-keys"), ("notification", "show")}:
            return {}
        if args[:2] == ("agent", "get"):
            name = args[2]
            pane_id = self._agent_to_pane.get(name)
            if pane_id is None:
                raise SystemExit(f"agent not found: {name}")
            return {"agent": {"agent_status": self._pane_status.get(pane_id, "idle"), "pane_id": pane_id}}
        if args[:2] == ("wait", "agent-status"):
            # herdr wait agent-status <pane_id> --status <status> --timeout <ms>
            pane_id = args[2]
            wanted = args[args.index("--status") + 1]
            if self._pane_status.get(pane_id, "idle") == wanted:
                return {}
            raise SystemExit("timed out waiting for agent status change")
        if args[0] == "wait":
            return {}
        return {}


class FakeGit:
    """Backed by a real temp git repo — cheapest correct option for diff/numstat parsing."""

    def run(self, *args, cwd):
        result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=False)
        if result.returncode:
            raise SystemExit(f"git {' '.join(args)}: {(result.stderr or result.stdout or 'command failed').strip()}")
        return result.stdout.strip()


class FakeClock:
    """Fixed/monotone: `sleep` advances virtual time so timeout logic is deterministic and fast."""

    def __init__(self, start=1_700_000_000.0):
        self._now = datetime(2024, 1, 1, tzinfo=timezone.utc)
        self._monotonic = start
        self._time = start

    def now(self):
        return self._now

    def monotonic(self):
        return self._monotonic

    def time(self):
        return self._time

    def time_ns(self):
        return int(self._time * 1_000_000_000)

    def sleep(self, seconds):
        self._monotonic += seconds
        self._time += seconds
        self._now += timedelta(seconds=seconds)

    def advance(self, seconds):
        self.sleep(seconds)


class NoopExporter:
    def export(self, record):
        pass


def make_context(config=None, herdr=None, git=None, clock=None, exporter=None):
    return effects.Context(
        config=config if config is not None else DEFAULT_CONFIG,
        herdr=herdr if herdr is not None else FakeHerdr(),
        git=git if git is not None else FakeGit(),
        clock=clock if clock is not None else FakeClock(),
        exporter=exporter if exporter is not None else NoopExporter(),
    )


def init_repo(path):
    """Init a git repo with an OpenSpec project and one committed base file."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    run = lambda *args: subprocess.run(["git", *args], cwd=path, check=True, capture_output=True, text=True)
    run("init", "-q", "-b", "main")
    run("config", "user.email", "test@example.com")
    run("config", "user.name", "Test")
    (path / "openspec").mkdir(exist_ok=True)
    (path / "openspec" / "config.yaml").write_text("name: test\n")
    (path / "README.md").write_text("# test\n")
    run("add", "-A")
    run("commit", "-q", "-m", "base")
    (path / ".git" / "info" / "exclude").write_text("\n.herdr-workflow/\n")
    return path
