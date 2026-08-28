## Context

This change consolidates three independent fusion planner drafts, then revises that consolidation against the **published Open Knowledge Format v0.2 specification** (`github.com/GoogleCloudPlatform/open-knowledge-format`; the format was announced in the Google Cloud blog post the developer supplied, and the specification moved out of `GoogleCloudPlatform/knowledge-catalog/okf` into its own repository).

All three drafts converged on the same shape — a centralized Markdown-plus-frontmatter store, a dependency-free helper module, a CLI surface, a `HERDR_ROLE`-based advisory write gate — and all three explicitly flagged that they could not verify any OKF specification from the repository alone. The first consolidation therefore invented an OKF-*shaped* format. That guess is now replaced by the actual specification, which contradicted it on most points and answers several questions the drafts had to leave open.

Current state of the repository the design must fit:

- `agentic-coding/src/workflow/paths.ts` resolves user paths env-override-first and anchors the tool's config at `~/.config/agentic-coding/config.toml`.
- `agentic-coding/src/workflow/effects.ts` is the single seam for config and filesystem I/O, exposes `WorkflowConfig` + `DEFAULT_CONFIG`, and deep-merges TOML.
- `agentic-coding/src/workflow/cli.ts` dispatches a fixed `SUBCOMMANDS` list with a table-driven `REQUIRED_FLAGS` map and a nested-subcommand precedent (`agent-extension` / `AGENT_EXTENSION_SUBCOMMANDS`).
- `agentic-coding/src/workflow/definitions.ts` maps steps to instruction assets in `INSTRUCTION_BY_STEP` and pins each by sha256 from `embedded.generated.ts`; `assets.ts` serves the on-disk copies. Editing an instruction without regenerating the bundle makes every agent launch fail on a pin mismatch.
- `AssignmentEnvironment` in `contracts.ts` is a `Record` over a **closed union of required key names**, so no new environment variable can be added conditionally without a contract change.
- `Bun.YAML.parse` / `Bun.YAML.stringify` exist in the installed runtime and parse conformant OKF frontmatter (nested inline maps, lists of maps) correctly, with no npm dependency.

## Goals / Non-Goals

**Goals:**

- One knowledge bundle shared by every project and every workflow on the machine, living outside all repositories.
- **Conformance with OKF v0.2 §11**, so the bundle is consumable by any OKF tool (for example the reference static visualizer) and this repository's agents are interchangeable OKF producers and consumers.
- Planning roles can find and read prior knowledge cheaply, and can tell verified knowledge from speculative knowledge before relying on it.
- Speculative knowledge is capturable at the moment the planner notices the gap, without polluting the verified corpus.
- The `core.archive` role promotes what actually shipped and records history.
- Zero new npm dependencies, zero workflow-engine/contract/adapter changes, and no wiki exposure for worker, triage, or verification roles.

**Non-Goals:**

- Security-grade isolation of wiki writes. The gate is a guardrail against accidental writes, not an authorization boundary.
- OKF Attested Computations (§10). Nothing in this repository computes attested numeric values; `runtime`/`parameters`/`executor`/`attester` are out of scope.
- Automatic `index.md` generation throughout the tree, backup, or multi-machine sync.
- A TUI or dashboard surface for browsing or editing concepts.
- Repository-scoped partitioning of the bundle.

## Decisions

Decisions D1–D3 and D10 are carried forward from the first consolidation unchanged. D4–D9 are revised or reversed against the specification; each records what the earlier consolidation said and why the specification overrides it.

### D1. Store location: `~/.config/agentic-coding/wiki`, overridable

Precedence: `HERDR_WIKI_DIR` → config `[wiki] root` (tilde-expanded) → `~/.config/agentic-coding/wiki`. Mirrors the existing `CONFIG` precedence in `paths.ts` and keeps the bundle next to the config the tool already owns.

*Rejected:* `~/.local/share/agentic-coding/wiki` (one draft). That directory already holds regenerable materialized assets; the bundle is durable user content.

