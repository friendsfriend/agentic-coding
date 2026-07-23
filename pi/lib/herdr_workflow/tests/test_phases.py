import json
import tempfile
import unittest
from pathlib import Path

from herdr_workflow import commands
from herdr_workflow import state as state_mod
from herdr_workflow.tests.fakes import FakeClock, FakeGit, FakeHerdr, init_repo, make_context


class FailFirstPushGit(FakeGit):
    def __init__(self):
        self.fail_push = True

    def run(self, *args, cwd):
        if args[0] == "push" and self.fail_push:
            self.fail_push = False
            raise SystemExit("push failed")
        return super().run(*args, cwd=cwd)


class MoveBaseAfterPushGit(FakeGit):
    def run(self, *args, cwd):
        result = super().run(*args, cwd=cwd)
        if args[0] == "push":
            super().run("branch", "-f", "main", "HEAD", cwd=cwd)
            super().run("push", "origin", "main", cwd=cwd)
        return result


class FailFirstPushExceptionGit(FakeGit):
    def __init__(self):
        self.fail_push = True

    def run(self, *args, cwd):
        if args[0] == "push" and self.fail_push:
            self.fail_push = False
            raise OSError("push failed")
        return super().run(*args, cwd=cwd)


class CommittingPushGit(FakeGit):
    def __init__(self, repo):
        super().__init__()
        self.repo = repo
        self.phases = []

    def run(self, *args, cwd):
        if args[0] == "push":
            self.phases.append(state_mod.load_state(self.repo, "my-change")["phase"])
        return super().run(*args, cwd=cwd)


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
        self.origin = Path(self._tmp.name) / "origin.git"
        import subprocess
        subprocess.run(["git", "init", "--bare", "-q", "-b", "main", str(self.origin)], check=True)
        self.ctx.git.run("remote", "add", "origin", str(self.origin), cwd=self.repo)
        self.ctx.git.run("push", "-q", "origin", "main", cwd=self.repo)
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
            "baseBranch": "origin/main",
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
        launches = [call for call in self.herdr.calls if call[:2] == ("agent", "start") and "/skill:herdr-openspec-planner" in call[-1]]
        self.assertEqual(len(launches), 1)

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

    def test_no_openspec_workflow_skips_tasks_and_openspec_review(self):
        self.make_state("apply", verificationRound=0, workflowType="no-openspec")
        self.dirty_file()
        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        triage_input = json.loads(commands.triage_input_path(state).read_text())
        self.assertEqual(state["phase"], "triage")
        self.assertNotIn("openspec-verifier", triage_input["availableRoles"])
        self.assertNotIn("openspec-verifier", triage_input["suggestedRoles"])
        self.assertNotIn("openSpec", triage_input["deterministicChecks"])

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

    def test_no_openspec_workflow_rejects_openspec_verifier(self):
        state = self._prepare_triage("no-openspec")
        files = json.loads(commands.triage_input_path(state).read_text())["allChangedFiles"]
        plan = {"roles": {"openspec-verifier": {"reason": "openspec changed", "files": files}}}
        commands.triage_plan_path(state).write_text(json.dumps(plan))
        with self.assertRaisesRegex(SystemExit, "unavailable roles"):
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

    def test_finish_review_only_sends_selected_findings_to_worker(self):
        state = self.make_state("developer-review", verificationRound=1, verificationResults={"quality-verifier": {"verdict": "PASS"}, "test-verifier": {"verdict": "PASS"}})
        reviews = state_mod.workflow_dir(state) / "reviews"
        reviews.mkdir(parents=True, exist_ok=True)
        reviews.joinpath("findings.json").write_text(json.dumps({"rounds": {"1": [
            {"id": "warn-1", "severity": "warning", "role": "quality-verifier", "status": "new", "path": "a.py", "line": 1, "detail": "optional cleanup"},
            {"id": "info-1", "severity": "info", "role": "quality-verifier", "status": "new", "path": "b.py", "line": 2, "detail": "accepted cleanup"},
        ]}}))
        reviews.joinpath("developer-review.json").write_text(json.dumps({"comments": [
            {"findingId": "warn-1", "filePath": "a.py", "line": 1, "body": "optional cleanup"},
            {"filePath": "c.py", "line": 4, "startLine": 2, "endLine": 4, "body": "review range"},
        ]}))

        commands.cmd_finish_review(self.ctx, Args(repo=str(self.repo), change="my-change"))

        state = state_mod.load_state(self.repo, "my-change")
        context = reviews.joinpath("developer-review-context.md").read_text()
        accepted = json.loads(reviews.joinpath("accepted-findings.json").read_text())
        self.assertEqual(state["phase"], "apply")
        self.assertIn("worker", state["panes"])
        self.assertIn("optional cleanup", context)
        self.assertIn("c.py:2-4", context)
        self.assertNotIn("accepted cleanup", context)
        self.assertEqual(accepted["ids"], ["info-1"])

    def test_finish_review_without_comments_archives_and_accepts_findings(self):
        state = self.make_state("developer-review", verificationRound=1)
        self.write_change_artifacts(complete=True, task_marks=("x",))
        reviews = state_mod.workflow_dir(state) / "reviews"
        reviews.mkdir(parents=True, exist_ok=True)
        reviews.joinpath("findings.json").write_text(json.dumps({"rounds": {"1": [{"id": "info-1", "severity": "info", "status": "new"}]}}))
        reviews.joinpath("developer-review.json").write_text(json.dumps({"comments": []}))

        commands.cmd_finish_review(self.ctx, Args(repo=str(self.repo), change="my-change"))

        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "archive")
        self.assertEqual(json.loads(reviews.joinpath("accepted-findings.json").read_text())["ids"], ["info-1"])

    def test_accepted_optional_findings_are_not_reoffered(self):
        state = self.make_state("developer-review", verificationRound=1)
        reviews = state_mod.workflow_dir(state) / "reviews"
        reviews.mkdir(parents=True, exist_ok=True)
        reviews.joinpath("findings.json").write_text(json.dumps({"rounds": {"1": [{"id": "info-1", "severity": "info", "status": "accepted"}]}}))
        self.assertEqual(commands.optional_findings(state), [])


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

    def test_developer_review_without_openspec_change_skips_archive(self):
        self.make_state("developer-review", workflowType="no-openspec")
        self.dirty_file()
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "completed")
        self.assertNotIn("archive", state["panes"])
        self.assertFalse(any("herdr-openspec-archive" in str(call) for call in self.herdr.calls))

    def test_archive_phase_commits_and_pushes_without_agent(self):
        self.make_state("archive")
        self.dirty_file()
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "completed")
        self.assertEqual(self.ctx.git.run("log", "-1", "--format=%s", cwd=self.repo), "Apply my-change")
        self.assertEqual(self.ctx.git.run("rev-parse", "HEAD", cwd=self.repo), self.ctx.git.run("rev-parse", "origin/feature/my-change", cwd=self.repo))
        self.assertIn(("pane", "close", "pane-git"), self.herdr.calls)
        self.assertFalse(any(call[:2] == ("agent", "start") for call in self.herdr.calls))

    def test_git_operations_are_committing_while_pushing(self):
        self.ctx.git = CommittingPushGit(self.repo)
        self.make_state("archive")
        self.dirty_file()

        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))

        self.assertEqual(self.ctx.git.phases, ["committing"])

    def test_push_failure_keeps_workflow_retryable(self):
        self.ctx.git = FailFirstPushGit()
        self.make_state("archive")
        self.dirty_file()
        with self.assertRaisesRegex(SystemExit, "push failed"):
            commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        self.assertEqual(state_mod.load_state(self.repo, "my-change")["phase"], "archive")

        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "completed")
        self.assertEqual(self.ctx.git.run("rev-parse", "HEAD", cwd=self.repo), self.ctx.git.run("rev-parse", "origin/feature/my-change", cwd=self.repo))

    def test_exception_during_push_restores_archive_phase_and_start_time(self):
        self.ctx.git = FailFirstPushExceptionGit()
        original_start = "2024-01-01T00:00:00+00:00"
        self.make_state("archive", phaseStartedAt=original_start)
        self.dirty_file()

        with self.assertRaisesRegex(OSError, "push failed"):
            commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))

        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "archive")
        self.assertEqual(state["phaseStartedAt"], original_start)

    def test_base_move_after_push_does_not_block_completion(self):
        self.ctx.git = MoveBaseAfterPushGit()
        state = self.make_state("archive")
        self.dirty_file()

        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))

        self.assertNotEqual(self.ctx.git.run("rev-parse", "origin/main", cwd=self.repo), state["baseCommit"])
        self.assertEqual(state_mod.load_state(self.repo, "my-change")["phase"], "completed")
        self.assertEqual(self.ctx.git.run("log", "-1", "--format=%s", cwd=self.repo), "Apply my-change")
        self.assertEqual(self.ctx.git.run("status", "--porcelain", cwd=self.repo), "")

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
        calls = [call for call in self.herdr.calls if call[:2] == ("agent", "send") and "please hurry" in call[3]]
        self.assertEqual(len(calls), 1)

    def test_unknown_target_rejected(self):
        self.make_state("apply", panes={})
        with self.assertRaises(SystemExit):
            commands.cmd_message(self.ctx, Args(repo=str(self.repo), change="my-change", sender="dev", target="ghost", text="hi"))


