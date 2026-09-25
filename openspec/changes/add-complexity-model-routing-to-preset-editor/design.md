# Design

## Context

The agents configuration already models plan-complexity routing: `PresetConfig` carries flat `easy`/`medium`/`hard`/`critical` profile references, `PRESET_CATEGORY_KEYS` in `agentic-coding/src/workflow/profiles.ts` is the fixed vocabulary the parser validates against, and the classifier path reads the mapping through `categoryProfile`. Only the Settings preset editor is missing the fields — and because `presetMutation` rebuilds the whole preset object, an edit-save cycle drops stored category mappings. See proposal.md for the motivation.

The editor is split into a pure domain module (`agentic-coding/src/tui/settings/agentPresets.ts`) and a presentational Solid surface (`AgentPresetsView.tsx`) that only owns focus and key dispatch. The shared `@ui` Form primitive offers `text`/`select` fields whose values are a flat `Record<string, string>`.

## Goals / Non-Goals

**Goals:**

- Make the four plan-complexity profile mappings editable from the preset form and survive every save.
- Keep one source of truth for the category vocabulary and one for profile references.
- Keep the change inside the TUI settings layer; no server, gateway, or workflow changes.

**Non-Goals:**

- Changing the runtime classification or routing behavior, the config format, or the parser's validation rules.
- Adding a runtime fallback for an unmapped category.
- Editing the built-in `use-default-model` preset (still runtime-only).

## Decisions

### Category fields derive from the workflow vocabulary

`presetFields` generates one select field per entry of `PRESET_CATEGORY_KEYS` imported from `src/workflow/profiles.ts`, labelled `Complexity <category>`. This mirrors the existing catalog-driven rule that the verification fields come from `VERIFIER_ROLES` rather than a UI-local list.

Alternative considered: derive from `complexityClassifier.categories`. Rejected because the preset editor edits the config shape, and the parser only routes categories that `PRESET_CATEGORY_KEYS` accepts; a classifier category outside that set cannot route until the config shape changes in the same code change.

### Flat draft record with a `complexity:` field key

`PresetDraft` gains `complexities: Record<string, string>` (sparse, keyed by category), and field keys use the `complexity:<category>` prefix, matching the existing `step:`/`fusionRole:`/`role:` prefixes. `presetDraft` loads stored keys, `draftValues` emits one form value per stored entry (the Form applies the empty default for the rest), `applyDraftValue` writes one entry, and `presetMutation` maps non-empty entries back to the preset's flat `easy`/`medium`/`hard`/`critical` keys.

Alternatives considered: four named draft fields (verbose, duplicates the vocabulary); a nested record inside `PresetConfig` (changes the config format, out of scope).

### Fields sit directly after the default profile

The form order becomes name → default profile → four complexity fields → step routes → fusion roles → verification roles. The complexity mapping is a preset-wide fallback like `defaultProfile`, so it belongs with it; the step/role fields that follow are per-step overrides. The form already scrolls with the focused field kept in view, so four more fields do not hide the existing ones. Each field is a choice over the saved profile names plus an unset option, so a typo cannot create a broken reference.

### No completeness rule; empty stays unset

Each category is independently optional and an empty value is not persisted. `validateDraft` keeps its name-only rules. A preset is shared across workflows that never classify complexity, so requiring all four (or all-four-when-any) would refuse valid configurations. No save-time warning is added either: the four fields are visible together in the form, and the partial-mapping failure mode is recorded under Risks for a possible follow-up. The developer confirmed the no-warning scope.

### Reference scan covers category mappings

`profileReferences` adds `presets.<name>.<category>` for every stored category mapping. Deleting or renaming a profile referenced only by a complexity mapping must be refused like any other reference, because `parseAgentsConfig` rejects a preset whose category names an unknown profile — a dangling reference would make the whole agents config unparseable, not just the preset. The existing rename/delete refusal paths need no new logic; they already consume `profileReferences`.

### Menu summary mentions complexity routing

The Presets menu detail becomes `step, role and complexity routing`. The list card keeps its step count so it does not imply a completeness that the editor deliberately allows.

## Risks / Trade-offs

- [A JEV workflow with a preset that leaves the classified category unmapped fails permanently at classification time] → Out of scope to add a runtime fallback; the editor now exposes all four fields so a user can complete the mapping. The risk is recorded for a possible future editor warning.
- [Unknown category keys from a future config shape are dropped on save] → Same behavior as any other unknown top-level preset key today; the config vocabulary and the editor ship together.
- [Four more form fields lengthen the preset form] → Placed together after the default profile; the Form scrolls and keeps the focused field visible.
- [The view test navigates fields by counting Tab presses] → Update the affected test and add a label-based assertion for the new fields so a reordering fails loudly instead of silently selecting the wrong field.

## Migration Plan

None. The persisted config format is unchanged, no state or schema migrates, and the change rolls back with the TUI code alone.

