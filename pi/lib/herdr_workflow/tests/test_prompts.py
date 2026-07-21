import unittest

from herdr_workflow import prompts
from herdr_workflow.tests.fakes import DEFAULT_CONFIG


class RolePromptTest(unittest.TestCase):
    def test_planner_prompt_mentions_proposal_flow(self):
        text = prompts.role_prompt("planner", "my-change")
        self.assertIn("proposal", text)
        self.assertIn("herdr-workflow phase --repo . --change my-change proposed", text)

    def test_worker_prompt_default_mentions_tasks(self):
        text = prompts.role_prompt("worker", "my-change")
        self.assertIn("Mark each OpenSpec task", text)

    def test_worker_prompt_no_openspec_skips_tasks(self):
        text = prompts.role_prompt("worker", "my-change", workflow_type="no-openspec")
        self.assertNotIn("OpenSpec task", text)
        self.assertIn("request.md", text)
        self.assertIn("herdr-workflow verify --repo . --change my-change", text)

    def test_triage_prompt_references_round(self):
        text = prompts.role_prompt("triage", "my-change", verification_round=2)
        self.assertIn("round-2-triage-input.json", text)

    def test_verifier_prompt_references_context_and_report(self):
        text = prompts.role_prompt("security-verifier", "my-change", verification_round=1)
        self.assertIn("round-1-security-verifier-context.md", text)
        self.assertIn("round-1-security-verifier.findings.jsonl", text)
        self.assertIn("PASS", text)

    def test_archive_prompt_reads_archive_context_only(self):
        text = prompts.role_prompt("archive", "my-change")
        self.assertIn("archive-context.md", text)

    def test_recovery_prompt_lists_allowlisted_actions(self):
        text = prompts.role_prompt("recovery", "my-change")
        self.assertIn("retry-verification", text)
        self.assertIn("dispatch-triage", text)
        self.assertIn("record-verifier-result", text)


class PiArgumentsTest(unittest.TestCase):
    def test_unrestricted_role_has_no_tool_restrictions(self):
        args = prompts.pi_arguments("planner", "model/x", "high", "change", DEFAULT_CONFIG)
        joined = " ".join(args)
        self.assertNotIn("--no-extensions", joined)
        self.assertNotIn("--no-skills", joined)
        self.assertNotIn("--tools", joined)
        self.assertIn("herdr-telemetry.ts", joined)
        self.assertIn("herdr-workflow.ts", joined)

    def test_verifier_role_is_restricted(self):
        args = prompts.pi_arguments("quality-verifier", "model/x", "high", "change", DEFAULT_CONFIG)
        joined = " ".join(args)
        self.assertIn("--no-extensions", joined)
        self.assertIn("--no-skills", joined)
        self.assertIn("--tools", joined)
        self.assertIn("--no-session", joined)  # verifiers are one-shot

    def test_archive_role_has_no_context_files(self):
        args = prompts.pi_arguments("archive", "model/x", "high", "change", DEFAULT_CONFIG)
        self.assertIn("--no-context-files", args)

    def test_worker_role_is_not_one_shot(self):
        args = prompts.pi_arguments("worker", "model/x", "high", "change", DEFAULT_CONFIG)
        self.assertNotIn("--no-session", args)

    def test_exclusions_trigger_no_extensions_for_unrestricted_role(self):
        config = {**DEFAULT_CONFIG, "plugins": {"exclude_extensions": ["some-ext"]}}
        args = prompts.pi_arguments("planner", "model/x", "high", "change", config)
        self.assertIn("--no-extensions", args)
        self.assertIn("herdr-telemetry.ts", " ".join(args))


class ResolveExclusionsTest(unittest.TestCase):
    def test_no_config_returns_empty(self):
        self.assertEqual(prompts.resolve_exclusions({}, "planner"), set())

    def test_global_exclusions_apply_to_any_role(self):
        config = {"plugins": {"exclude_extensions": ["a", "b"]}}
        self.assertEqual(prompts.resolve_exclusions(config, "planner"), {"a", "b"})

    def test_role_exclusions_merge_with_global(self):
        config = {"plugins": {"exclude_extensions": ["g"], "roles": {"worker": {"exclude_extensions": ["w"]}}}}
        self.assertEqual(prompts.resolve_exclusions(config, "worker"), {"g", "w"})
        self.assertEqual(prompts.resolve_exclusions(config, "planner"), {"g"})


if __name__ == "__main__":
    unittest.main()
