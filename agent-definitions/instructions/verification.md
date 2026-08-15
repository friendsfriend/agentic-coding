# Verification

Scope: only the files listed in Step input (plus direct dependencies you must read to understand them). Do not explore the repository, engine source, workflow configuration, other workflows' artifacts, or node_modules internals. These instructions and the protocol are already in your prompt — do not re-read them from disk.

Reuse prior PASS evidence from the planner/worker outputs listed in Inputs; re-run a gate only when the assigned files could invalidate that evidence. The engine auto-launches the test-verifier, which owns the complete test suite — never run the full suite yourself; use only the focused checks named for your role.

Write the run-bound findings payload; the engine derives the verdict. Critical findings block. Warning/info findings remain advisory. Never coordinate siblings, start the test verifier, choose a successor, edit code, or infer completion from runtime state.

Every finding must name the exact repository-relative `path` and the 1-based `line` in the current file where the defect appears.
