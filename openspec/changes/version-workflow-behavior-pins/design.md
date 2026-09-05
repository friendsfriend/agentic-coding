## Context

Historical manifests are registered, but their step lists contain IDs only and runtime lookups default to version 1. `stepDigest()` deliberately excludes behavior and instruction content. Current requirements explicitly permit changing behavior without invalidating pins; this change replaces that blanket guarantee with an explicit compatibility contract.

## Goals / Non-Goals

**Goals:** compatible upgrades remain usable, incompatible semantics cannot silently reinterpret persisted state, and multiple step versions can coexist.

**Non-goals:** source-code hashing, automatic code downloads, retroactive reconstruction of historical behavior, or treating text/label changes as semantic upgrades.

## Decisions

### Explicit semantic identity

Give new manifests exact step references, retaining convenient stable step IDs for graph edges and UI identity. Resolve references through one definition-aware registry helper rather than propagating default-version lookups. A referenced step version declares its behavior compatibility version alongside its existing input/output contract versions; include those explicit values in new-definition digests.

Manual semantic versioning is deliberate: source hashes change under formatting/refactoring and do not establish compatibility. Document that changes to outcomes, guards, completion aggregation, context transfer, role selection, or effect declarations require a compatibility decision and tests. Correctness/security fixes may require an explicit migration rather than keeping unsafe behavior executable.

### Preserve historical digest formats

Do not add fields to historical manifest objects used to compute old digests. Map supported legacy step-ID-only manifests to an explicit baseline resolver outside their historical digest calculation. That mapping means compatibility with the supported baseline, not proof that every historical binary behaved identically. Unknown or incompatible mappings fail closed with an actionable compatibility diagnostic.

New definitions use the new pin format and version tier. Persist enough semantic identity to detect changes at dispatch, run creation, assignment rendering, routing, repair, and effect execution. A raw digest replacement through repin must not bypass semantic compatibility checks.

### Retention or explicit migration

If the old implementation remains safe, register it next to the new version and let old workflows continue using it. Otherwise require revision-bound migration that previews changed semantics and affected runs/effects, validates state/evidence, expires incompatible ownership, and atomically records old/new pins plus a reason. Failed migration leaves every pin and ownership record unchanged.

Presentation-only instruction changes remain outside semantic pins; assignment asset digests continue recording rendered instructions. Do not claim instruction content is reproducible across upgrades unless separately retained.

## Risks / Trade-offs

- Retaining all implementations forever becomes costly → retain supported compatibility baselines and explicitly block/migrate unsupported versions; never silently substitute current behavior.
- Partial lookup migration recreates default-version bugs → enumerate all registry.step callers and test version 1/version 2 coexistence end to end.
- Existing digest fixtures only cover metadata → supplement them with fixtures whose two behavior versions make visibly different completion decisions under identical graph structure.

## Migration Plan

First capture legacy definition digests and current transition behavior. Introduce the resolver and legacy mappings without changing behavior, then register new-definition versions with semantic pins. Ship explicit migration validation before accepting semantic upgrades. Stop mixed-version writers when activating a new pin format. Rollback requires a binary supporting the stored pins or a verified pre-migration backup; never rewrite pins to satisfy an old binary.
