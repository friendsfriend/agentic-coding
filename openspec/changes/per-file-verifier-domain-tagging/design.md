# Design

## Context

After `classifier-driven-triage-routing`, the per-round classifier request
already carries the changed-file manifest (paths always complete, diffs capped)
and already answers one question per eligible role. The remaining agent job is
per-file scoping. This draft records the follow-up shape only; it is not
implemented by the current workflow.

## Goals / Non-Goals

**Goals:**

- Derive every verifier's file scope from the same bounded request that selects
  the roles, so a round costs no triage agent run.
- Keep the engine's scope validation as strict as the agent-plan validation it
  replaces.

**Non-Goals:**

- Changing which roles are eligible or how they are selected.
- Changing what a verifier run asserts.
- Removing the compatibility mapping for workflows already running triage.

## Decisions

- Extend the existing request rather than adding a second one: role selection
  and per-file tags come from the same bounded state, so they stay consistent
  and cost nothing extra.
- Derive scope as "tags ∩ manifest ∩ selected roles" and drop a selected role
  with no surviving file, instead of validating an agent plan. A tag that names
  an unselected role or an unknown path is discarded and recorded rather than
  failing the round: the classifier is an untrusted input, and the selected set
  is the authority.
- Retire the triage step through a new definition version tier (as the routing
  step did) so in-flight workflows keep the step, role, asset, and tab they
  started with.
- Keep the role-selection floor and the eligible-role derivation unchanged so
  the two changes compose instead of competing.

## Risks / Trade-offs

- [Per-file tagging is coarser than an agent's scoping, so a role may be assigned
  a file it does not need] → mitigated by the drop-on-empty-scope rule, the
  existing per-file diff caps, and the per-role instruction assets that already
  tolerate a small scope.
- [Dropping a role when the classifier tagged nothing for it silently reduces
  coverage] → the drop is recorded on the round, not silent.
- [Removing a role, step, and tab is a breaking change for existing
  configurations] → the version tier keeps running workflows unchanged.

## Migration Plan

- Land after `classifier-driven-triage-routing`; new definitions drop triage,
  existing pins keep it until an operator migrates them.
