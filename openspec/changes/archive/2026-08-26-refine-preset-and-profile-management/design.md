## Context

See proposal.md for motivation and the delta specs for behavior. The shipped `pi/herdr-workflow.toml` currently contains model-pinned profiles, a required global `default_profile`, route defaults, and example presets. `parseAgentsConfig` and routing assume that default and profile map exist; the dashboard also creates a global default while saving the first profile. The new-workflow modal distinguishes configuration defaults from named presets, and the model-configuration modal reads and rewrites the effective agents TOML source.

## Goals / Non-Goals

**Goals:**
- Make a fresh installation start agents through a configurable harness without a model override.
- Keep custom profile/preset routing available without requiring any custom entry.
- Make dashboard writes target the effective config source consistently on Linux and make failures actionable.
- Preserve the model-less routing choice in the workflow's pinned routing snapshot.

**Non-Goals:**
- Choose, validate, or install a model for Pi when no model is configured.
- Migrate or delete user-authored profiles and presets automatically.
- Add a second configuration format or a platform-specific persistence backend.

## Decisions

### Represent `use-default-model` as a configurable built-in routing fallback

*Resolves plan-review comment: users can choose the harness for `use-default-model` in configuration.*

Use a reserved preset configuration with a `runtime` field, defaulting to `pi` in the shipped `use-default-model` preset. Validate it against the supported harnesses (`pi`, `opencode`, and `opencode-v2`) and resolve it to a virtual `ResolvedProfile` with no `model` field. It is not written into `[agents.profiles]`, so a fresh configuration has no model-specific entries yet the selected adapter receives a normal runtime profile. Routing will use this fallback after custom preset, role, step, and configured-route lookups, and will pin its selected runtime and model-less resolved data with the workflow.

This is smaller and more reliable than shipping a physical profile just to satisfy the existing required-default schema. A physical default profile would retain the default-profile list the change removes and could be accidentally edited or deleted.

### Make custom agent configuration optional

Change parsing/types and routing validation so `default_profile` and `profiles` are optional. Validate custom profile references only when present; retain valid user-authored profiles, routes, and presets for compatibility, but stop requiring or generating a global default profile. Replace the shipped agent catalog with only `[agents.presets.use-default-model]` and its default `runtime = "pi"`; remove shipped profiles, routes, role routes, definition defaults, and model-specific presets.

The alternative of a one-time destructive migration was rejected because configuration is user-owned and can be committed per repository.

### Keep the built-in choice separate in the dashboard

Expose `use-default-model` in workflow creation even when the custom preset list is empty. The model-configuration modal will identify the built-in entry as non-custom: it cannot be edited or deleted, and its profile list contains only saved custom profiles. Its harness is configured directly in TOML, not by creating a profile. Creating the first custom profile or preset only writes that entry; it must not add `agents.default_profile`.

The existing configuration-default sentinel can remain an equivalent shortcut when no custom routing is selected, avoiding an unnecessary workflow input format change.

### Diagnose and harden configuration write-back at the I/O boundary

Exercise create/edit/delete with Linux-style canonical, legacy, project-overlay, environment-selected, and symlinked config paths. Consolidate target resolution and read-modify-write behavior behind the existing configuration effects seam, preserving unrelated TOML sections. Surface malformed TOML, inaccessible paths, conflicting layered `[agents]` sources, and write failures through dashboard notifications; do not report success or mutate in-memory lists until a write succeeds.

The implementation will correct the observed Linux failure at this shared boundary rather than adding modal-specific platform branches. If two loaded layers define `[agents]`, retain the current safety principle of refusing destructive edits until the conflict is resolved, while reporting the exact files involved.

## Risks / Trade-offs

- [Existing automation expects `agents.default_profile`] → Continue accepting legacy user configuration during parsing, while new templates and dashboard saves omit it; cover both legacy and empty configurations.
- [A reserved name collides with a user preset/profile] → Reserve `use-default-model` and reject or clearly prevent conflicting custom management operations.
- [A model-less harness invocation differs by runtime] → Pass no model argument and cover Pi, OpenCode, and OpenCode V2 adapter launch arguments with focused tests; default-model selection remains the selected harness's responsibility.
- [Layered config can resurrect deleted entries] → Detect conflicting agents sources before destructive writes and name the sources in the error.

## Migration Plan

1. Replace only the shipped configuration defaults; leave existing user and repository configuration intact.
2. Deploy parser/routing support for empty configuration and legacy default profiles together so existing workflows can still start.
3. Add Linux-path regression coverage for dashboard persistence, configured harness selection, and model-less launch routing before release.
4. Roll back by restoring the prior shipped template; existing user configuration is not transformed and pinned running workflows retain their resolved routing.
