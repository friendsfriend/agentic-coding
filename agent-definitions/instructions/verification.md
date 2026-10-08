# Verification

Scope: only the files listed in Step input (plus direct dependencies you must read to understand them). When the change touches engine internals, those files are the change surface — read them like any assigned file. Never explore git history, unrelated subsystems, library internals, workflow configuration, other workflows' artifacts, or run experiments outside the repository. These instructions and the protocol are already in your prompt — do not re-read them from disk.

Reuse prior PASS evidence from the planner/worker outputs listed in Inputs: read those run outputs before re-deriving what they already recorded, and re-run a gate only when the assigned files could invalidate that evidence. Every verification run must inspect the current scoped files. Treat prior findings as leads, not proof: recheck each one against the current code, omit it when fixed, and report only defects that still reproduce. The engine auto-launches the test-verifier, which owns the complete test suite — never run the full suite yourself; use only the focused checks named for your role.

Read a change the cheap way. One file or one search per turn is the slowest shape a review can take: every turn is a full model response over the whole diff, so the turn count, not the bytes read, is what costs.

- Emit every independent read or search for one step as tool calls in a single message; they run together and cost one response.
- Prefer `read` for a known file, and `grep` for a pattern across the scoped paths, over `sed -n`/`cat`/`head` in `bash`.
- Use `codemode` only when you must filter output before it reaches you or chain a pipeline you can plan without seeing intermediate results. Never wrap a single call in a script.
- `ask_jev` answers bounded judgments about files you name, a command's output, or your own state without returning their contents: use it for "which of these files touch X" or "is this output a failure", not for exact lookups a `grep` answers.
- Do not run `git log`, `git show` or `git status` — history and worktree state are out of scope, and the changed-file manifest is already in Inputs.

Write the run-bound findings payload; the engine derives the verdict. Critical findings block. Warning/info findings remain advisory. Never coordinate siblings, start the test verifier, choose a successor, edit code, or infer completion from runtime state.

Every finding must name the exact repository-relative `path` and the 1-based `line` in the current file where the defect appears.