class LaunchRoleTest(PhaseTestCase):
    def test_long_change_agent_names_keep_role_suffix(self):
        state = {"changeId": "x" * 32}
        worker = commands.role_agent_name(state, "worker")
        triage = commands.role_agent_name(state, "triage")

        self.assertEqual(len(worker), 32)
        self.assertTrue(worker.endswith("-worker"))
        self.assertTrue(triage.endswith("-triage"))
        self.assertNotEqual(worker, triage)

    def test_starts_pi_agent_with_initial_prompt(self):
        state = self.make_state("apply")
        commands.launch_role(self.ctx, state, "worker")
        kinds = [call[:2] for call in self.herdr.calls]
        launch = next(call for call in self.herdr.calls if call[:2] == ("agent", "start"))
        self.assertIn(("tab", "create"), kinds)
        self.assertNotIn(("pane", "run"), kinds)
        self.assertNotIn(("pane", "send-keys"), kinds)
        self.assertEqual(launch[2], "my-change-worker")
        self.assertIn("--tab", launch)
        self.assertIn("--split", launch)
        self.assertTrue(any(call[:2] == ("pane", "close") for call in self.herdr.calls))
        self.assertIn("--name", launch)
        self.assertIn("my-change-worker", launch)
        self.assertIn("/skill:herdr-openspec-worker", launch[-1])
        self.assertIn("worker", state["panes"])
        self.assertIn("worker", state["tabs"])

    def test_groups_triage_and_verifiers_in_verification_tab(self):
        state = self.make_state("triage")
        commands.launch_role(self.ctx, state, "triage")
        commands.launch_role(self.ctx, state, "quality-verifier")
        commands.launch_role(self.ctx, state, "performance-verifier")
        launches = [call for call in self.herdr.calls if call[:2] == ("agent", "start")]
        verification_tab = state["tabs"]["verification"]
        self.assertEqual(len([call for call in self.herdr.calls if call[:2] == ("tab", "create")]), 1)
        for launch in launches:
            self.assertIn("--tab", launch)
            self.assertEqual(launch[launch.index("--tab") + 1], verification_tab)
            self.assertEqual(launch[launch.index("--split") + 1], "right")
        self.assertEqual(state["tabs"]["triage"], verification_tab)
        self.assertEqual(state["tabs"]["quality-verifier"], verification_tab)
        self.assertEqual(state["tabs"]["performance-verifier"], verification_tab)

    def test_replacing_grouped_role_closes_only_its_pane(self):
        state = self.make_state("verify", panes={"quality-verifier": "old-pane"}, tabs={"quality-verifier": "verification-tab", "verification": "verification-tab"})
        commands.launch_role(self.ctx, state, "quality-verifier")
        self.assertIn(("pane", "close", "old-pane"), self.herdr.calls)
        self.assertNotIn(("tab", "close", "verification-tab"), self.herdr.calls)

    def test_never_reuses_worker_tab_as_verification_tab(self):
        state = self.make_state("verify", panes={"worker": "worker-pane"}, tabs={"worker": "worker-tab", "verification": "worker-tab"})
        commands.launch_role(self.ctx, state, "quality-verifier")
        launch = next(call for call in self.herdr.calls if call[:2] == ("agent", "start"))
        self.assertNotEqual(launch[launch.index("--tab") + 1], "worker-tab")
        self.assertNotIn(("pane", "close", "worker-pane"), self.herdr.calls)
        self.assertNotIn(("tab", "close", "worker-tab"), self.herdr.calls)