### D2. CLI surface: `agentic-coding workflow wiki <subcommand>`

Follows the existing `agent-extension` nested-subcommand precedent, inherits `SUBCOMMANDS` validation and the table-driven CLI tests, and needs no change to the top-level surface dispatcher.

*Rejected:* a new top-level `agentic-coding wiki` surface (one draft) — a second dispatch point and usage text for no functional gain.

### D3. Module placement: `agentic-coding/src/workflow/wiki.ts`

One module holding all bundle filesystem logic, with no CLI or role concerns inside it, so it is directly unit-testable. Role gating lives in `cli.ts` next to every other flag check.

*Rejected:* a new `src/wiki/` tree split across `store.ts` + `cli.ts` (one draft) — premature structure for one module's worth of code.

### D4. Bundle layout is OKF v0.2 §3; no manifest file

The bundle root contains an `index.md` whose frontmatter carries `okf_version: "0.2"` — per §12 the only place OKF permits frontmatter in an index file — and concept documents in a directory tree beneath it. Concept ID is the file path minus `.md` (§2). `index.md` and `log.md` are reserved (§3.1) and MUST NOT be used as concept documents.

*Reversed from the first consolidation,* which specified a flat `entries/<id>.md` layout with an `id` frontmatter field and an `okf.json` manifest. **No such manifest exists in OKF**; it was invented. The `id` field is redundant because §2 defines the concept ID as the path, and a flat layout forfeits the hierarchy §3 is built around.

### D5. Reads are permissive, writes are disciplined

This is the central conformance decision. OKF §11 constrains *consumers* hard and *producers* barely at all, so the two directions get different rules:

- **Consumer side (`list`, `search`, `show`, and any read before a write).** A concept is rejected only when its frontmatter is unparseable or its `type` is absent or empty — exactly §11's two conditions. Per §11 the reader MUST NOT reject for missing optional fields, unknown `type` values, unknown extra frontmatter keys, broken cross-links, or missing `index.md`. Unknown keys are preserved on round-trip (§4.1).
- **Producer side (`write`, `verify`).** The CLI requires `type`, `title`, and `description` and validates `status`, timestamps, actor strings, and `sources` entry shape against §5, because a producer SHOULD emit good documents even though a consumer MUST accept poor ones.

*Reversed from the first consolidation,* whose validator required eight frontmatter fields plus a `## Summary` body section, enforced a closed `type` enum of `concept|component|decision|convention|pitfall`, and threw on any frontmatter outside a flat subset. All three of those **violate MUST-level consumer rules in §11** (missing optional fields, unknown `type` values, unknown additional keys), and §4.2 states plainly that there are no required body sections.

### D6. Frontmatter: `Bun.YAML` for parsing, a block-style renderer for writing

Conformant OKF frontmatter contains nested inline maps and lists of maps in its *recommended* fields (`generated: { by, at }`, `sources: - id: … resource: …`, `verified: [{ by, at }]`). `Bun.YAML.parse` handles all of it with no dependency.

Rendering is asymmetric and deliberately not `Bun.YAML.stringify`: that emits flow style (`{type: X,title: Y,tags: [a,b]}`) on one line. It is valid YAML and round-trips, but it destroys line-level diffs — and "diffable in version control" is one of OKF's four stated design properties (§1). Writes therefore go through a small block-style renderer covering exactly the shapes this producer emits: scalars, string lists, inline `{ by, at }` maps, and the `sources` list of maps. Unknown keys read from an existing document are re-emitted rather than dropped.

*Reversed from the first consolidation,* which specified a hand-rolled flat-subset parser that threw on anything else. That parser **cannot read a conformant OKF bundle** written by any other producer, which defeats the entire point of adopting a portable format.

### D7. Two-phase trust model: sequential planning roles draft, archive verifies

