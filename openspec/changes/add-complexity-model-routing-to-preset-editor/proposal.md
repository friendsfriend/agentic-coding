# Proposal

## Why

The `openspec-jev` workflow family classifies each plan's implementation complexity (`easy`, `medium`, `hard`, `critical`) and rewrites the `core.implementation` worker route to the profile the selected preset maps for that category. The configuration schema and routing already support those flat preset keys, but the Settings preset editor neither shows nor writes them. A user cannot map a complexity to a model profile from the TUI, and editing a preset that already contains category mappings silently drops them on save because the mutation rebuilds the preset without those keys — a dropped mapping makes the JEV workflow fail permanently when that category is classified.

## What Changes

- The Settings preset editor renders one `Complexity <category>` choice field per plan-complexity category (`easy`, `medium`, `hard`, `critical`), with options drawn from the saved profile names plus an empty "not set" choice.
- The preset draft, value mapping, and mutation round-trip preserve existing category mappings and persist newly chosen ones as the preset's flat category keys; empty choices stay unset.
- The profile reference scan includes preset category mappings, so deleting or renaming a profile referenced only by a complexity mapping is refused with the referencing entry, exactly like a step or role reference.
- The presets menu summary names complexity routing alongside step and role routing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-configuration-presets`: the Settings preset editor gains plan-complexity profile assignments (render, persist, preserve on edit, and reference-safe delete/rename), alongside the existing step, role, and fusion assignments.

## Impact

- `agentic-coding/src/tui/settings/agentPresets.ts` (draft, field catalog, mutation, reference scan) and `agentic-coding/src/tui/settings/AgentPresetsView.tsx` (menu summary).
- Focused tests: `agentic-coding/test/settings/agentPresets.test.ts` and `agentic-coding/test/app/agentPresetsView.test.tsx`.
- No server, gateway, or workflow changes: the agents config schema (`PresetConfig` flat category keys, `PRESET_CATEGORY_KEYS`) and the classifier routing path already consume these values.
