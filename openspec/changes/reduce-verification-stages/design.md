# Design

## Context

`classifier-driven-triage-routing` makes the domain verifier set a per-round
classifier decision and allows it to be empty, but the engine still always
auto-launches the full suite once the selected verifiers report. This change
draft records the follow-up shape only; it is not implemented by the current
workflow and it depends on that change landing first.

## Goals / Non-Goals

**Goals:**

- Let a round skip the complete suite on a recorded, auditable signal.
- Keep "run the suite" as the default whenever the signal is missing or unusable.
- Keep a skipped round inspectable and re-runnable by a developer.

**Non-Goals:**

- Removing the suite from any round without a recorded decision.
- Changing the per-round domain verifier selection.
- Changing what a verifier run asserts.

## Decisions

- Reuse the existing per-round routing step rather than adding another step: the
  reduction signal is one more bounded necessity question in the same request,
  so a round costs no extra classifier call.
- Record the decision as round state, not as a transient transition output, so
  the developer view and the round's evidence can show what ran and why.
- Default to running the suite on any unusable signal, consistent with the
  fail-open rule for the role-selection signal: under-coverage is worse than
  wasted work.
- Keep the developer override on the existing developer-action seam at the
  verification step instead of a new command surface.

## Risks / Trade-offs

- [A wrong "documentation-only" signal skips the suite for a behavioural change]
  → the signal is one question with the same 0.5 gate, the decision is recorded
  and visible, and a developer can request the suite for that round.
- [Round state grows] → the record is bounded (one decision plus its reason) and
  bounded by the existing round lifetime.

## Migration Plan

- Land after `classifier-driven-triage-routing`; the reduction decision defaults
  to "run the suite" so existing rounds behave unchanged until the signal is
  enabled.
