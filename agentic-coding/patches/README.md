# Codemode live output

`@earendil-works/pi-codemode@1.0.0` already receives script output events from
its worker, but only exposes the collected output after execution finishes.
The patch adds an optional `CodemodeExecuteOptions.onOutput` callback and
forwards each output item to it. The final result and sandbox semantics are
unchanged. The durable host uses the callback to publish live script output.

Bun applies this patch through `package.json`'s `patchedDependencies`. When
upgrading the package, remove the patch if the upstream API supports output
events; otherwise rebase it and rerun `test/agent-host-codemode.test.ts`.
