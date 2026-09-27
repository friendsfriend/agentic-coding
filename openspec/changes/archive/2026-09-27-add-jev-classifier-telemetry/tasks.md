# Tasks

## 1. Routing-decision summary (pure domain)

- [x] 1.1 Add a pure `RoutingDecisionSummary` type and builder in `agentic-coding/src/workflow/classifiers.ts` that turns a pass's phase, the asked steps, their pool entries, and the classifier answers into scalars-only data: asked step count, applied step count, fallback count, and per step the applied label, reported confidence, fallback flag, and applied profile or stable roster profiles plus roster size. Verify with new cases in `agentic-coding/test/workflow-classifiers.test.ts` covering a confident single selection, a below-floor selection reporting the tagged default rather than the rejected label, a `noul` answer reporting no label/confidence but an applied profile, and a three-profile roster reporting `selected.count = 3`.
- [x] 1.2 Prove the summary is content-free: add a case in `agentic-coding/test/workflow-classifiers.test.ts` whose answers and pool entries carry pool criteria and prose, and assert the summary contains no substring of either and no key derived from them.

## 2. Provider-call records on the adapter layer

- [x] 2.1 Instrument the `model.classify` effect handler in `agentic-coding/src/workflow/effect-runner.ts` to emit `routing.request` before the System One call and `routing.response` when it returns, through the runner's existing bounded telemetry emit, carrying the design's shared fields (model, integration, phase, steps asked, entries offered, artifact count, state bytes, timeout, endpoint host) and the response-only fields (outcome, duration, HTTP status, status class, redacted error class, choice/`noul` answer counts, and `tokens`/`cost` only when the provider reported usage). Verify with `agentic-coding/test/workflow-effects.test.ts`: a stubbed 200 response produces one request and one response row with the shared fields, a reported usage block produces numeric `tokens`/`cost`, and a response without usage produces neither field.
- [x] 2.2 Cover the failure paths in `agentic-coding/test/workflow-effects.test.ts`: a non-2xx status, a transport error, and a timeout each export exactly one `routing.response` with an `error` outcome, the correct status class (`4xx` / `5xx` / `transport`), and no label, confidence, or answer fields.
- [x] 2.3 Make the routing emissions observational in `agentic-coding/test/workflow-effects.test.ts`: a telemetry emit that throws or fails to write SHALL leave the classifier call result, the returned answers, and the workflow outcome unchanged and SHALL NOT add an attention entry naming telemetry.

## 3. Decision record on the engine layer

- [x] 3.1 Refactor `applyPoolRouting` in `agentic-coding/src/workflow/runtime/reducers/effect-result.ts` to return the decision summary from task 1.1, attach it to the committed `effect.result` event data for `model.classify`, and have `buildDispatchTelemetry` in `agentic-coding/src/workflow/runtime/engine.ts` pick it up the way it already picks up `rollupPayload`; emit `routing.classified` immediately after the `effect.result` row with the design's per-step keys (`herdr.routing.<stepId>.label`, `.confidence`, `.fallback`, `.profile` / `.profiles` / `.selected.count`) and pass totals. Verify with `agentic-coding/test/workflow-telemetry-engine.test.ts`: a real dispatch flow that completes a `model.classify` effect writes an `effect.result` row and one `routing.classified` row whose payload reports the applied profile per asked step and the phase.
- [x] 3.2 Verify the fallback and failure cases in `agentic-coding/test/workflow-telemetry-engine.test.ts`: a pass whose answer is below the confidence floor emits `routing.classified` with `fallback: true`, the tagged default label, and a fallback count of at least one; a `model.classify` effect that fails or retries emits no `routing.classified` row for that attempt.
- [x] 3.3 Assert correlation and bounds in `agentic-coding/test/workflow-telemetry-engine.test.ts`: the `routing.request`, `routing.response`, and `routing.classified` rows of one pass share the effect id and resolve to the one `workflowTraceId(workflowId)` trace id, and no exported routing value exceeds `TELEMETRY_ATTRIBUTE_LIMIT` or contains a credential-shaped string (a test whose label/error class embeds an `sk-…` value must see it redacted).

## 4. Trace-tree grouping

- [x] 4.1 Map the `routing` family to the category label `classifier routing` in `CATEGORY_BY_FAMILY` in `agentic-coding/src/tui/otel/model/traceStore.ts` and extend `agentic-coding/test/otel/traceTreeGrouping.test.ts` with a case asserting `routing.classified`, `routing.request`, and `routing.response` group under that one category node while an unmapped family keeps its own name.

## 5. Documentation and repository checks

- [x] 5.1 Document the two new event families, their payload keys, the usage fields' conditional presence, and the permanent exclusion of task, artifact, criteria, and answer content in `agentic-coding/docs/agent-session-telemetry.md`, and verify the documented key names match the emitted payload keys in `agentic-coding/src/workflow/runtime/engine.ts` and `agentic-coding/src/workflow/effect-runner.ts`.
- [x] 5.2 Run `bun run lint`, `bun run type-check`, and `bun run build` in `agentic-coding/` with zero diagnostics, and confirm `src/workflow/embedded.generated.ts` is only the output of that build and is not hand-edited.
- [x] 5.3 Run the change's focused suites: `bun test test/workflow-classifiers.test.ts test/workflow-telemetry-engine.test.ts test/workflow-effects.test.ts test/otel/traceTreeGrouping.test.ts` in `agentic-coding/`.
