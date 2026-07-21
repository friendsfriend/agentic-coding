import unittest

from herdr_workflow import tracing


class TraceparentTest(unittest.TestCase):
    def test_round_trip(self):
        value = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01"
        context = tracing.parse_traceparent(value)
        self.assertEqual(context["traceId"], "1234567890abcdef1234567890abcdef")
        self.assertEqual(context["spanId"], "1234567890abcdef")
        self.assertEqual(tracing.traceparent(context), value)

    def test_all_zero_trace_id_rejected(self):
        value = "00-00000000000000000000000000000000-1234567890abcdef-01"
        self.assertIsNone(tracing.parse_traceparent(value))

    def test_all_zero_span_id_rejected(self):
        value = "00-1234567890abcdef1234567890abcdef-0000000000000000-01"
        self.assertIsNone(tracing.parse_traceparent(value))

    def test_malformed_rejected(self):
        self.assertIsNone(tracing.parse_traceparent("not-a-traceparent"))

    def test_none_input_rejected(self):
        self.assertIsNone(tracing.parse_traceparent(None))

    def test_uppercase_accepted_and_lowercased(self):
        value = "00-1234567890ABCDEF1234567890ABCDEF-1234567890ABCDEF-01"
        context = tracing.parse_traceparent(value)
        self.assertEqual(context["traceId"], "1234567890abcdef1234567890abcdef")


class ChildContextTest(unittest.TestCase):
    def test_root_context_generates_new_trace_id(self):
        context = tracing.child_context(None)
        self.assertEqual(len(context["traceId"]), 32)
        self.assertEqual(len(context["spanId"]), 16)
        self.assertEqual(context["flags"], "01")

    def test_child_inherits_trace_id_and_flags(self):
        parent = {"traceId": "a" * 32, "spanId": "b" * 16, "flags": "01"}
        child = tracing.child_context(parent)
        self.assertEqual(child["traceId"], parent["traceId"])
        self.assertNotEqual(child["spanId"], parent["spanId"])
        self.assertEqual(child["flags"], "01")


class SpanRecordTest(unittest.TestCase):
    def test_span_record_shape(self):
        context = {"traceId": "a" * 32, "spanId": "b" * 16}
        record = tracing.span_record(context, "workflow.test", "1", "2", {"k": "v"}, parent_span_id="parent")
        self.assertEqual(record["traceId"], context["traceId"])
        self.assertEqual(record["name"], "workflow.test")
        self.assertEqual(record["parentSpanId"], "parent")
        self.assertEqual(record["status"], "OK")


if __name__ == "__main__":
    unittest.main()
