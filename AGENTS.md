## Testing scope

Keep tests small and functional. Test observable behavior and user-facing outcomes, not the implementation itself.

- Prefer a few representative scenarios through public boundaries: a feature works, a meaningful failure is handled, and critical safety or ownership guarantees hold.
- Do not add tests merely to mirror helpers, private state, compiled-plan layout, internal ordering, exact argv, or every validation branch. Assert such details only when they are themselves an externally required contract.
- Use lightweight disposable fixtures or fakes at external boundaries when needed. Do not build an elaborate simulation of the implementation just to test it.
- Avoid redundant cases, exhaustive permutations and coverage-padding tests. Extend an existing functional scenario when that is enough.
- Keep verification claims honest: passing fake-backed tests does not establish compatibility with a live runtime. Do not use real credentials, model calls, running apps or live infrastructure without explicit authorization.
- This scope does not replace the required lint and whole-project type-check gates above.

## Test suite cost strategy 

The unfiltered whole suite is the inner loop, not a slow integration gate. Its
local working target is roughly 12–15 seconds; this is a regression-review budget,
not a portable timing assertion. Preserve a measured before/after baseline for
performance changes. If a batch pushes the suite over budget or materially slows
it, profile and explain the cost before calling the work finished. Do not silently
normalize a slower baseline as the test count grows.

- Unit-test the rule, not the wiring. Parsers, windowing/cursor math, argv
  construction, validation and refusal tables, redaction and formatting belong in
  direct tests of the pure function (`test/compose-values.test.ts`,
  `test/diagnostic-history.test.ts`, `test/presentation-rules.test.ts`).
- Put scenario tables at the lowest layer that decides the observable rule.
  A schema/parser refusal belongs in a direct test of the production validator,
  not in a table whose every row creates Git repositories, a native harness,
  persistent storage and an authenticated HTTP host. Include a supported input
  so an unrelated setup failure cannot make every refusal appear correct. Where
  containment needs a filesystem, use the smallest disposable directory needed.
- Keep at most one representative scenario per boundary. Combine its useful
  success and failure transitions in that scenario; do not repeat it for each
  input permutation, engine, provider or refusal variant. Retain the boundary
  assertions that matter (authentication, masked errors, durable receipts,
  ownership and refusal to execute), and move the rule table below it. Never
  stand up a runtime, gateway, engine, database, cluster or receiver to re-prove
  what a direct rule test already decides.
- Assume simple plumbing is correct. Container/Compose/Kubernetes/HTTP mechanics
  that the underlying tool guarantees are not re-proven by tests.
- Never wait out a product deadline, expiry window or slow-response timer, and
  never add a shorter production deadline to make a test faster. Wait for a
  specific observable event; an arbitrary sleep or a prescribed number of polling
  iterations is not an assertion.
- Do not raise timeouts, add retries, exclude files or enable unsafe concurrency to
  make a slow suite look fast.
- When a suite is deleted rather than converted, record in the project docs which
  guarantee is no longer asserted automatically and is now reviewed by hand. Keep
  the trade explicit; do not claim coverage that no longer exists.
- Measure the complete, unfiltered suite after a batch, not after every edit, and
  report total runtime and failures together. For a slowdown, compare per-file
  and per-case timings with the saved baseline, distinguish new scenario cost
  from repeated fixture/setup cost, and report any concurrent changes or load
  that limit the comparison. A focused run is diagnostic, not the suite result.
