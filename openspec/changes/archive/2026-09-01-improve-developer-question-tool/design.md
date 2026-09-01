## Context

See `proposal.md` for the motivation and user-facing scope. The current implementation has one `DeveloperDialogueRecord` shape per request, a single-question `agent.question` command, a single-question `answer-question` action, and a dashboard modal whose custom path uses a single-line `<input>`. The new-workflow wizard already demonstrates the required OpenTUI textarea ownership and synchronization pattern in `src/tui/dash/ui/NewWorkflowModal.tsx`.

The change crosses the Pi extension, CLI bridge, workflow contracts/runtime, dashboard state, and generated embedded assets. Workflow snapshots and their validated views are the canonical source of dialogue, and existing authorization, revision checks, expiry, bounds, and FIFO queue behavior must remain intact. The reference implementations suggest two concrete prompting improvements rather than only a richer widget. The [`rpiv-ask-user-question` README](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/README.md) and [extension source](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/ask-user-question.ts) expose a short prompt snippet plus a list of prompt guidelines: ask only on consequential ambiguity, gather context first, author 2–4 meaningful options with descriptions/trade-offs, put the recommended choice first, always explain the custom-answer row, and group related questions instead of issuing back-to-back calls. Its tool description also documents the questionnaire result and explicitly says not to use the tool as chat. [`edlsh/pi-ask-user`'s README](https://github.com/edlsh/pi-ask-user/blob/main/README.md) and [registration source](https://github.com/edlsh/pi-ask-user/blob/main/index.ts) similarly register a focused tool description, `promptSnippet`, and `promptGuidelines`; its schema adds a context summary, keeps option objects flat for provider compatibility, and documents when to use single versus multiple selection and freeform answers. Its README also highlights bounded context collapse and a submit/review step for multi-question flows. We will adopt the applicable guidance and context/result conventions in this repository's existing tool contract, without importing either project or adding a dependency.

## Goals / Non-Goals

**Goals:**

- Add a backwards-compatible questionnaire request with ordered related items and one structured response envelope.
- Keep grouped creation, answer submission, expiry, cancellation, bounds, and dialogue updates atomic at the workflow boundary.
- Give the dashboard a clear tabbed questionnaire flow while retaining the existing one-at-a-time display for independently queued requests.
- Make custom responses true multiline editor content, preserving newlines and structured text exactly from editor to workflow result.
- Improve schema descriptions and call rendering so agents receive actionable advice about when and how to ask.
- Preserve the current authenticated run capability and workflow revision protections.

**Non-Goals:**

- Do not turn the tool into free-form chat, add general conversation history, or allow agents to ask unauthenticated developers directly.
- Do not support arbitrary nested questionnaires, conditional questions, branching tabs, or cross-workflow questionnaires.
- Do not change workflow lifecycle transitions when a question is created or answered.
- Do not add a third-party UI, state-management, or questionnaire dependency.
- Do not make independently queued questions a single batch; only explicitly grouped items from one tool call use questionnaire tabs.

## Decisions

### 1. Use a compatibility envelope with an explicit questionnaire branch

Keep the existing `description` and `options` parameters for legacy single-question calls. Add an optional `context` for a single question and an optional `questions` array whose items contain `description`, optional `context`, and `options`. The request validator SHALL reject ambiguous payloads that provide both the legacy description and a questionnaire, and SHALL enforce a small maximum item count plus the existing per-description, option, answer, and total-dialogue bounds.

This keeps current extension callers and CLI users working while giving the model a simple, flat schema for batching related decisions. A single normalized internal request shape can represent the legacy form as a one-item questionnaire for creation and waiting, while the external result keeps the legacy single-record result shape for legacy calls and uses an ordered response array for grouped calls.

**Alternatives considered:** replacing the old fields with `questions` would be cleaner but would break existing managed-agent prompts and callers; allowing arbitrary question objects or nested groups would make validation and UI state needlessly complex.

### 2. Persist grouped items as related canonical dialogue records

Add a generated questionnaire/group identity and stable item ordering metadata to the validated dialogue representation. A questionnaire creation dispatch SHALL validate the complete request and append all item records atomically, so an invalid item cannot leave a partial questionnaire. Each item carries the same requester workflow/run/step/role and expiry boundary, while the group identity lets the runtime, view, and dashboard distinguish it from independent FIFO questions.

Use the existing snapshot dialogue rather than a new database table. This preserves reload behavior, legacy snapshot compatibility, assignment rendering, content bounds, and telemetry metadata rules. The group is complete only when every item has a terminal answer; a cancellation or expiry of the group terminates its remaining pending items without manufacturing custom answers. Existing one-question records continue to have no group metadata (or an equivalent single-item normalized view).

**Alternatives considered:** a separate questionnaire table would add migration and synchronization risk for no user-visible benefit; storing one opaque JSON answer would lose per-tab status and make validated workflow views unable to expose individual decisions.

### 3. Submit grouped answers atomically, retain drafts locally

Add a validated grouped answer envelope containing the questionnaire identity and one response for each item, keyed by stable item identity and checked against the recorded option values. The dashboard keeps option selections and textarea drafts in local modal state while the developer navigates tabs, then submits the complete response set through one revision-checked developer action. The runtime commits all item answers in one state transition and returns the ordered structured result to the waiting CLI process.

This avoids partial workflow answers if a revision becomes stale, a modal closes, or one response is invalid. A legacy question continues to use the existing single-item action and result. Escape cancels the whole displayed request; it does not silently convert unanswered questionnaire items into empty answers.

**Alternatives considered:** committing each tab immediately would make refresh persistence more complicated and could leave an agent with a permanently half-answered request; allowing skipped items would undermine the tool's guarantee that the returned response set is complete.

### 4. Make the modal a controlled tabbed view with one editor owner

Refactor `DeveloperQuestionModal` to receive the current request, per-item draft state, active tab, and callbacks rather than owning workflow mutations. For a questionnaire, render a compact tab row with item number/short label and answered/unanswered state, the active item's description/context/options, and a final submit affordance. For a legacy question, retain the current option list presentation.

The custom path SHALL use OpenTUI `TextareaRenderable` in the same ownership pattern as the new-workflow task step: initialize from the active draft, mirror `plainText` on content changes, and let the focused textarea consume insertion, deletion, cursor movement, paste, and plain Enter. The modal key layer handles only navigation, cancellation, option selection, and the explicit advance/submit gesture; it must return unhandled editing events instead of replaying them. Alt+Enter advances or submits, matching the new-workflow editor convention.

Tab changes must save the active draft before switching and restore the next draft without replacing the textarea buffer on every keystroke. On accepted submission, close/advance only after the engine returns success; stale or expired responses refresh canonical state and discard only the invalid local draft.

**Alternatives considered:** rendering all questions vertically would consume too much terminal space and weaken focus; using one shared `<input>` would continue to reject structured answers; letting the global keymap edit text would reproduce the duplication/regression avoided by the existing wizard design.

### 5. Put authoring guidance in the extension schema and result presentation

Update the Pi extension's tool description and TypeBox descriptions to explain material ambiguity, concise decision framing, useful mutually distinguishable option labels/values, optional context gathered from prior evidence, related-only batching, bounds, multiline custom responses, and untrusted developer-provided results. Add a concise prompt snippet and prompt-guideline list to the registered tool when the installed ExtensionAPI supports those fields; the same rules SHALL remain in the main description and parameter descriptions so provider or host versions that omit prompt metadata still receive them. The guidance should tell agents to put a recommended option first when one is preferred, describe option trade-offs, avoid authoring reserved custom-answer labels, and not stack unrelated calls. Keep option objects flat and avoid schema unions that can be stripped by provider proxies. Add questionnaire-aware call rendering (item count and short summary) and result rendering that does not expose secrets or fabricate a flattened answer.

The CLI bridge will accept the normalized questionnaire input, dispatch it with the authenticated identity, wait on the group completion condition, and serialize the legacy or grouped result envelope. The extension remains a thin bridge and does not become a second source of questionnaire state.

**Alternatives considered:** putting long instructions only in workflow prompts would not help tool discovery or other Pi hosts; using only a long tool description would lose the stronger system-prompt placement demonstrated by both references; adding a new skill/dependency would duplicate the existing extension contract and make restricted profiles harder to reason about.

### 6. Regenerate embedded workflow assets through the existing build

The source extension and any source instruction/template changes remain authoritative. After implementation, run the repository's existing build path so `src/workflow/embedded.generated.ts` reflects the updated extension; it is excluded from hand formatting and must not be edited directly. Tests should exercise source behavior and verify the generated asset is refreshed by the build check.

## Risks / Trade-offs

- **[Risk]** A larger questionnaire result or multiline text can approach existing dialogue/content limits. → Reuse the existing per-field and aggregate bounds, add a questionnaire item-count bound, validate the full request before mutation, and return actionable bounded diagnostics.
- **[Risk]** A stale workflow revision could arrive after the user has prepared several tab answers. → Submit the group atomically with the current revision; on rejection refresh canonical pending state and leave no partial answers committed.
- **[Risk]** Switching tabs can lose textarea content if the OpenTUI buffer is recreated too eagerly. → Maintain one draft per stable item, mirror `plainText` through `onContentChange`, focus after mount/activation, and test switching away and back before submit.
- **[Risk]** Legacy pending records may not have group metadata. → Treat missing group metadata as a legacy single request in parsing and UI selection, and retain existing snapshot compatibility tests.
- **[Risk]** Rich question/context text may make small terminals unusable. → Keep the modal bounded, wrap/collapse context before the options/editor, show tab progress compactly, and preserve scroll behavior without hiding the active question or editor.
- **[Risk]** Better schema guidance can expose sensitive agent context through rendered calls or diagnostics. → Keep descriptions instructional but generic, avoid logging question/answer content, and preserve the existing metadata-only telemetry policy.

## Migration Plan

1. Implement and validate the expanded contracts, normalization, grouped runtime actions, CLI waiting/result handling, and dashboard behavior behind the existing `developer_question` name.
2. Add focused contract/runtime tests first, then renderer/key-routing tests for legacy and grouped flows, including multiline editor fidelity and stale/cancel/expiry paths.
3. Update the extension descriptions and regenerate embedded assets with `bun run build`; run the focused checks, type-check, and Biome validation required by the repository.
4. Deploy without snapshot migration: legacy snapshots parse with empty/missing questionnaire metadata, and new records use the expanded representation. Existing single-question agents continue unchanged.
5. Roll back by reverting the source/build change. The runtime must continue to parse prior snapshots; any in-flight grouped request will resolve through the bounded cancellation/expiry path rather than being interpreted as a legacy answer.
