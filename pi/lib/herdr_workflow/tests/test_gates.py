import unittest

from herdr_workflow import gates


class EvaluatePlanQualityTest(unittest.TestCase):
    def test_all_present_passes(self):
        result = gates.evaluate_plan_quality([], has_specs=True, task_count=3)
        self.assertTrue(result["passed"])
        self.assertEqual(result["issues"], [])

    def test_missing_file_reported(self):
        result = gates.evaluate_plan_quality(["design"], has_specs=True, task_count=3)
        self.assertFalse(result["passed"])
        self.assertIn("missing or empty design.md", result["issues"])

    def test_missing_specs_reported(self):
        result = gates.evaluate_plan_quality([], has_specs=False, task_count=3)
        self.assertIn("missing spec scenarios", result["issues"])

    def test_no_tasks_reported(self):
        result = gates.evaluate_plan_quality([], has_specs=True, task_count=0)
        self.assertIn("tasks.md has no actionable tasks", result["issues"])

    def test_multiple_missing_artifacts(self):
        result = gates.evaluate_plan_quality(["proposal", "tasks"], has_specs=False, task_count=0)
        self.assertEqual(len(result["issues"]), 4)


class TaskParsingTest(unittest.TestCase):
    def test_count_tasks(self):
        text = "- [ ] one\n- [x] two\n* [X] three\nnot a task\n"
        self.assertEqual(gates.count_tasks(text), 3)

    def test_incomplete_tasks_detected(self):
        text = "- [ ] one\n- [x] two\n"
        tasks, incomplete = gates.incomplete_tasks(text)
        self.assertEqual(len(tasks), 2)
        self.assertEqual(incomplete, ["one"])

    def test_all_complete_no_incomplete(self):
        text = "- [x] one\n- [X] two\n"
        _tasks, incomplete = gates.incomplete_tasks(text)
        self.assertEqual(incomplete, [])

    def test_no_tasks_present(self):
        tasks, incomplete = gates.incomplete_tasks("just prose, no checklist")
        self.assertEqual(tasks, [])
        self.assertEqual(incomplete, [])


if __name__ == "__main__":
    unittest.main()
