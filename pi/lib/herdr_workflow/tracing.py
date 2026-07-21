"""Pure traceparent/span math. No I/O, no clock, no network."""
import re
import uuid


def parse_traceparent(value):
    match = re.fullmatch(r"00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})", value or "", re.I)
    if not match or set(match.group(1)) == {"0"} or set(match.group(2)) == {"0"}:
        return None
    return {"traceId": match.group(1).lower(), "spanId": match.group(2).lower(), "flags": match.group(3).lower()}


def traceparent(context):
    return f"00-{context['traceId']}-{context['spanId']}-{context.get('flags', '01')}"


def child_context(parent=None):
    return {"traceId": parent["traceId"] if parent else uuid.uuid4().hex, "spanId": uuid.uuid4().hex[:16], "flags": parent.get("flags", "01") if parent else "01"}


def span_record(context, name, start_nanos, end_nanos, attributes, parent_span_id=None, status="OK"):
    return {"traceId": context["traceId"], "spanId": context["spanId"], "parentSpanId": parent_span_id, "name": name, "startTimeUnixNano": start_nanos, "endTimeUnixNano": end_nanos, "status": status, "attributes": attributes}
