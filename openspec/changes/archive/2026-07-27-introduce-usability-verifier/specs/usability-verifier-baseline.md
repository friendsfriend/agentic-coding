# Spec: usability verifier — baseline

## Scenario: Triage selects usability-verifier for UI-only change

**Setup**
- Worker applies a change that modifies `frontend/components/Button.tsx` and `frontend/styles/button.css`
- Triage round starts

**Expected behavior**
- `eligible_verifier_roles()` returns a list that includes `"usability-verifier"`
- Triage input `availableRoles` includes `"usability-verifier"`
- Triage plan can assign files to `"usability-verifier"`
- Dispatch launches the role agent
- Verifier writes findings JSONL with PASS/FAIL verdict
- `herdr-workflow verification-result --role usability-verifier` succeeds

## Scenario: Triage does NOT select usability-verifier for backend-only change

**Setup**
- Worker applies a change that only touches `src/services/order.py` and `tests/test_order.py`

**Expected behavior**
- `eligible_verifier_roles()` does NOT include `"usability-verifier"`
- Triage agent chooses not to include it on its own
- Verification proceeds without usability-verifier
- No disruption to existing verifier flow

## Scenario: Verifier produces findings

**Setup**
- Change introduces hardcoded color in `frontend/components/Card.tsx` and missing alt text in `frontend/components/Avatar.tsx`

**Expected**
- Verifier flags both issues in findings JSONL
- Final verdict is FAIL
- Optional findings surface in consolidated report

## Scenario: Verifier PASS

**Setup**
- Change follows design tokens, uses proper ARIA attributes, responsive layout correct

**Expected**
- No findings
- Final verdict is PASS
