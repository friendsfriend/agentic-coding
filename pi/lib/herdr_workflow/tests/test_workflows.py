"""End-to-end per-workflow-type tests: drive a full run through fakes, asserting the
phase sequence matches the module chain and the run terminates in `completed`."""
import json
import unittest

from herdr_workflow import commands, transitions
from herdr_workflow import state as state_mod
from herdr_workflow.tests.test_phases import Args, PhaseTestCase


def _pass_verifier(test, state, role):
    from herdr_workflow.tests.test_phases import _write_report
    state = state_mod.load_state(test.repo, state["changeId"])
    _write_report(state, role, "PASS")
    commands.cmd_verification_result(test.ctx, Args(repo=str(test.repo), change=state["changeId"], role=role))
    return state_mod.load_state(test.repo, state["changeId"])


class StandardWorkflowTest(PhaseTestCase):
    def test_full_run_reaches_completed(self):
        phases_seen = []
        state = self.make_state("explore", workflowModules=list(transitions.WORKFLOW_TYPES["standard"]))
        phases_seen.append(state["phase"])

        # planner explores, submits proposal
        commands.cmd_planner(self.ctx, Args(repo=str(self.repo), change="my-change"))
        self.write_change_artifacts(complete=True)
        commands.cmd_phase(self.ctx, Args(repo=str(self.repo), change="my-change", phase="proposed"))
        state = state_mod.load_state(self.repo, "my-change")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "proposed")

        # developer approves -> apply, worker starts
        commands.cmd_apply(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "apply")

        # worker makes a change, triggers verification
        self.dirty_file()
        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "triage")

        # triage assigns one verifier
        triage_input = json.loads(commands.triage_input_path(state).read_text())
        plan = {"roles": {"quality-verifier": {"reason": "code change", "files": triage_input["allChangedFiles"]}}}
        commands.triage_plan_path(state).write_text(json.dumps(plan))
        commands.cmd_dispatch_verifiers(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "verify")

        # verifier passes -> test verifier starts -> test verifier passes -> developer-review
        state = _pass_verifier(self, state, "quality-verifier")
        self.assertTrue(state["testVerifierStarted"])
        state = _pass_verifier(self, state, "test-verifier")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "developer-review")

        # developer approves -> archive -> committing -> completed
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "archive")

        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "committing")

        self._simulate_git_agent_commit()
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        phases_seen.append(state["phase"])
        self.assertEqual(state["phase"], "completed")

        self.assertEqual(phases_seen, ["explore", "proposed", "apply", "triage", "verify", "developer-review", "archive", "committing", "completed"])


class DirectApplyWorkflowTest(PhaseTestCase):
    def test_full_run_skips_planning(self):
        state = self.make_state("apply", workflowModules=list(transitions.WORKFLOW_TYPES["direct-apply"]), workflowType="direct-apply")
        self.write_change_artifacts(complete=True)
        self.dirty_file()

        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "triage")

        triage_input = json.loads(commands.triage_input_path(state).read_text())
        plan = {"roles": {"quality-verifier": {"reason": "code change", "files": triage_input["allChangedFiles"]}}}
        commands.triage_plan_path(state).write_text(json.dumps(plan))
        commands.cmd_dispatch_verifiers(self.ctx, Args(repo=str(self.repo), change="my-change"))

        state = _pass_verifier(self, state_mod.load_state(self.repo, "my-change"), "quality-verifier")
        state = _pass_verifier(self, state, "test-verifier")
        self.assertEqual(state["phase"], "developer-review")

        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        self._simulate_git_agent_commit()
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "completed")


class NoOpenspecWorkflowTest(PhaseTestCase):
    def test_full_run_skips_task_checklist(self):
        state = self.make_state("apply", workflowModules=list(transitions.WORKFLOW_TYPES["no-openspec"]), workflowType="no-openspec")
        self.dirty_file()  # worker "applied the change" — no OpenSpec tasks.md required

        commands.cmd_verify(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "triage")

        triage_input = json.loads(commands.triage_input_path(state).read_text())
        plan = {"roles": {"quality-verifier": {"reason": "code change", "files": triage_input["allChangedFiles"]}}}
        commands.triage_plan_path(state).write_text(json.dumps(plan))
        commands.cmd_dispatch_verifiers(self.ctx, Args(repo=str(self.repo), change="my-change"))

        state = _pass_verifier(self, state_mod.load_state(self.repo, "my-change"), "quality-verifier")
        state = _pass_verifier(self, state, "test-verifier")
        self.assertEqual(state["phase"], "developer-review")

        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))  # skips ensure_tasks_complete
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "archive")

        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        self._simulate_git_agent_commit()
        commands.cmd_archive(self.ctx, Args(repo=str(self.repo), change="my-change"))
        state = state_mod.load_state(self.repo, "my-change")
        self.assertEqual(state["phase"], "completed")


if __name__ == "__main__":
    unittest.main()
