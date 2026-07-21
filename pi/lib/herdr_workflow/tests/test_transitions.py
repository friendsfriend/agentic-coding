import unittest

from herdr_workflow import transitions


class TransitionsTest(unittest.TestCase):
    def test_standard_allows_full_lifecycle(self):
        state = {"workflowModules": transitions.WORKFLOW_TYPES["standard"]}
        allowed = transitions.allowed_transitions(state)
        self.assertIn("proposed", allowed["explore"])
        # "proposed" is a gate module (developer approval): allowed_transitions leaves
        # it with no outgoing edge; proposed -> apply is enforced by the dedicated
        # `apply` subcommand instead, not the generic `phase` transition.
        self.assertEqual(allowed["proposed"], set())
        self.assertIn("verify", allowed["apply"])
        self.assertEqual(allowed["verify"], {"fix", "paused", "developer-review"})
        self.assertIn("developer-review", allowed["verify"])
        # developer-review is also a gate (developer approval); its outgoing edge
        # is enforced by the dedicated `archive` subcommand, not this table.
        self.assertEqual(allowed["developer-review"], set())
        self.assertIn("committing", allowed["archive"])
        self.assertIn("completed", allowed["committing"])

    def test_direct_apply_skips_planning(self):
        state = {"workflowModules": transitions.WORKFLOW_TYPES["direct-apply"]}
        allowed = transitions.allowed_transitions(state)
        self.assertNotIn("explore", allowed)
        self.assertIn("apply", allowed)
        self.assertIn("verify", allowed["apply"])

    def test_no_openspec_skips_archive(self):
        modules = transitions.WORKFLOW_TYPES["no-openspec"]
        allowed = transitions.allowed_transitions({"workflowModules": modules})
        self.assertNotIn("archive", modules)
        self.assertNotIn("archive", allowed)
        self.assertIn("completed", allowed["committing"])

    def test_verify_fix_paused_loop(self):
        state = {"workflowModules": transitions.WORKFLOW_TYPES["standard"]}
        allowed = transitions.allowed_transitions(state)
        self.assertEqual(allowed["fix"], {"verify"})
        self.assertEqual(allowed["paused"], {"fix", "verify"})

    def test_invalid_transition_absent(self):
        state = {"workflowModules": transitions.WORKFLOW_TYPES["standard"]}
        allowed = transitions.allowed_transitions(state)
        self.assertNotIn("completed", allowed.get("explore", set()))

    def test_resolve_modules_defaults_to_standard(self):
        self.assertEqual(transitions.resolve_modules({}), list(transitions.WORKFLOW_TYPES["standard"]))


if __name__ == "__main__":
    unittest.main()
