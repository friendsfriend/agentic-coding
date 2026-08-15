# Verification triage

This instruction and the workflow protocol are already in your prompt — do not re-read them from disk.

The changed-file manifest is listed under Inputs in this assignment; the engine derives it from the same scope it validates. Do not run git to discover scope.

Select the minimum verifier roles that cover the change:

| Role | Reviews |
|---|---|
| quality-verifier | Correctness, error handling, formatting/lint/type gates |
| security-verifier | Trust boundaries, secrets, injection, permissions |
| performance-verifier | Hot paths, resource use, latency regressions |
| openspec-verifier | Conformance to the approved proposal/design/tasks/spec |
| usability-verifier | UI/UX surfaces, accessibility, interaction defects |
| test-verifier | NEVER select: the engine auto-launches the full test suite after the selected verifiers pass |

Scope each selected role to the changed files it must see. `hunks` is optional; use it only to bound large files. Reuse unchanged prior PASS evidence from the run outputs listed in the inputs. Do not review code, run checks, or launch verifiers.

Example plan:

```json
{ "roles": [
  { "role": "quality-verifier", "reason": "runner correctness and gates", "files": ["src/runner.ts", "src/runner.test.ts"] },
  { "role": "security-verifier", "reason": "new secret-handling boundary", "files": ["src/runner.ts"] }
] }
```

Routing is engine-owned (config); do not read workflow configuration, engine source, or other workflows' artifacts. Output only the run-bound triage plan.
