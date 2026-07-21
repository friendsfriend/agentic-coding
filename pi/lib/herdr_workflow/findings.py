"""Pure finding schema validation and cross-verifier consolidation."""
import hashlib
import re


def validate_report_events(events, path):
    if len(events) > 31:
        raise SystemExit(f"report exceeds 30 findings plus verdict: {path}")
    for event in events:
        if event.get("type") == "verdict":
            continue
        if event.get("type") != "finding":
            raise SystemExit(f"report contains unsupported record type: {path}")
        if event.get("severity") not in {"critical", "warning", "info"} or not isinstance(event.get("path"), str) or not isinstance(event.get("line"), int) or not isinstance(event.get("detail"), str):
            raise SystemExit(f"invalid finding schema: {path}")
        for field, limit in (("detail", 1000), ("evidence", 2000), ("fix", 1000)):
            if field in event and (not isinstance(event[field], str) or len(event[field]) > limit):
                raise SystemExit(f"finding {field} exceeds {limit} characters: {path}")


def consolidate(events_by_role, prior_round, accepted_ids):
    """Dedupe findings across verifier roles, assign new/unfixed/fixed/accepted status.

    events_by_role: {role: [event, ...]} already-loaded JSONL events per role.
    prior_round: [finding, ...] from the previous round's history (may be empty).
    accepted_ids: set of finding ids marked accepted by a developer.
    Returns the flattened findings list (new + prior fixed/unfixed/accepted).
    """
    unique = {}
    for role, events in events_by_role.items():
        for event in events:
            if event.get("type") != "finding":
                continue
            detail = str(event.get("detail", ""))
            path = event.get("path")
            line = event.get("line")
            key = re.sub(r"\s+", " ", f"{path}:{line}:{detail}".lower())
            finding_id = str(event.get("id") or hashlib.sha256(key.encode()).hexdigest()[:12])
            unique.setdefault(finding_id, {"id": finding_id, "severity": event["severity"], "role": role, "detail": detail, "path": path, "line": line, "evidence": event.get("evidence"), "fix": event.get("fix")})
    previous = {item["id"] for item in prior_round if item.get("status") in {"new", "unfixed"}}
    findings = []
    for finding in unique.values():
        finding["status"] = "accepted" if finding["id"] in accepted_ids else "unfixed" if finding["id"] in previous else "new"
        findings.append(finding)
    for prior in prior_round:
        if prior["id"] not in unique and prior.get("status") in {"new", "unfixed"}:
            findings.append({**prior, "status": "fixed"})
    return findings
