# File-judgment conventions

The runtime conventions that make a per-file judgment decidable from one file in
isolation. They are prepended to every candidate file's state, so the classifier
reads them before the file itself.

- A wrapper that acquires the resource, runs the callback, and releases it on
  every exit path is **safe**.
- An explicit release on every exit path — the success path, every `return`, and
  every `throw` — is **safe**.
- `await using` disposes automatically and is **safe**.
- A cleanup block that releases some other resource is **not** a release.
- A transaction must be committed or reverted before its connection is released.
- Only the exported entry point is judged. A dead or unused helper does not
  decide the file.
