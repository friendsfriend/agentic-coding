## Why

The stage tester currently may report no business knowledge observations even after learning an undocumented process, leaving the wiki review gate with nothing to approve and the process knowledge lost between runs. This change makes tester understanding explicit and routes useful business observations into durable process documentation for future runs.

## What Changes

- Brief the tester to read a process wiki page first and record concise business-process observations in its report, excluding UI/tooling quirks.
- Make the review action available whenever any knowledge observation exists, and align wiki-step gating with that behavior.
- Define stage-wiki documentation of process purpose, actors, ordered steps, decisions/rules, inputs/outputs, open questions, and implementing block IDs.
- Guard stage-wiki updates with a per-concept content digest so concurrent runs cannot overwrite a newer process page; treat report observations as untrusted evidence and safely render report Markdown.
- Add focused tests and regenerate embedded instructions without changing the store schema.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `stage-test-workflow`: require complete business observations and allow wiki review for any observation.
- `stage-process-knowledge`: define business-process wiki content and its observation-driven write-back.

## Impact

The stage-tester and stage-wiki instruction assets, stage review actions and wiki-routing effect/gating behavior, the active built-in stage-test definition, wiki write locking and expected-digest handling, stage-report Markdown rendering, embedded instruction generation, and focused workflow/prompt/wiki tests. No store schema change or migration is needed; the general `knowledge-wiki` concept format remains unchanged.
