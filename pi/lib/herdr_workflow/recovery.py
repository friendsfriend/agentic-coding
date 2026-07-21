"""Pure recovery-plan validation."""
from .tiering import TEST_VERIFIER, VERIFIER_ROLES

RECOVERY_ACTION_PHASES = {"retry-verification": {"apply", "fix", "paused"}, "dispatch-triage": {"triage"}, "record-verifier-result": {"verify"}}


def recovery_plan_error(state, plan):
    if not isinstance(plan, dict):
        return "invalid recovery plan schema"
    if plan.get("recoveryId") != state.get("recoveryRunId"):
        return "invalid recovery plan identifier"
    action = plan.get("action")
    if "action" not in plan:
        return "invalid recovery plan schema"
    if action == "record-verifier-result" and "role" not in plan:
        return "invalid recovery plan schema"
    if action not in RECOVERY_ACTION_PHASES or state["phase"] not in RECOVERY_ACTION_PHASES[action]:
        return "invalid recovery action for current phase"
    if action == "record-verifier-result" and plan["role"] not in (*state.get("verificationRoles", VERIFIER_ROLES), TEST_VERIFIER):
        return "invalid recovery verifier role"
    return None
