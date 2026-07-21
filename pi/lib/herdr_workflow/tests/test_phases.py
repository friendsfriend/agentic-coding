import json
import tempfile
import unittest
from pathlib import Path

from herdr_workflow import commands
from herdr_workflow import state as state_mod
from herdr_workflow.tests.fakes import FakeClock, FakeHerdr, init_repo, make_context


class Args:
    """Plain namespace standing in for argparse.Namespace in tests."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class PhaseTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = init_repo(Path(self._tmp.name) / "repo")
        self.herdr = FakeHerdr()
        self.clock = FakeClock()
        self.ctx = make_context(herdr=self.herdr, clock=self.clock)
        # "main" is the upstream base (fixed after init); the workflow itself commits
        # on a separate feature branch, so ensure_base_fresh's rev-parse of the base
        # branch never moves out from under a test that commits during archive/git.
        self.ctx.git.run("checkout", "-b", "feature/my-change", cwd=self.repo)

    def make_state(self, phase, workflow_type="standard", **overrides):
        state = {
            "changeId": "my-change",
            "phase": phase,
            "repository": str(self.repo),
            "worktree": str(self.repo),
            "branch": "feature/my-change",
            "workspace": "ws-1",
            "task": "do the thing",
            "ticketNumber": None,
            "workerModel": "test/worker",
            "verificationRound": 0,
            "returnWorkspace": None,
            "baseBranch": "main",
            "baseCommit": self.ctx.git.run("rev-parse", "HEAD", cwd=self.repo),
            "developerApproval": False,
            "panes": {"dashboard": "pane-dash", "git": "pane-git"},
            "tabs": {"dashboard": "tab-dash", "git": "tab-git"},
            "workflowModules": None,
            "workflowType": workflow_type,
            "createdAt": self.clock.now().isoformat(),
        }
        state.update(overrides)
        state_mod.save_state(state)
        return state

    def write_change_artifacts(self, complete=True, task_marks=("x",)):
        root = self.repo / "openspec" / "changes" / "my-change"
        (root / "specs").mkdir(parents=True, exist_ok=True)
        (root / "proposal.md").write_text("# Proposal\nDo the thing.\n")
        (root / "design.md").write_text("# Design\nHow.\n")
        tasks = "\n".join(f"- [{mark}] task {i}" for i, mark in enumerate(task_marks))
        (root / "tasks.md").write_text(tasks + "\n" if complete else "")
        (root / "specs" / "delta.md").write_text("## ADDED Requirements\n### Requirement: X\n")

    def _simulate_git_agent_commit(self):
        """Stand in for the git role: stage and commit whatever the worker/archive left dirty."""
        self.ctx.git.run("add", "-A", cwd=self.repo)
        self.ctx.git.run("commit", "-q", "-m", "apply change", cwd=self.repo)

    def dirty_file(self, name="README.md", content="# test\nchanged\n"):
        """Modify an already-tracked file so `git diff HEAD` picks it up (untracked
        new files are invisible to `git diff` unless staged)."""
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


class CmdPlannerTest(PhaseTestCase):
    def test_starts_planner_agent(self):
        self.make_state("explore")
        commands.cmd_planner(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertIn("planner", state["panes"])
        prompts = [call for call in self.herdr.calls if call[:2] == ("pane", "run") and "/skill:herdr-openspec-planner" in call[3]]
        self.assertEqual(len(prompts), 1)

    def test_rejects_wrong_phase(self):
        self.make_state("apply")
        with self.assertRaises(SystemExit):
            commands.cmd_planner(self.ctx, Args(repo=str(self.repo), change="my-change"))


class CmdApplyTest(PhaseTestCase):
    def test_passes_quality_gate_and_starts_worker(self):
        self.make_state("proposed")
        self.write_change_artifacts(complete=True)
        commands.cmd_apply(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "apply")
        self.assertTrue(state["planQuality"]["passed"])
        self.assertIn("worker", state["panes"])

    def test_fails_quality_gate_without_tasks(self):
        self.make_state("proposed")
        self.write_change_artifacts(complete=False)
        with self.assertRaises(SystemExit) as ctx:
            commands.cmd_apply(self.ctx, Args(repo=str(self.repo), change="my-change"))
        self.assertIn("plan quality gate failed", str(ctx.exception))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "proposed")  # unchanged
        self.assertFalse(state["planQuality"]["passed"])

    def test_rejects_wrong_phase(self):
        self.make_state("apply")
        with self.assertRaises(SystemExit):
            commands.cmd_apply(self.ctx, Args(repo=str(self.repo), change="my-change"))


class CmdPhaseTest(PhaseTestCase):
    def test_explore_to_proposed_with_complete_plan(self):
        self.make_state("explore")
        self.write_change_artifacts(complete=True)
        commands.cmd_phase(self.ctx, Args(repo=str(self.repo), change="my-change", phase="proposed"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "proposed")

    def test_plan_rejected_when_incomplete(self):
        self.make_state("explore")
        self.write_change_artifacts(complete=False)
        with self.assertRaises(SystemExit) as ctx:
            commands.cmd_phase(self.ctx, Args(repo=str(self.repo), change="my-change", phase="proposed"))
        self.assertTrue(str(ctx.exception).startswith("PLAN_REJECTED:"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "explore")  # unchanged

    def test_invalid_transition_rejected(self):
        self.make_state("explore")
        with self.assertRaises(SystemExit) as ctx:
            commands.cmd_phase(self.ctx, Args(repo=str(self.repo), change="my-change", phase="apply"))
        self.assertIn("invalid transition", str(ctx.exception))


class CmdOverridePhaseTest(PhaseTestCase):
    def test_overrides_to_any_operational_phase(self):
        self.make_state("apply")
        commands.cmd_override_phase(self.ctx, Args(repo=str(self.repo), change="my-change", phase="paused"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "paused")

    def test_rejects_unknown_phase(self):
        self.make_state("apply")
        with self.assertRaises(SystemExit):
            commands.cmd_override_phase(self.ctx, Args(repo=str(self.repo), change="my-change", phase="not-a-phase"))

    def test_rejects_override_of_closed(self):
        self.make_state("closed")
        with self.assertRaises(SystemExit):
            commands.cmd_override_phase(self.ctx, Args(repo=str(self.repo), change="my-change", phase="apply"))


class CmdVerifyTest(PhaseTestCase):
    def test_starts_triage_round(self):
        self.make_state("apply", verificationRound=0, panes={"dashboard": "pane-dash", "git": "pane-git"})
        self.write_change_artifacts(complete=True, task_marks=("x",))
        self.dirty_file()
        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "triage")
        self.assertEqual(state["verificationRound"], 1)
        self.assertIn(state["verificationTier"], {"lite", "full", "trivial"})
        self.assertIn("triage", state["panes"])
        self.assertTrue(commands.triage_input_path(state).exists())

    def test_no_openspec_workflow_skips_task_check(self):
        self.make_state("apply", verificationRound=0, workflowType="no-openspec")
        self.dirty_file()
        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "triage")

    def test_rejects_incomplete_tasks(self):
        self.make_state("apply", verificationRound=0)
        self.write_change_artifacts(complete=True, task_marks=(" ",))
        self.dirty_file()
        with self.assertRaises(SystemExit):
            commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))

    def test_already_verifying_is_a_noop(self):
        self.make_state("verify", verificationRound=1)
        self.write_change_artifacts(complete=True)
        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "verify")
        self.assertEqual(state["verificationRound"], 1)

    def test_rejects_wrong_phase(self):
        self.make_state("explore")
        with self.assertRaises(SystemExit):
            commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))

    def test_rejects_round_limit_reached(self):
        self.make_state("apply", verificationRound=self.ctx.config["workflow"]["max_verification_rounds"])
        with self.assertRaises(SystemExit):
            commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))


class CmdDispatchVerifiersTest(PhaseTestCase):
    def _prepare_triage(self, workflow_type="standard"):
        self.make_state("apply", verificationRound=0, workflowType=workflow_type)
        if workflow_type != "no-openspec":
            self.write_change_artifacts(complete=True)
        self.dirty_file()
        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        return state_mod.load_state(self.repo, "my-change")

    def test_dispatches_selected_verifiers(self):
        state = self._prepare_triage()
        triage_input = json.loads(commands.triage_input_path(state).read_text())
        files = triage_input["allChangedFiles"]
        plan = {"roles": {"quality-verifier": {"reason": "code change", "files": files}}}
        commands.triage_plan_path(state).write_text(json.dumps(plan))
        commands.cmd_dispatch_verifiers(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "verify")
        self.assertIn("quality-verifier", state["panes"])

    def test_empty_plan_goes_straight_to_developer_review(self):
        state = self._prepare_triage()
        commands.triage_plan_path(state).write_text(json.dumps({"roles": {}}))
        commands.cmd_dispatch_verifiers(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "developer-review")

    def test_invalid_role_rejected(self):
        state = self._prepare_triage()
        plan = {"roles": {"not-a-role": {"reason": "x", "files": ["a.py"]}}}
        commands.triage_plan_path(state).write_text(json.dumps(plan))
        with self.assertRaises(SystemExit):
            commands.cmd_dispatch_verifiers(self.ctx, Args(repo=str(self.repo), change="my-change"))

    def test_rejects_wrong_phase(self):
        self.make_state("apply")
        with self.assertRaises(SystemExit):
            commands.cmd_dispatch_verifiers(self.ctx, Args(repo=str(self.repo), change="my-change"))


def _write_triage_input(state, files=()):
    path = commands.triage_input_path(state)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"allChangedFiles": list(files)}))


def _write_report(state, role, verdict="PASS", findings=None):
    path = commands.report_path(state, role)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(finding) for finding in (findings or [])]
    lines.append(json.dumps({"type": "verdict", "verdict": verdict}))
    path.write_text("\n".join(lines) + "\n")


class CmdVerificationResultTest(PhaseTestCase):
    def _verifying_state(self, roles=("quality-verifier",)):
        state = self.make_state("verify", verificationRound=1, verificationRoles=list(roles), verificationTier="lite", verificationRoleStartedAt={role: self.clock.now().isoformat() for role in roles})
        _write_triage_input(state)
        return state

    def test_single_verifier_pass_starts_test_verifier(self):
        state = self._verifying_state()
        _write_report(state, "quality-verifier", "PASS")
        commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="quality-verifier"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "verify")
        self.assertTrue(state["testVerifierStarted"])
        self.assertIn("test-verifier", state["panes"])

    def test_test_verifier_pass_moves_to_developer_review(self):
        state = self._verifying_state()
        _write_report(state, "quality-verifier", "PASS")
        commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="quality-verifier"))
        state = state_mod.load_state(self.repo, "my-change")
        _write_report(state, "test-verifier", "PASS")
        commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="test-verifier"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "developer-review")
        self.assertEqual(state["verificationResults"]["coordinator"]["verdict"], "PASS")

    def test_any_fail_moves_to_fix(self):
        state = self._verifying_state(roles=("quality-verifier", "security-verifier"))
        _write_report(state, "quality-verifier", "FAIL", findings=[{"type": "finding", "severity": "critical", "path": "a.py", "line": 1, "detail": "bug"}])
        commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="quality-verifier"))
        _write_report(state, "security-verifier", "PASS")
        commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="security-verifier"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "fix")
        self.assertIn("worker", state["panes"])

    def test_round_limit_reached_pauses(self):
        max_rounds = self.ctx.config["workflow"]["max_verification_rounds"]
        state = self._verifying_state()
        state["verificationRound"] = max_rounds
        state_mod.save_state(state)
        _write_report(state, "quality-verifier", "FAIL")
        commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="quality-verifier"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "paused")

    def test_unknown_role_rejected(self):
        self._verifying_state()
        with self.assertRaises(SystemExit):
            commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="ghost-verifier"))

    def test_wrong_phase_is_ignored(self):
        self.make_state("fix")
        commands.cmd_verification_result(self.ctx, Args(repo=str(self.repo), change="my-change", role="quality-verifier"))  # no raise


class RecoveryTest(PhaseTestCase):
    def test_cmd_recover_writes_context_and_starts_recovery_agent(self):
        self.make_state("fix", verificationRound=1)
        commands.cmd_recover(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertIn("recovery", state["panes"])
        self.assertTrue((state_mod.workflow_dir(state) / "reviews" / "recovery-context.json").exists())

    def test_apply_recovery_retry_verification(self):
        state = self.make_state("fix", verificationRound=0, recoveryRunId="run-1")
        self.write_change_artifacts(complete=True)
        self.dirty_file()
        plan_path = state_mod.workflow_dir(state) / "reviews" / "recovery-plan.json"
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        plan_path.write_text(json.dumps({"recoveryId": "run-1", "action": "retry-verification"}))
        commands.cmd_apply_recovery(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "triage")

    def test_apply_recovery_rejects_wrong_recovery_id(self):
        state = self.make_state("fix", recoveryRunId="run-1")
        plan_path = state_mod.workflow_dir(state) / "reviews" / "recovery-plan.json"
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        plan_path.write_text(json.dumps({"recoveryId": "other", "action": "retry-verification"}))
        with self.assertRaises(SystemExit):
            commands.cmd_apply_recovery(self.ctx, Args(repo=str(self.repo), change="my-change"))

    def test_apply_recovery_missing_plan_rejected(self):
        self.make_state("fix", recoveryRunId="run-1")
        with self.assertRaises(SystemExit):
            commands.cmd_apply_recovery(self.ctx, Args(repo=str(self.repo), change="my-change"))


class ArchiveAndGitOperationsTest(PhaseTestCase):
    def test_developer_review_starts_archive(self):
        state = self.make_state("developer-review")
        self.write_change_artifacts(complete=True, task_marks=("x",))
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "archive")
        self.assertTrue(state["developerApproval"])
        self.assertIn("archive", state["panes"])

    def test_no_openspec_developer_review_skips_task_check(self):
        self.make_state("developer-review", workflowType="no-openspec")
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "archive")

    def test_archive_phase_starts_git_operations(self):
        self.make_state("archive")
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "committing")
        self.assertIn("git", state["panes"])

    def test_git_operations_subcommand_requires_archive_phase(self):
        self.make_state("developer-review")
        with self.assertRaises(SystemExit):
            commands.cmd_git_operations(self.ctx, Args(repo=str(self.repo), change="my-change"))

    def test_committing_phase_completes_on_clean_tree(self):
        self.make_state("committing")
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "completed")

    def test_committing_phase_rejects_dirty_tree(self):
        self.make_state("committing")
        self.dirty_file()
        with self.assertRaises(SystemExit):
            commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))


class CheckTimeoutTest(PhaseTestCase):
    def test_reports_no_timeout_when_not_verifying(self):
        self.make_state("apply")
        commands.cmd_check_timeout(self.ctx, Args(repo=str(self.repo), change="my-change"))  # no raise

    def test_flags_timed_out_roles(self):
        self.make_state("verify", verificationStartedAt=self.clock.now().isoformat(), verificationRoles=["quality-verifier"], verificationRoleStartedAt={"quality-verifier": "2000-01-01T00:00:00+00:00"})
        commands.cmd_check_timeout(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "paused")
        self.assertIn("quality-verifier", state["verificationTimeoutRoles"])

    def test_within_timeout_does_not_pause(self):
        self.make_state("verify", verificationStartedAt=self.clock.now().isoformat(), verificationRoles=["quality-verifier"], verificationRoleStartedAt={"quality-verifier": self.clock.now().isoformat()})
        commands.cmd_check_timeout(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "verify")


class CmdMessageTest(PhaseTestCase):
    def test_writes_artifact_and_prompts_target(self):
        state = self.make_state("apply", panes={"worker": "pane-worker"})
        name = commands.role_agent_name(state, "worker")
        self.herdr.register_pane("pane-worker", name)
        self.herdr.set_agent(name, agent_status="idle")
        commands.cmd_message(self.ctx, Args(repo=str(self.repo), change="my-change", sender="dev", target="worker", text="please hurry"))
        calls = [call for call in self.herdr.calls if call[:2] == ("pane", "run") and "please hurry" in call[3]]
        self.assertEqual(len(calls), 1)

    def test_unknown_target_rejected(self):
        self.make_state("apply", panes={})
        with self.assertRaises(SystemExit):
            commands.cmd_message(self.ctx, Args(repo=str(self.repo), change="my-change", sender="dev", target="ghost", text="hi"))


class LaunchRoleTest(PhaseTestCase):
    def test_uses_tab_create_and_pane_run_not_agent_start(self):
        state = self.make_state("apply")
        commands.launch_role(self.ctx, state, "worker")
        kinds = [call[:2] for call in self.herdr.calls]
        self.assertIn(("tab", "create"), kinds)
        self.assertIn(("pane", "run"), kinds)
        self.assertNotIn(("agent", "start"), kinds)
        self.assertFalse(any(call[:2] == ("pane", "move") for call in self.herdr.calls))
        self.assertIn("worker", state["panes"])
        self.assertIn("worker", state["tabs"])


class PromptSubmissionTest(PhaseTestCase):
    def _state_with_pane(self, role="worker"):
        self.herdr.auto_advance_on_submit = False
        state = self.make_state("apply", panes={role: "pane-1"})
        name = commands.role_agent_name(state, role)
        self.herdr.register_pane("pane-1", name)
        self.herdr.set_agent(name, agent_status="idle")
        return state

    def test_submits_on_first_pane_run(self):
        state = self._state_with_pane()
        name = commands.role_agent_name(state, "worker")
        self.herdr.after(lambda args: args[:2] == ("pane", "run"), lambda args: self.herdr.set_status(name, "working"))
        commands.prompt_role(self.ctx, state, "worker", text="go")
        send_keys = [call for call in self.herdr.calls if call[:2] == ("pane", "send-keys")]
        self.assertEqual(send_keys, [])

    def test_nudges_with_enter_when_prefilled(self):
        state = self._state_with_pane()
        name = commands.role_agent_name(state, "worker")
        self.herdr.after(lambda args: args[:3] == ("pane", "send-keys", "pane-1") and args[3] == "enter", lambda args: self.herdr.set_status(name, "working"))
        commands.prompt_role(self.ctx, state, "worker", text="go")
        enter_calls = [call for call in self.herdr.calls if call == ("pane", "send-keys", "pane-1", "enter")]
        self.assertEqual(len(enter_calls), 1)

    def test_raises_after_exhausting_retries(self):
        state = self._state_with_pane()
        (state_mod.workflow_dir(state) / "trace-context").mkdir(parents=True, exist_ok=True)
        trace_file = state_mod.workflow_dir(state) / "trace-context" / "worker.json"
        trace_file.write_text("{}")
        with self.assertRaises(SystemExit) as ctx:
            commands.prompt_role(self.ctx, state, "worker", text="go")
        self.assertIn("not acknowledged", str(ctx.exception))
        self.assertFalse(trace_file.exists())


if __name__ == "__main__":
    unittest.main()
