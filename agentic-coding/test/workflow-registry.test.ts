import { describe, expect, test } from "bun:test";
import { rolesForDefinition } from "../src/workflow/cli.ts";
import type { WorkflowSnapshot } from "../src/workflow/contracts.ts";
import {
	BUILTIN_CAPABILITIES,
	BUILTIN_EFFECTS,
	PUBLIC_WORKFLOW_CATALOG,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	type StepDefinition,
	WorkflowRegistry,
} from "../src/workflow/registry.ts";

const contract = { id: "test.empty", version: 1, parse: () => null };
const reduction = (snapshot: WorkflowSnapshot) => ({ snapshot, effects: [] });
function testStep(id: string, outcomes = ["next"]): StepDefinition {
	return {
		id,
		version: 1,
		label: id,
		actor: "system",
		instructionAssets: [],
		instructionDigests: [],
		requirements: [],
		input: contract,
		output: contract,
		outcomes,
		allowedEffects: [],
		behavior: {},
		enter: reduction,
		reduce: reduction,
	};
}

describe("workflow registry", () => {
	test("registers immutable pinned built-ins through public seam", () => {
		const registry = registerBuiltins();
		expect(
			registry
				.definitions()
				.filter((item) => item.version === 1)
				.map((item) => item.id),
		).toEqual([
			"openspec-full",
			"openspec-propose",
			"openspec-apply",
			"no-openspec",
			"openspec-fusion-full",
			"openspec-fusion-propose",
		]);
		const standard = registry.definition("openspec-full", 1);
		expect(standard.steps).toContain("core.verification");
		expect(() => registry.definition("openspec-full", 1, "changed")).toThrow(
			/pin mismatch/,
		);
		expect(Object.isFrozen(standard)).toBe(true);
		for (const [id, steps, initial] of [
			[
				"openspec-propose",
				["core.plan", "core.plan-approval", "core.completed", "core.closed"],
				"core.plan",
			],
			[
				"openspec-fusion-propose",
				[
					"fusion.plan",
					"fusion.consolidate",
					"core.plan-approval",
					"core.completed",
					"core.closed",
				],
				"fusion.plan",
			],
		] as const) {
			const proposal = registry.definition(id, 1);
			expect(proposal.steps).toEqual(steps);
			expect(proposal.initial).toBe(initial);
			expect(proposal.terminal).toEqual(["core.closed"]);
		}
		const standardProposal = registry.definition("openspec-propose", 1);
		expect(standardProposal.edges).toEqual([
			{ from: "core.plan", outcome: "complete", to: "core.plan-approval" },
			{
				from: "core.plan",
				outcome: "blocked",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan",
				outcome: "failed",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan-approval",
				outcome: "approve",
				to: "core.completed",
			},
			{
				from: "core.plan-approval",
				outcome: "reject",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan-approval",
				outcome: "comments",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.completed",
				outcome: "create-pr",
				to: "core.completed",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		]);
		const fusionProposal = registry.definition("openspec-fusion-propose", 1);
		for (const outcome of ["blocked", "failed"])
			expect(
				fusionProposal.edges.find(
					(edge) =>
						edge.from === "fusion.consolidate" && edge.outcome === outcome,
				)?.loop?.maxAttempts,
			).toBe(3);
		expect(
			fusionProposal.edges.find(
				(edge) =>
					edge.from === "fusion.consolidate" && edge.outcome === "complete",
			)?.to,
		).toBe("core.plan-approval");
		for (const proposal of [standardProposal, fusionProposal]) {
			expect(proposal.steps).not.toContain("core.implementation");
			expect(proposal.steps).not.toContain("core.verification");
			expect(proposal.steps).not.toContain("core.archive");
			expect(proposal.steps).not.toContain("core.delivery");
		}
		expect(registry.definition("openspec-full", 1).steps).toContain(
			"core.implementation",
		);
		expect(registry.definition("openspec-fusion-full", 1).steps).toContain(
			"core.plan-approval",
		);
		for (const entry of PUBLIC_WORKFLOW_CATALOG)
			expect(registry.definition(entry.id, 106)).toBeTruthy();
		expect(
			PUBLIC_WORKFLOW_CATALOG.find((entry) => entry.alias === "quick")?.id,
		).toBe("no-openspec");
		for (const oldId of [
			"standard",
			"standard-propose",
			"direct-apply",
			"plan-fusion",
			"fusion-propose",
			"wiki-only",
			"wiki-comment-review",
		])
			expect(() => registry.definition(oldId, 1)).toThrow(
				/missing workflow definition/,
			);
	});
	test("research graph routes wiki approval through the completed close gate", () => {
		const registry = registerBuiltins();
		const research = registry.definition("research", 106);
		expect(research.steps).toEqual([
			"core.research",
			"core.wiki",
			"core.wiki-approval",
			"core.completed",
			"core.closed",
		]);
		expect(research.initial).toBe("core.research");
		expect(research.terminal).toEqual(["core.closed"]);
		for (const forbidden of [
			"core.implementation",
			"core.verification",
			"core.archive",
			"core.delivery",
		])
			expect(research.steps).not.toContain(forbidden);
		expect(
			research.edges.find(
				(edge) =>
					edge.from === "core.wiki-approval" && edge.outcome === "approve",
			),
		).toMatchObject({
			to: "core.completed",
			effects: [
				{ kind: "wiki.verify", idempotencyKey: "wiki.verify", payload: {} },
			],
		});
		expect(
			research.edges.find(
				(edge) =>
					edge.from === "core.wiki-approval" && edge.outcome === "comments",
			),
		).toMatchObject({ to: "core.wiki" });
		expect(
			research.edges.find(
				(edge) => edge.from === "core.completed" && edge.outcome === "close",
			),
		).toMatchObject({ to: "core.closed" });
	});
	test("configured verification policy is pinned as a distinct definition", () => {
		const registry = registerBuiltins(undefined, 20);
		const legacy = registry.definition("openspec-full", 1);
		const configured = registry.definition("openspec-full", 20);
		expect(configured.digest).not.toBe(legacy.digest);
		expect(
			configured.edges.find(
				(edge) => edge.from === "core.verification" && edge.outcome === "fix",
			)?.loop?.maxAttempts,
		).toBe(20);
		for (let rounds = 1; rounds <= 20; rounds++) {
			const version = rounds === 6 ? 1 : rounds === 1 ? 21 : rounds;
			expect(registry.definition("openspec-full", version)).toBeTruthy();
			for (const id of ["openspec-propose", "openspec-fusion-propose"])
				expect(registry.definition(id, version)).toBeTruthy();
		}
		const planFusion = registry.definition("openspec-fusion-full", 120);
		expect(
			rolesForDefinition(
				"openspec-full",
				registry.definition("openspec-full", 120).steps,
				registry,
			),
		).toMatchObject({
			"core.wiki": ["wiki"],
		});
		const fusionProposal = registry.definition("openspec-fusion-propose", 20);
		expect(
			rolesForDefinition("openspec-fusion-full", planFusion.steps, registry, 2)[
				"fusion.plan"
			],
		).toEqual(
			rolesForDefinition(
				"openspec-fusion-propose",
				fusionProposal.steps,
				registry,
				2,
			)["fusion.plan"],
		);
		expect(() => registerBuiltins(undefined, 21)).toThrow(
			"max_verification_rounds",
		);
	});
	test("rejects dangling, unreachable, undeclared-cycle, and unknown effects", () => {
		expect(() =>
			new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({
				...testStep("bad.version"),
				version: 0,
			}),
		).toThrow(/identity/);
		expect(() =>
			new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({
				...testStep("bad.actor"),
				actor: "alien" as never,
			}),
		).toThrow(/actor/);
		expect(() =>
			new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({
				...testStep("bad.schema"),
				output: { ...contract, version: 0 },
			}),
		).toThrow(/contracts/);
		expect(() =>
			new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep(
				testStep("bad.outcomes", []),
			),
		).toThrow(/outcomes/);
		expect(() =>
			new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({
				...testStep("bad.retry"),
				retryLimit: 0,
			}),
		).toThrow(/retry/);
		expect(() =>
			new WorkflowRegistry(BUILTIN_EFFECTS, []).registerStep({
				...testStep("bad.requirement"),
				requirements: ["prompt"],
			}),
		).toThrow(/requirement/);
		const registry = new WorkflowRegistry(
			BUILTIN_EFFECTS,
			BUILTIN_CAPABILITIES,
		);
		registry.registerStep(testStep("test.start"));
		registry.registerStep(testStep("test.end", ["done"]));
		expect(() =>
			registry.registerWorkflow({
				id: "bad-dangling",
				version: 1,
				label: "bad",
				initial: "test.start",
				terminal: ["test.end"],
				steps: ["test.start", "test.end"],
				edges: [{ from: "test.start", outcome: "next", to: "missing" }],
			}),
		).toThrow(/dangling/);
		expect(() =>
			registry.registerWorkflow({
				id: "bad-unreachable",
				version: 1,
				label: "bad",
				initial: "test.start",
				terminal: ["test.end"],
				steps: ["test.start", "test.end"],
				edges: [],
			}),
		).toThrow();
		const cyclic = new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES);
		cyclic.registerStep(testStep("cycle.a"));
		cyclic.registerStep(testStep("cycle.b"));
		expect(() =>
			cyclic.registerWorkflow({
				id: "bad-cycle",
				version: 1,
				label: "bad",
				initial: "cycle.a",
				terminal: ["cycle.b"],
				steps: ["cycle.a", "cycle.b"],
				edges: [
					{ from: "cycle.a", outcome: "next", to: "cycle.b" },
					{ from: "cycle.b", outcome: "next", to: "cycle.a" },
				],
			}),
		).toThrow();
		expect(() =>
			new WorkflowRegistry([], BUILTIN_CAPABILITIES).registerStep({
				...testStep("bad.effect"),
				allowedEffects: ["agent.launch"],
			}),
		).toThrow(/unknown effect/);
	});
	test("extra registered step never changes existing composition", () => {
		const registry = registerBuiltins();
		const before = registry.definition("openspec-full", 1).digest;
		registry.registerStep(testStep("extension.audit"));
		expect(registry.definition("openspec-full", 1).digest).toBe(before);
		expect(registry.definition("openspec-full", 1).steps).not.toContain(
			"extension.audit",
		);
		const composed = registry.registerWorkflow({
			id: "extension-flow",
			version: 1,
			label: "Extension",
			initial: "extension.audit",
			terminal: ["extension.audit"],
			steps: ["extension.audit"],
			edges: [],
		});
		expect(composed.steps).toEqual(["extension.audit"]);
	});
	describe("manifest policy (design D1)", () => {
		function manifestFor(policy: unknown) {
			return {
				id: "policy-flow",
				version: 1,
				label: "Policy flow",
				initial: "extension.audit",
				terminal: ["extension.audit"],
				steps: ["extension.audit"],
				edges: [],
				policy,
			};
		}
		test("rejects an unknown target kind, naming the manifest", () => {
			const registry = new WorkflowRegistry(
				BUILTIN_EFFECTS,
				BUILTIN_CAPABILITIES,
			);
			registry.registerStep(testStep("extension.audit"));
			expect(() =>
				registry.registerWorkflow(
					manifestFor({
						targetKind: "alien",
						checkoutRequired: false,
						requiresReadOnlyResearcher: false,
					}) as never,
				),
			).toThrow(/unknown policy target kind in policy-flow/);
		});
		test("rejects a read-only-researcher requirement outside the research target", () => {
			const registry = new WorkflowRegistry(
				BUILTIN_EFFECTS,
				BUILTIN_CAPABILITIES,
			);
			registry.registerStep(testStep("extension.audit"));
			expect(() =>
				registry.registerWorkflow(
					manifestFor({
						targetKind: "repository",
						checkoutRequired: false,
						requiresReadOnlyResearcher: true,
					}) as never,
				),
			).toThrow(/contradictory policy in policy-flow/);
		});
		test("rejects a checkout requirement outside the repository target", () => {
			const registry = new WorkflowRegistry(
				BUILTIN_EFFECTS,
				BUILTIN_CAPABILITIES,
			);
			registry.registerStep(testStep("extension.audit"));
			expect(() =>
				registry.registerWorkflow(
					manifestFor({
						targetKind: "wiki",
						checkoutRequired: true,
						requiresReadOnlyResearcher: false,
					}) as never,
				),
			).toThrow(/contradictory policy in policy-flow/);
		});
		test("accepts a consistent policy and pins it on the compiled definition", () => {
			const registry = new WorkflowRegistry(
				BUILTIN_EFFECTS,
				BUILTIN_CAPABILITIES,
			);
			registry.registerStep(testStep("extension.audit"));
			const compiled = registry.registerWorkflow(
				manifestFor({
					targetKind: "research",
					checkoutRequired: false,
					requiresReadOnlyResearcher: true,
				}) as never,
			);
			expect(compiled.policy).toEqual({
				targetKind: "research",
				checkoutRequired: false,
				requiresReadOnlyResearcher: true,
			});
		});
		test("every built-in manifest-policy-tier definition declares a policy, and prior tiers are unaffected", () => {
			const registry = registerBuiltins();
			// The manifest-policy tier is `definitionVersionForManifestPolicy`
			// (rounds + 200) for rounds 1..20 — versions 201..220. Every other
			// registered version (legacy, wikiGate-policy, and the frozen 1000
			// back-compat set) predates the `policy` block.
			const policyBearing = registry
				.definitions()
				.filter(
					(definition) =>
						definition.version >= 201 && definition.version <= 220,
				);
			expect(policyBearing.length).toBeGreaterThan(0);
			for (const definition of policyBearing)
				expect(definition.policy).toBeTruthy();
			// The pre-manifest-policy tiers (legacy, wikiGate-policy, and the
			// frozen 1000 set) keep registering under their original versions
			// with no `policy` field, so their digests are the ones asserted
			// unchanged in test/workflow-steps.test.ts's full-catalog pin.
			for (const definition of registry
				.definitions()
				.filter(
					(definition) => definition.version < 201 || definition.version > 220,
				))
				expect(definition.policy).toBeUndefined();
		});
	});
});
