# Test cost rules

The goal is a complete default suite under one minute. The suite does not meet that
budget yet; do not describe reduced timings as achieving it.

- Do not wait out real product deadlines, expiry windows or slow-response timers.
  Do not add a smaller configurable production deadline just to make a test fast.
- Wait for a specific observable event when testing ordering or cancellation, not
  an arbitrary sleep or a prescribed count of polling iterations.
- Do not create a runtime, gateway and engine subprocess stack for every input
  permutation. Use `definition()` for configuration-only cases and batch related
  schema inputs over independent copies of one definition.
- Retain a small number of public/native boundary scenarios. Preserve unique
  approval, ownership, no-adoption and crash-recovery checks; do not replace them
  with private implementation mocks or skip them to report a faster green run.
- Do not multiply every lifecycle scenario by Docker and Podman. Cover both engine
  boundaries across representative scenarios instead.
- `createRepository()` copies a cached initial repository into independent files.
  Never share a writable checkout, index, config, object store or runtime between
  tests. Fixture teardown remains responsible for all test-owned resources.
- Do not increase timeouts, add retries, exclude slow files from the default run or
  enable unsafe concurrency to hide failures. Measure the complete suite and
  report both runtime and failures.
