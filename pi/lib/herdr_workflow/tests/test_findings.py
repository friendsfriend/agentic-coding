import unittest

from herdr_workflow import findings


class ValidateReportEventsTest(unittest.TestCase):
    def test_valid_finding_and_verdict_pass(self):
        events = [
            {"type": "finding", "severity": "warning", "path": "a.py", "line": 1, "detail": "x"},
            {"type": "verdict", "verdict": "PASS"},
        ]
        findings.validate_report_events(events, "report")  # no raise

    def test_too_many_findings_rejected(self):
        events = [{"type": "finding", "severity": "info", "path": "a.py", "line": 1, "detail": "x"} for _ in range(31)] + [{"type": "verdict", "verdict": "PASS"}]
        with self.assertRaises(SystemExit):
            findings.validate_report_events(events, "report")

    def test_unsupported_type_rejected(self):
        with self.assertRaises(SystemExit):
            findings.validate_report_events([{"type": "note"}], "report")

    def test_bad_severity_rejected(self):
        with self.assertRaises(SystemExit):
            findings.validate_report_events([{"type": "finding", "severity": "urgent", "path": "a.py", "line": 1, "detail": "x"}], "report")

    def test_detail_over_limit_rejected(self):
        event = {"type": "finding", "severity": "info", "path": "a.py", "line": 1, "detail": "x" * 1001}
        with self.assertRaises(SystemExit):
            findings.validate_report_events([event], "report")

    def test_evidence_over_limit_rejected(self):
        event = {"type": "finding", "severity": "info", "path": "a.py", "line": 1, "detail": "x", "evidence": "y" * 2001}
        with self.assertRaises(SystemExit):
            findings.validate_report_events([event], "report")


class ConsolidateTest(unittest.TestCase):
    def test_new_finding_status(self):
        events_by_role = {"quality-verifier": [{"type": "finding", "severity": "warning", "path": "a.py", "line": 1, "detail": "issue"}]}
        result = findings.consolidate(events_by_role, [], set())
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["status"], "new")

    def test_unfixed_finding_carries_forward(self):
        events_by_role = {"quality-verifier": [{"type": "finding", "id": "abc123", "severity": "warning", "path": "a.py", "line": 1, "detail": "issue"}]}
        prior_round = [{"id": "abc123", "status": "new"}]
        result = findings.consolidate(events_by_role, prior_round, set())
        self.assertEqual(result[0]["status"], "unfixed")

    def test_accepted_finding_status(self):
        events_by_role = {"quality-verifier": [{"type": "finding", "id": "abc123", "severity": "warning", "path": "a.py", "line": 1, "detail": "issue"}]}
        result = findings.consolidate(events_by_role, [], {"abc123"})
        self.assertEqual(result[0]["status"], "accepted")

    def test_fixed_when_missing_from_new_round(self):
        prior_round = [{"id": "abc123", "status": "new", "role": "quality-verifier"}]
        result = findings.consolidate({}, prior_round, set())
        self.assertEqual(result[0]["status"], "fixed")

    def test_dedup_same_finding_across_roles(self):
        event = {"type": "finding", "severity": "warning", "path": "a.py", "line": 1, "detail": "same issue text"}
        events_by_role = {"quality-verifier": [dict(event)], "security-verifier": [dict(event)]}
        result = findings.consolidate(events_by_role, [], set())
        self.assertEqual(len(result), 1)

    def test_previously_fixed_finding_not_reintroduced(self):
        prior_round = [{"id": "abc123", "status": "fixed", "role": "quality-verifier"}]
        result = findings.consolidate({}, prior_round, set())
        self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()