This answers the requester's explicit open question — *"I am not sure if the archive agent is the correct agent to write or if this should be done by the planner as well, as the planner is the one with the most context knowledge"* — and it **reverses the first consolidation's answer**, which was archive-only writes.

OKF §5.2 separates `generated` (who wrote the content) from `verified` (who confirmed it), explicitly "because who *wrote* a concept need not be who *confirmed* it", and §5.3 derives trust tiers from that: no `verified` key ⇒ **unverified**; non-`human:` verifier ⇒ **machine-confirmed**; `human:<id>` verifier ⇒ **human-reviewed**. §5.4 adds `status: draft | stable | deprecated`.

The first consolidation rejected planner writes on the grounds that speculative knowledge would be indistinguishable from verified knowledge and would poison planning everywhere. **The specification makes exactly that distinction first-class**, so the rationale no longer holds. The revised model:

| Role | Wiki access | Frontmatter written | Trust tier (§5.3) |
|---|---|---|---|
| `fusion.plan` planners (parallel) | read only | — | — |
| `core.plan` planner (sequential) | read + draft write | `status: draft`, `generated: { by: herdr-planner/<profile>, at }` | unverified |
| `fusion.consolidate` consolidator (sequential) | read + draft write | `status: draft`, `generated: { by: herdr-consolidator/<profile>, at }` | unverified |
| `core.archive` | read + write + verify + log | `status: stable`, appends `verified: { by: process:herdr-archive, at }` | machine-confirmed |
| worker, triage, verifiers | none | — | — |

The parallel `fusion.plan` planners remain read-only, which preserves the one argument for archive-only writes that the specification does *not* dissolve: N planners run simultaneously under an explicit no-coordination rule, so concurrent writes to one shared path race by construction. They surface gaps in their draft `risks`/`questions`, and the consolidator — which reads every draft and runs sequentially — is the role that turns those gaps into draft concepts. `core.plan` runs a single sequential planner, so the race argument never applied to it; one draft raised precisely this asymmetry.

`verified.by` is `process:herdr-archive` and not `human:<id>` because the workflow's confirmation is a process outcome (implementation, verifiers, and the developer plan gate all passed), which §5.3 correctly classifies as machine-confirmed rather than human-reviewed. Recording the reviewing developer as `human:<id>` would be a more valuable signal but the developer identity is not available in the run environment; it is left as an open question.

*Rejected:* archive-only writes (all three drafts, and the first consolidation). Its correctness argument is answered by `status: draft` plus the unverified tier, and it discards the requester's own observation that the planner holds the most context.

*Rejected:* letting the parallel fusion planners write too. It would trade a documented, spec-supported safety property for a write race with no reconciliation story.

### D8. Lifecycle fields carry the staleness and curation story

Concepts carry `status` (§5.4; absent ⇒ `stable`) and MAY carry `stale_after` (§5.5; stale when `now >= stale_after`). Read results surface status, trust tier, and staleness so a planner can weight a hit instead of trusting it flatly. Archive marks a superseded concept `status: deprecated` rather than deleting it, since §5.4 keeps deprecated concepts "for links and history".

*New in this revision.* The first consolidation had no lifecycle mechanism and listed curation as an unanswered open question; §5.4 and §5.5 answer it natively.

### D9. `log.md` is the archive's changelog; `list` synthesizes the index

`log.md` (§9) is a reserved chronological history, newest first, under ISO `YYYY-MM-DD` date headings. The archive role appends one entry per landed change, which directly satisfies the requester's "the archive agent should update the wiki with relevant changes".

No `index.md` is generated or maintained below the bundle root, and none is refreshed on write. §8 permits a consumer to "synthesize one on the fly when none is present", so `wiki list` is that synthesis: a bounded scan producing the directory listing at read time. Search is likewise a ranked linear scan (title 4, tags 3, headings 2, body 1).

*Rejected:* a derived `index.json` refreshed on every write (one draft), and by extension auto-regenerated `index.md` files. A derived index is a second source of truth that desynchronizes the moment a concept is hand-edited, and it forces every write to rewrite a global file — which then demands a lock (see D11). Synthesizing at read time has neither problem.

