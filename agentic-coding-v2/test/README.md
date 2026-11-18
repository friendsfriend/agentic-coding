# Test cost rules

Target: the complete default suite around one minute. It currently runs in ~62 s.

Prefer a deterministic unit test over an integration test. A rule that can be
expressed against a pure function is proven there, not by standing up a runtime,
gateway, engine, database, cluster or receiver.

- Unit-test pure logic directly: parsers, windowing/cursor math, argv construction,
  redaction and validation/refusal rules. `test/compose-values.test.ts` and
  `test/diagnostic-history.test.ts` are the model.
- Keep one representative end-to-end scenario per boundary (task admission, held
  SQL/HTTP diagnostic, container lifecycle, Kubernetes lifecycle, gateway client).
  Do not repeat the same boundary for each input permutation, engine, or refusal
  variant.
- Do not wait out real product deadlines, expiry windows or slow-response timers,
  and do not add a shorter production deadline to make a test faster.
- Wait for a specific observable event when testing ordering or cancellation, never
  an arbitrary sleep or a prescribed number of polling iterations.
- Simple infrastructure plumbing that the engine, Compose, Kubernetes or HTTP stack
  already guarantees is assumed correct rather than re-proven here.
- Do not increase timeouts, add retries, exclude files from the default run or
  enable unsafe concurrency to hide failures.
- Keep the removal honest: when a suite is deleted, say in the commit message and
  at the deletion site which guarantee is no longer directly asserted.
