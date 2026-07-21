import unittest

from herdr_workflow import recovery


class RecoveryPlanErrorTest(unittest.TestCase):
    def base_state(self, phase):
        return {"phase": phase, "recoveryRunId": "run-1", "verificationRoles": ["quality-verifier"]}

    def test_valid_retry_verification(self):
        state = self.base_state("fix")
        plan = {"recoveryId": "run-1", "action": "retry-verification"}
        self.assertIsNone(recovery.recovery_plan_error(state, plan))

    def test_valid_dispatch_triage(self):
        state = self.base_state("triage")
        plan = {"recoveryId": "run-1", "action": "dispatch-triage"}
        self.assertIsNone(recovery.recovery_plan_error(state, plan))

    def test_valid_record_verifier_result(self):
        state = self.base_state("verify")
        plan = {"recoveryId": "run-1", "action": "record-verifier-result", "role": "quality-verifier"}
        self.assertIsNone(recovery.recovery_plan_error(state, plan))

    def test_non_dict_plan_rejected(self):
        self.assertIsNotNone(recovery.recovery_plan_error(self.base_state("fix"), "not a dict"))

    def test_wrong_recovery_id_rejected(self):
        state = self.base_state("fix")
        plan = {"recoveryId": "other-run", "action": "retry-verification"}
        self.assertEqual(recovery.recovery_plan_error(state, plan), "invalid recovery plan identifier")

    def test_missing_action_rejected(self):
        state = self.base_state("fix")
        self.assertEqual(recovery.recovery_plan_error(state, {"recoveryId": "run-1"}), "invalid recovery plan schema")

    def test_record_verifier_result_missing_role_rejected(self):
        state = self.base_state("verify")
        plan = {"recoveryId": "run-1", "action": "record-verifier-result"}
        self.assertEqual(recovery.recovery_plan_error(state, plan), "invalid recovery plan schema")

    def test_action_wrong_phase_rejected(self):
        state = self.base_state("verify")  # retry-verification only allowed in apply/fix/paused
        plan = {"recoveryId": "run-1", "action": "retry-verification"}
        self.assertEqual(recovery.recovery_plan_error(state, plan), "invalid recovery action for current phase")

    def test_unknown_action_rejected(self):
        state = self.base_state("fix")
        plan = {"recoveryId": "run-1", "action": "delete-everything"}
        self.assertEqual(recovery.recovery_plan_error(state, plan), "invalid recovery action for current phase")

    def test_record_verifier_result_bad_role_rejected(self):
        state = self.base_state("verify")
        plan = {"recoveryId": "run-1", "action": "record-verifier-result", "role": "not-a-real-role"}
        self.assertEqual(recovery.recovery_plan_error(state, plan), "invalid recovery verifier role")

    def test_record_verifier_result_accepts_test_verifier(self):
        state = self.base_state("verify")
        plan = {"recoveryId": "run-1", "action": "record-verifier-result", "role": "test-verifier"}
        self.assertIsNone(recovery.recovery_plan_error(state, plan))


if __name__ == "__main__":
    unittest.main()