### D10. No engine plumbing: no assignment env var, no permission text change, no new step requirement

The wiki CLI resolves its own root from env and config, so nothing needs injecting into a run.

*Rejected A:* exporting `HERDR_WIKI_DIR` into the assignment environment (one draft). `AssignmentEnvironment` is a `Record` over a closed union where every key is required, so a conditional key does not type-check; making it work means changing the assignment contract for a value the CLI already resolves.

*Rejected B:* annotating per-role wiki access in the rendered assignment permissions (one draft) — restates what the instructions already say, for every run.

*Rejected C:* adding the `shell` capability requirement to the planning steps (one draft). Those steps already run shell commands (`openspec new change`, `openspec status`) under today's requirements, so the wiki introduces no new capability need; tightening it would newly reject custom profiles that omit `shell`.

### D11. Atomic per-concept rename, no lock

`write` and `verify` validate, write a temp file in the target directory, then `rename` it into place. With no derived index (D9), there is no cross-file invariant, so the worst concurrent outcome is last-write-wins on one concept — never a corrupted bundle.

*Rejected:* an exclusive single-writer lock (one draft). It protects an invariant D9 removed and adds a stale-lock failure mode that blocks all future writes after a killed run.

### D12. Role gate on `HERDR_ROLE`; reads ungated

`write` proceeds when `HERDR_ROLE` is unset (human administration) or is `planner`, `consolidator`, or `archive`; non-archive roles have `status` forced to `draft` and cannot set `verified`. `verify` and `log` proceed only when `HERDR_ROLE` is unset or `archive`. Reads are ungated, matching how `status` and `config` are ungated today; worker, triage, and verification roles simply never receive wiki instructions.

Separately and unconditionally, **the CLI refuses to write a `human:` actor whenever `HERDR_ROLE` is set at all** — see D17. The human-reviewed tier is engine-written only.

*Rejected:* enforcing read denial for worker/verifier roles (one draft). The requirement is that those roles do not *need* the wiki, not that reading must be prevented.

### D13. Edit the four existing instructions; no new pinned asset