class PromptSubmissionTest(PhaseTestCase):
    def test_submits_follow_up_through_agent_send(self):
        state = self.make_state("apply", panes={"worker": "pane-1"})
        self.herdr.register_pane("pane-1", commands.role_agent_name(state, "worker"))
        commands.prompt_role(self.ctx, state, "worker", text="go")
        self.assertIn(("agent", "send", "pane-1", "go"), self.herdr.calls)
        self.assertFalse(any(call[:2] in {("pane", "run"), ("pane", "send-keys"), ("wait", "agent-status")} for call in self.herdr.calls))

    def test_reuses_role_launched_with_pi_name(self):
        state = self.make_state("apply")
        commands.launch_role(self.ctx, state, "worker")
        self.herdr.calls.clear()

        commands.start_role(self.ctx, state, "worker", text="go")

        self.assertIn(("agent", "get", state["panes"]["worker"]), self.herdr.calls)
        self.assertIn(("agent", "send", state["panes"]["worker"], "go"), self.herdr.calls)
        self.assertFalse(any(call[:2] == ("agent", "start") for call in self.herdr.calls))

    def test_reuses_persistent_done_verifier(self):
        state = self.make_state("verify", panes={"quality-verifier": "pane-1"}, tabs={"quality-verifier": "tab-verification", "verification": "tab-verification"})
        self.herdr.register_pane("pane-1", commands.role_agent_name(state, "quality-verifier"), "tab-verification")
        self.herdr.set_status("pane-1", "done")
        commands.start_role(self.ctx, state, "quality-verifier", text="next round")
        self.assertIn(("agent", "send", "pane-1", "next round"), self.herdr.calls)
        self.assertFalse(any(call[:2] == ("agent", "start") for call in self.herdr.calls))

    def test_refreshes_moved_standalone_agent_tab(self):
        state = self.make_state("apply")
        commands.launch_role(self.ctx, state, "worker")
        actual_tab = state["tabs"]["worker"]
        state["tabs"]["worker"] = "stale-tab"
        commands.start_role(self.ctx, state, "worker", text="go")
        self.assertEqual(state["tabs"]["worker"], actual_tab)
        self.assertNotIn(("tab", "close", "stale-tab"), self.herdr.calls)

    def test_unknown_agent_restarts_in_fresh_tab(self):
        state = self.make_state("apply", panes={"worker": "old-pane"}, tabs={"worker": "old-tab"})
        self.herdr.register_pane("old-pane", commands.role_agent_name(state, "worker"))
        self.herdr.set_status("old-pane", "unknown")
        commands.start_role(self.ctx, state, "worker", text="go")
        self.assertIn(("tab", "close", "old-tab"), self.herdr.calls)
        self.assertNotEqual(state["panes"]["worker"], "old-pane")
        launch = next(call for call in self.herdr.calls if call[:2] == ("agent", "start"))
        self.assertEqual(launch[2], commands.role_agent_name(state, "worker"))


if __name__ == "__main__":
    unittest.main()
