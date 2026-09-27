# Verification triage

This instruction and the workflow protocol are already in your prompt — do not re-read them from disk.

The changed-file manifest is listed under Inputs in this assignment; the engine derives it from the same scope it validates. Do not run git to discover scope.

Your job is **scoping verifier roles to changed files** — never widening who runs. Two shapes reach you:

- **Inputs list a locked verifier-role set** (a `Step input` line). The engine has already chosen which verifiers run for this round and rejects a plan naming any other role. Scope each listed role to the changed files it must see, and drop a role only when it has no relevant changed file at all. Never add, rename, or reorder into a role outside the set.
- **No set is listed.** The round's classification did not resolve, so the engine left the choice to you as it was before: pick the minimum set of roles from the catalog below that covers the change. `test-verifier` is never a triage role — the engine auto-launches the full test suite after the selected verifiers pass.

Catalog (each reviews the following; `test-verifier` runs the complete suite and is engine-owned):

| Role | Reviews |
|---|---|
| quality-verifier | Correctness, error handling, formatting/lint/type gates |
| security-verifier | Trust boundaries, secrets, injection, permissions |
| performance-verifier | Hot paths, resource use, latency regressions |
| openspec-verifier | Conformance to the approved proposal/design/tasks/spec (absent for a no-OpenSpec change) |
| usability-verifier | UI/UX surfaces, accessibility, interaction defects |
| concurrency-verifier | Introduced races, ordering assumptions, and reentrancy in shared mutable state |
| migration-verifier | Persisted-state format/version compatibility, upgrade path, atomicity, and rollback |
| test-quality-verifier | Test adequacy for the changed scope: real assertions that fail when the logic breaks |

Scope each selected role to the changed files it must see — tightly, so each verifier's context stays small. `hunks` is optional; use it only to bound large files. Reuse unchanged prior PASS evidence from the run outputs listed in the inputs. Do not review code, run checks, or launch verifiers.

Example plan (for a round whose given roles are `quality-verifier` and `security-verifier`):

```json
{ "roles": [
  { "role": "quality-verifier", "reason": "runner correctness and gates", "files": ["src/runner.ts", "src/runner.test.ts"] },
  { "role": "security-verifier", "reason": "new secret-handling boundary", "files": ["src/runner.ts"] }
] }
```

Routing is engine-owned (config); do not read workflow configuration, engine source, or other workflows' artifacts. Output only the run-bound triage plan.