Wiki guidance is added inline to `planning.md`, `planning-fusion.md`, `fusion-consolidation.md`, and `archive.md`. Each addition must also relax the neighbouring scope prohibition it would otherwise contradict (`planning.md`'s "do not explore", `planning-fusion.md`'s "read only the files the change touches", `archive.md`'s "do not explore … beyond the change directory") by stating that wiki access is an explicit exemption.

*Rejected A:* a separate `instructions/wiki.md` registered for four steps (one draft) — requires an `INSTRUCTION_BY_STEP` change and adds more total prompt bytes than inline paragraphs.

*Rejected B:* documenting the boundary in `workflow-agent-protocol.md` (one draft). That asset is pinned to **every** agent step, so it would push wiki text into the worker, triage, and verification prompts this change deliberately keeps clean.

### D14. The approval gate is a developer step between archive and delivery

A new developer step `core.wiki-approval` with outcomes `approve` and `comments` sits between `core.archive` and `core.delivery`:

```
core.archive --complete--> core.wiki-approval --approve--> core.delivery
                                  └--comments--> core.archive (loop, maxAttempts 6)
```

This placement satisfies the requirement that the gate run *before the archive agent is destroyed* without any new lifecycle machinery. Agent teardown happens through `workspace.close`, which is an allowed effect only of `core.completed` and `core.closed`, and `workspace.cleanup` only of `core.closed` — all strictly downstream of the new step. The archive agent therefore remains live while the gate is open, and the `comments` edge re-enters `core.archive`, where `paneForRunFactory`'s `resolveLiveAgent` reuse adopts the still-running agent instead of spawning a new one. This mirrors the existing `core.developer-review --comments--> core.implementation` loop exactly.

The edges live in the `archive` branch of `workflowEdges(...)`, which is shared by every manifest that has an archive step, so one edit covers `standard`, `direct-apply`, and `plan-fusion`. The step id is added to those three manifests' `steps` arrays between `core.archive` and `core.delivery`. The `no-openspec` manifest calls `workflowEdges(false, ...)` and has no archive step, so it gains no gate.

*Rejected:* running the gate after `core.delivery`. Delivery commits and pushes, so a gate behind it would review knowledge that has already shipped, and the archive agent would be gone.

*Rejected:* making the gate an agent step that asks the developer through chat. Gates in this engine are `developer` actor steps with declared outcomes, and the dashboard's action machinery keys off that; an agent-mediated gate would bypass the whole review UI.

### D15. Diff basis: snapshot-on-first-touch

The bundle lives outside every repository and is not version-controlled, so there is no `git diff` to render. Under D7 the planner also writes drafts long before archive runs, so the meaningful "before" is *the state before this workflow touched the bundle at all*, not the state before the archive step.

`writeConcept` and `verifyConcept` therefore snapshot on first touch: the first time any run in a change modifies concept `X`, the prior document (or a tombstone marking "did not exist") is copied to `.herdr-workflow/<changeId>/wiki-snapshot/<X>.md`. Subsequent writes to `X` in the same change do not overwrite the snapshot. This yields both the diff basis and the authoritative list of concepts the change touched, and it lives in the change directory whose lifecycle cleanup already owns.

*Rejected:* making the bundle a git repository and diffing with `git diff` (deferred Open Question 1). It is the better long-term answer, OKF §3 recommends it, and this gate is a second argument for adopting it — but it would put a commit on every planning run and make the wiki's correctness depend on git state inside a directory the engine does not own. The snapshot is self-contained and strictly smaller. Adopting git later does not invalidate the snapshot; it would just make it redundant.

*Rejected:* reconstructing the "before" from `sources` and `generated.at`. Provenance records where content came from, not what the document previously said.

### D16. Reuse the existing review UI rather than building a third one

The gate reuses the plan-review and developer-review machinery almost entirely; the only genuinely new UI is a concept list whose rows are backed by snapshot diffs.

| Need | Existing mechanism | Change |
|---|---|---|
| Comment payload | `core.review-comments@1`, validated in `runtime.ts` (bounded: 1–100 comments, each ≤4096 chars) | reuse unchanged |
| Comment persistence | `savePlanReview` / `loadPlanReviewComments` writing `reviews/plan-review.json` | clone to `reviews/wiki-review.json` |
| Gate action set | the `currentStep` branch in `runtime.ts` that serves `core.plan-approval` and `core.developer-review` | add a `core.wiki-approval` branch offering `approve-wiki` and `review-comments` |
| Modal trigger | `requiredUserActionFor` | add a trigger-only `wiki-review` action key |
| Concept list with change counts | `ChangedFilesBrowser.tsx` | reuse, sourced from the snapshot list |
| Line-anchored comments on markdown | `MarkdownViewModal.tsx`, already used for plan artifacts | reuse; concepts are markdown |

Because concepts are markdown, the developer-review *diff* modal and the plan-review *markdown* modal both apply. The gate uses a diff rendering of old-versus-new (the developer-review shape the requester asked for) with the plan-review comment anchoring, since both already exist.

### D17. The human-reviewed tier is written by the engine, never by an agent

Approving the gate promotes every concept in the change's snapshot list to `verified: { by: human:<id>, at }`, which OKF §5.3 classifies as **human-reviewed**, the top trust tier.

That promotion runs as a new `wiki.verify` effect on the `core.wiki-approval --approve-->` edge, executed by the engine's effect runner — *not* by the archive agent. The reason is load-bearing rather than stylistic: if an agent could write a `human:` actor, the human-reviewed tier would be self-assertable and would signal nothing. Making it an engine effect on a developer-gated edge means the tier is only reachable through an actual human action in the dashboard. D12 is tightened to match: the CLI refuses a `human:` actor from any invocation with `HERDR_ROLE` set.

Reviewer identity resolves as config `[wiki] reviewer` → `git config user.email` → the literal `human:developer`. `git config user.email` is already present in every repository the engine operates on and already identifies the person running the review.

This resolves the previous revision's Open Question 2, which observed that nothing could ever reach the top tier because no developer identity was available.

*Rejected:* having the archive agent write the human verification after the gate approves. It would make the top tier forgeable by any agent with shell access and would reintroduce the trust problem the tier exists to solve.

*Rejected:* a distinct `okf` trust level for workflow-gated approval. §5.3 derives tiers solely from whether a `human:` actor appears in `verified`; inventing a fourth tier would make the bundle non-portable to other OKF consumers.

### D18. Scope: the gate ships with the wiki rather than as a follow-up

Splitting the gate into a dependent second change was considered and is viable — the wiki is independently useful at the machine-confirmed tier, and the gate is meaningless without the wiki. The developer directed that it land together. The trust model argues the same way: without the gate, `verified` never carries a `human:` actor, so the human-reviewed tier specified in §5.3 is dead code and the store's top trust signal is unreachable.

The cost is recorded honestly under Risks: this is a materially larger change, and the gate is the natural cut line if it needs to be split later.

## Risks / Trade-offs

- **Instruction pin mismatch** → Editing any instruction without regenerating `embedded.generated.ts` makes *every* agent launch fail. Regeneration (`bun run build`) is a mandatory task, and an assets test asserts each changed instruction's embedded digest matches its on-disk file.
- **In-flight workflows stall after upgrade** → Changed instruction digests change step definition digests; workflows mid-run may need `agentic-coding workflow repin`. Documented in the README.
- **Bun version floor** → `Bun.YAML` replaces the dependency-free flat parser but is a newer runtime API. Verified on Bun 1.4.0; `package.json` pins `packageManager: bun@1.3.14`. The floor must be confirmed and the pin raised if needed, otherwise the build breaks on the pinned toolchain.
- **The write gate is policy, not security** → Any process can set `HERDR_ROLE=archive`. Accepted deliberately (D12, Non-Goals).
- **Drafts can accumulate unpromoted** → A plan that is rejected or abandoned after its planner wrote drafts leaves `status: draft` concepts that no archive run will ever promote. Mitigated by the trust tier being visible in every read result and by instructing planners to treat drafts as advisory; not otherwise reaped in this change. This is the cost of the D7 reversal and is the risk the archive-only model did not have.
- **The gate blocks delivery on a human** → `core.wiki-approval` sits on the path to `core.delivery`, so an unattended workflow now stops before shipping where it previously ran to completion. This is the intended semantics of a gate and matches `core.plan-approval` and `core.developer-review`, but it does change unattended behavior for every archive-bearing manifest.
- **The archive agent must survive the gate** → The design depends on no `workspace.close` or `agent.stop` firing between `core.archive` completing and the gate resolving. That holds today because those effects belong to `core.completed` and `core.closed`, but it is an invariant a future step reordering could silently break. Covered by a focused routing test asserting the gate precedes any step allowing `workspace.close`.
- **Comment loops can thrash the archive step** → The `comments` edge re-enters `core.archive`, which already has `retryLimit: 3` for its own failures; the loop carries its own `maxAttempts: 6`. A developer who keeps commenting past that bound stalls the workflow rather than looping forever.
- **Snapshot lives in the worktree** → `.herdr-workflow/<changeId>/wiki-snapshot/` is removed with the worktree on cleanup. That is after the gate in every manifest, so the diff basis is always present when the gate runs; but a workflow repaired or resumed after cleanup loses the ability to re-render the diff. The concepts themselves are unaffected — only the review view degrades.
- **Reviewer identity may be absent or wrong** → `git config user.email` can be unset or a shared CI identity, in which case the top tier records a meaningless actor. Mitigated by the `[wiki] reviewer` config key taking precedence and a `human:developer` fallback that is at least honest about being unspecific.
- **Last-write-wins across concurrent writers** → Two sequential-planning workflows, or two archive runs, touching the same concept lose one update silently. Bounded to "never corrupt" by atomic rename (D11). OKF §3 recommends distributing a bundle as a git repository "since it provides history, attribution, and diffs", which would make a collision recoverable; adopting that is deferred (Open Question 2).
- **A wrong or stale concept steers planning everywhere** → Now materially mitigated rather than hand-waved: `status`, `stale_after`, `verified`, and `sources` are all first-class, surfaced in read results, and weighted by the planner instructions. Nothing automatically re-verifies a concept whose `stale_after` has passed.
- **Unbounded growth degrades search and reading cost** → No dedupe or size cap. Mitigated by instructing writers to update an existing concept in place rather than creating a near-duplicate, by `status: deprecated` keeping superseded material out of the way, and by ranked search with a limit.
- **Prompt size** → Four instructions grow, and assignment rendering hard-fails above `MAX_ASSIGNMENT_BYTES`. Mitigated by keeping each addition to a short paragraph and never embedding concept content in an instruction.
- **The block-style renderer is narrower than the parser** → It covers the shapes this producer emits; an unknown key read from a foreign producer whose value is a deeply nested structure may be re-emitted less faithfully than it was read. Mitigated by a round-trip test over a foreign-producer document including unknown keys; full fidelity would need a general YAML emitter.
- **Wiki root may be unwritable in a managed pane** → A wiki failure must never block a run. Failed reads are reported in the run summary and planning continues; a failed archive write is reported in the archive evidence with the exact error, after `openspec archive` has already succeeded.
- **`WorkflowConfig` gains a section** → `agentic-coding workflow config` output changes shape; the field is optional in the type so existing fixtures still type-check.
- **Change size** → Folding the gate in (D18) makes this a substantially larger change: a workflow step, an engine effect, a snapshot mechanism, and a modal pair on top of the bundle module, CLI, and instructions. The gate is a clean cut line if it needs to be split into a dependent follow-up.

## Open Questions

The first consolidation's Open Question 1 — which OKF revision is authoritative — is **resolved**: OKF v0.2, specification at `github.com/GoogleCloudPlatform/open-knowledge-format`. Question 4 (curation lifecycle) is resolved by §5.4/§5.5 and D8. The previous revision's Question 2 (recording the reviewing developer as `human:<id>`) is **resolved** by the approval gate and D17. The remainder:

1. **Should the bundle be a git repository with an auto-commit per write?** OKF §3 recommends git distribution for history, attribution, and diffs, and it is the natural mitigation for last-write-wins now that more roles can write. The approval gate strengthens the case, since git would supply the diff basis that D15 currently snapshots by hand. Deferred here to avoid a commit on every planning run; the bundle is a plain directory the developer can `git init` at any time, and `log.md` provides an in-bundle audit trail meanwhile.
2. **Should concepts carry a project or repository scope?** The bundle is centralized by explicit requirement, but much knowledge is repo-specific. This design uses `tags` by convention; OKF has no scope field, and a producer-defined extension key (§4.1 permits any additional key) would be the conformant way to add one.
3. **Should the implementation worker get read-only access?** The requirement excludes it and this change honours that. Workers hit the same conventions the wiki documents, so it may be worth revisiting once concepts exist.
4. **Should `type` values be constrained by convention?** §4.1 leaves the taxonomy to the producer and forbids consumers from rejecting unknown types. This change lets writers choose freely; if planning-time filtering by `type` becomes valuable, a documented (but still non-rejecting) house vocabulary would help.
5. **Should approving the gate also re-verify concepts the change did not touch?** Approval promotes only the snapshot list. A concept last verified long ago stays at its old tier until some change touches it again, so trust ages silently rather than expiring. `stale_after` is the intended lever, but nothing sets it automatically.
