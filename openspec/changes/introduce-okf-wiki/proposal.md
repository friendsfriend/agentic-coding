## Why

Every workflow starts from zero: planners rediscover the same conventions, constraints, and past decisions on each change, and the knowledge produced by a finished change dies with its archived change directory. A single centralized knowledge store — consulted by planning roles and promoted to verified status by the archive role once a change is verified and landed — turns each completed workflow into durable context for the next one, across every project rather than per repository.

The store conforms to the **Open Knowledge Format (OKF) v0.2**, the published specification at `github.com/GoogleCloudPlatform/open-knowledge-format`, so the bundle is readable by any OKF consumer and writable by any OKF producer without a translation layer.

## What Changes

- Add a centralized, machine-wide **OKF bundle** stored outside any repository at `~/.config/agentic-coding/wiki`, overridable via `HERDR_WIKI_DIR` (highest precedence) or a new `[wiki] root` config key.
- Adopt the OKF v0.2 on-disk format verbatim: a directory tree of markdown concept documents with YAML frontmatter, where the concept ID is the file path minus `.md`; the reserved filenames `index.md` (§8) and `log.md` (§9); and `okf_version: "0.2"` declared in the bundle-root `index.md` frontmatter (§12), which is the only place OKF permits frontmatter in an index file.
- Use the OKF frontmatter families rather than invented fields: required `type` (§4.1); recommended `title`, `description`, `resource`, `tags`; provenance `sources` (§5.1); trust `generated` and `verified` (§5.2); lifecycle `status` and `stale_after` (§5.4, §5.5); and the actor convention `<producer>/<version>` / `human:<id>` / `process:<id>` (§7). Relationships are ordinary markdown links (§6), not a frontmatter field.
- Add a dependency-free `src/workflow/wiki.ts` owning all bundle filesystem access: root resolution, concept-path validation with escape and reserved-name protection, permissive frontmatter parsing via `Bun.YAML`, block-style frontmatter rendering for diffability, conformance checking per §11, ranked linear `search`, synthesized `list`, `read`, atomic concept upsert, verification promotion, and `log.md` append.
- Expose the bundle through new `agentic-coding workflow wiki list|search|show|write|verify|log` subcommands. Reads are ungated. `write` is available to sequential planning roles and to archive; `verify` and `log` are archive-only.
- Add a **wiki approval gate**: a new developer step `core.wiki-approval` between `core.archive` and `core.delivery`, reviewed through a modal that lists the concepts this change touched with diffs against a pre-change snapshot and supports line-anchored comments. Comments route back to the still-live archive agent for revision; approval promotes every touched concept to the **human-reviewed** trust tier through an engine effect, which no agent can forge.
- **Resolve the requester's open question with a two-phase, trust-tiered write model** grounded in OKF §5.2/§5.3: sequential planning roles (`core.plan`, `fusion.consolidate`) MAY author concepts as `status: draft` with `generated.by` set and no `verified` key, which OKF classifies as the **unverified** trust tier; the parallel `fusion.plan` planners stay read-only because they run with an explicit no-coordination rule; the `core.archive` role promotes concepts to `status: stable` and appends `verified: { by: process:herdr-archive, at }`, reaching the **machine-confirmed** tier, and records the change in `log.md`.
- Update the pinned instructions `planning.md`, `planning-fusion.md`, `fusion-consolidation.md`, and `archive.md`, then regenerate `src/workflow/embedded.generated.ts` so the digest pins match.
- Document the wiki in `README.md` and add the `[wiki]` section to the shipped `pi/herdr-workflow.toml` defaults template.

## Capabilities

### New Capabilities
- `knowledge-wiki`: A centralized, project-independent OKF v0.2 knowledge bundle with a conformant producer/consumer implementation, a role-gated CLI surface, and a draft-then-verify ownership policy wired through the pinned agent instructions.

### Modified Capabilities
<!-- None: no existing spec states requirements about instruction assets, the workflow CLI surface, or configuration keys, so no delta spec is required. -->

## Impact

- New code: `agentic-coding/src/workflow/wiki.ts`; a wiki review modal pair under `agentic-coding/src/tui/dash/`.
- Modified code: `agentic-coding/src/workflow/cli.ts` (new `wiki` subcommand and help), `agentic-coding/src/workflow/effects.ts` (optional `wiki` config section and default), `agentic-coding/src/workflow/definitions.ts` (new `core.wiki-approval` step, gate edges, new `wiki.verify` effect), `agentic-coding/src/workflow/effect-runner.ts` (`wiki.verify` execution), `agentic-coding/src/workflow/runtime.ts` (gate actions), `agentic-coding/src/tui/dash/data.ts` (review persistence and action key).
- Modified assets: `agent-definitions/instructions/{planning,planning-fusion,fusion-consolidation,archive}.md`, regenerated `agentic-coding/src/workflow/embedded.generated.ts`.
- New tests: `agentic-coding/test/workflow-wiki.test.ts`; extended `agentic-coding/test/workflow-cli.test.ts` and `agentic-coding/test/workflow-assets.test.ts`.
- Docs/config: `README.md`, `pi/herdr-workflow.toml`.
- No new npm dependencies: YAML parsing uses the built-in `Bun.YAML`. This sets a Bun version floor that must be confirmed against the `packageManager` pin in `package.json` (currently `bun@1.3.14`; verified working on 1.4.0).
- The approval gate adds one workflow step, one effect, and one developer action set; it does not change the assignment contract, adapters, capabilities, or any step's capability requirements. Adding a step to the manifests and changing pinned instruction assets both change definition digests, so workflows already in flight may need `agentic-coding workflow repin`.
- **BREAKING for in-flight workflows only**: `core.wiki-approval` is inserted into the `standard`, `direct-apply`, and `plan-fusion` manifests, which bumps their version. Workflows mid-run on the previous version continue on their pinned definition.
- New filesystem surface outside every repository: `~/.config/agentic-coding/wiki/` is created on first use.
