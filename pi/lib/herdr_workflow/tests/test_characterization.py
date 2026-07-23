"""Locks the frozen external contract: CLI subcommand surface + state.json field shape.

Runs against the final package (cli.py + commands.py), not the pre-refactor monolith —
the monolith's `parser()` and `cmd_start` were captured by hand from the pre-refactor
source before any code moved, and this test encodes that captured contract so any
future drift in subcommand names/flags or the `start`-produced state.json shape fails
loudly here rather than silently breaking the dashboard.
"""
import json
import tempfile
import unittest
from pathlib import Path

from herdr_workflow import cli, commands
from herdr_workflow.tests.fakes import FakeClock, FakeHerdr, init_repo, make_context

EXPECTED_SUBCOMMANDS = {
    "projects", "config", "start", "planner", "apply", "verify", "recover",
    "apply-recovery", "dispatch-verifiers", "archive", "close", "status",
    "check-timeout", "git-operations", "phase", "override-phase",
    "preflight-archive", "set-return", "verification-result", "message", "plugin",
    "finish-review",
}

# subcommand -> set of required flag dests (positionals excluded)
EXPECTED_REQUIRED_FLAGS = {
    "start": {"repo", "change", "mode"},
    "planner": {"repo", "change"},
    "apply": {"repo", "change"},
    "verify": {"repo", "change"},
    "recover": {"repo", "change"},
    "apply-recovery": {"repo", "change"},
    "dispatch-verifiers": {"repo", "change"},
    "archive": {"repo", "change"},
    "close": {"repo", "change"},
    "status": {"repo", "change"},
    "check-timeout": {"repo", "change"},
    "git-operations": {"repo", "change"},
    "phase": {"repo", "change"},
    "override-phase": {"repo", "change"},
    "preflight-archive": {"repo", "change"},
    "set-return": {"repo", "change", "workspace"},
    "verification-result": {"repo", "change", "role"},
    "message": {"repo", "change", "sender", "target"},
}

# state.json fields the dashboard's WorkflowState reads (see design.md contract #2)
EXPECTED_STATE_FIELDS = {
    "changeId", "phase", "repository", "worktree", "branch",
    "workspace", "task", "ticketNumber", "workerModel", "verificationRound",
    "returnWorkspace", "baseBranch", "baseCommit", "developerApproval", "panes",
    "tabs", "workflowModules", "workflowType", "createdAt", "otelTraceRoot",
    "otelTraceRootStartedUnixNano", "verificationModels",
}


class SubcommandSurfaceTest(unittest.TestCase):
    def setUp(self):
        self.parser = cli.parser()
        self.subparsers_action = next(a for a in self.parser._subparsers._group_actions if a.dest == "command")

    def test_subcommand_names_unchanged(self):
        self.assertEqual(set(self.subparsers_action.choices.keys()), EXPECTED_SUBCOMMANDS)

    def test_required_flags_unchanged(self):
        for name, expected in EXPECTED_REQUIRED_FLAGS.items():
            sub = self.subparsers_action.choices[name]
            required = {action.dest for action in sub._actions if action.option_strings and action.required}
            self.assertEqual(required, expected, f"subcommand {name!r} required flags drifted")

    def test_plugin_subcommands_unchanged(self):
        plugin_sub = self.subparsers_action.choices["plugin"]
        plugin_action = next(a for a in plugin_sub._subparsers._group_actions if a.dest == "plugin_command")
        self.assertEqual(set(plugin_action.choices.keys()), {"list", "install", "install-local"})


class GoldenStateShapeTest(unittest.TestCase):
    """cmd_start's state.json field set/shapes, run against fakes end to end."""

    def test_start_produces_expected_state_shape(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            repo = init_repo(Path(tmp_dir) / "repo")
            bare = Path(tmp_dir) / "origin.git"
            import subprocess
            subprocess.run(["git", "init", "--bare", "-q", "-b", "main", str(bare)], check=True)
            subprocess.run(["git", "remote", "add", "origin", str(bare)], cwd=repo, check=True)
            subprocess.run(["git", "push", "-q", "origin", "main"], cwd=repo, check=True)
            subprocess.run(["git", "remote", "set-head", "origin", "main"], cwd=repo, check=True)
            herdr = FakeHerdr()
            ctx = make_context(herdr=herdr, clock=FakeClock())

            def workspace_create(_args):
                return {"workspace": {"workspace_id": "ws-1"}, "root_pane": {"pane_id": "pane-root"}}

            def tab_list(_args):
                return {"tabs": [{"tab_id": "tab-dashboard"}]}

            herdr.on(lambda a: a[:2] == ("workspace", "create"), workspace_create)
            herdr.on(lambda a: a[:2] == ("tab", "list"), tab_list)

            args = type("Args", (), dict(repo=str(repo), change="golden-change", task="do it", mode="checkout", ticket=None, worker=None, workflow_type="standard"))()
            commands.cmd_start(ctx, args)

            state = json.loads((repo / ".herdr-workflow" / "golden-change" / "state.json").read_text())
            self.assertEqual(set(state.keys()), EXPECTED_STATE_FIELDS)
            self.assertEqual(state["changeId"], "golden-change")
            self.assertEqual(state["phase"], "explore")
            self.assertIsInstance(state["panes"], dict)
            self.assertIsInstance(state["tabs"], dict)

            args = type("Args", (), dict(repo=str(repo), change="quick-change", task=None, mode="checkout", ticket=None, worker=None, workflow_type="no-openspec"))()
            commands.cmd_start(ctx, args)
            self.assertFalse((repo / ".herdr-workflow" / "quick-change" / "request.md").exists())


if __name__ == "__main__":
    unittest.main()
