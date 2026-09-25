# Tasks

## 1. Preset domain: complexity fields

- [x] 1.1 In `agentic-coding/src/tui/settings/agentPresets.ts`, import `PRESET_CATEGORY_KEYS` from `../../workflow/profiles.ts`, add `complexities: Record<string, string>` to `PresetDraft`, add a `complexityKey(category)` field-key helper (`complexity:<category>`), and load the stored flat category keys into the draft in `presetDraft`. Verify: `bun test test/settings/agentPresets.test.ts` with a prefilled-draft case asserting stored `easy`/`critical` values land in `complexities`.
- [x] 1.2 In the same file, generate one `Complexity <category>` select field per `PRESET_CATEGORY_KEYS` entry directly after the default-profile field in `presetFields` (options are the saved profile names plus the empty "not set" choice), and handle the `complexity:` prefix in `draftValues` and `applyDraftValue`. Verify: a unit test asserts the four field labels and that `applyDraftValue` sets one category; `bun run type-check` passes.
- [x] 1.3 In `presetMutation`, write non-empty draft complexities back as the preset's flat `easy`/`medium`/`hard`/`critical` keys and drop empty ones. Verify: a unit test asserts a partial mapping produces only the non-empty flat keys, and a `presetDraft` → `presetMutation` round trip preserves a stored mapping.
- [x] 1.4 Extend `profileReferences` to report `presets.<name>.<category>` for every stored complexity mapping. Verify: a unit test asserts a profile referenced only by a complexity mapping is reported and the existing reference shapes still resolve.

## 2. Editor surface

- [x] 2.1 In `agentic-coding/src/tui/settings/AgentPresetsView.tsx`, update the Presets menu detail to `step, role and complexity routing`. Verify: the menu renders the updated summary text (focused view test or manual TUI check) and no other behavior changes.

## 3. Focused tests

- [x] 3.1 Extend `agentic-coding/test/app/agentPresetsView.test.tsx`: the preset form renders all four `Complexity <category>` labels with the saved profile choices. Verify: `bun test test/app/agentPresetsView.test.tsx`.
- [x] 3.2 Add a view test that creates a preset, assigns a profile to one complexity category through the real keymap, saves, and asserts the persisted config contains that flat category key. Update the existing "creates a preset with a step route" test's Tab count for the four inserted fields (six Tabs after the name field reach `Step core.plan`). Verify: same focused view suite passes.
- [x] 3.3 Add a view test that opens a stored preset containing complexity mappings, saves without changing them, and asserts the mappings survive; add a view test that a profile referenced only by a preset complexity mapping is refused on delete with the referencing entry named. Verify: same focused view suite passes.

## 4. Change checks

- [x] 4.1 From `agentic-coding/`, run `bun run type-check` and `bun run lint` (both clean) and the focused suites `bun test test/settings/agentPresets.test.ts test/app/agentPresetsView.test.tsx`. The workflow test verifier owns the complete repository suite; do not run it here.
