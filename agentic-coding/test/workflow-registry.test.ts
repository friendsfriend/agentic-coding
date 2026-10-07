import { describe, expect, test } from "bun:test";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import { rolesForDefinition } from "../src/workflow/cli.ts";
import {
	definitionVersionForFamilyTraits,
	definitionVersionForStageGates,
	definitionVersionForStepRouting,
	effectiveFamilyTraits,
} from "../src/workflow/definitions/manifest-policy.ts";
import {
	BUILTIN_CAPABILITIES,
	BUILTIN_EFFECTS,
	definitionVersionForBehaviorPins,
	PUBLIC_WORKFLOW_CATALOG,
	REMOVED_WORKFLOW_REPLACEMENTS,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	type StepDefinition,
	type WorkflowFamilyTraits,
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
			"openspec",
			"openspec-apply",
			"openspec-propose",
			"no-openspec",
			"openspec-fusion",
			"openspec-fusion-propose",
			"solo",
			"rebase",
			"verify",
		]);
		const standard = registry.definition("openspec", 1);
		expect(standard.steps).toContain("core.verification");
		expect(() => registry.definition("openspec", 1, "changed")).toThrow(
			/pin mismatch/,
		);
		expect(Object.isFrozen(standard)).toBe(true);
		for (const [id, steps, initial] of [
			[
				"openspec-propose",
				[
					"core.route-plan",
					"core.plan",
					"core.plan-approval",
					"core.completed",
					"core.closed",
				],
				"core.route-plan",
			],
			[
				"openspec-fusion-propose",
				[
					"core.route-plan",
					"fusion.plan",
					"fusion.consolidate",
					"core.plan-approval",
					"core.completed",
					"core.closed",
				],
				"core.route-plan",
			],
		] as const) {
			const proposal = registry.definition(id, 1);
			expect(proposal.steps).toEqual(steps);
			expect(proposal.initial).toBe(initial);
			expect(proposal.terminal).toEqual(["core.closed"]);
		}
		const standardProposal = registry.definition("openspec-propose", 1);
		expect(standardProposal.edges).toEqual([
			{ from: "core.route-plan", outcome: "complete", to: "core.plan" },
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
		expect(registry.definition("openspec", 1).steps).toContain(
			"core.implementation",
		);
		expect(registry.definition("openspec-fusion", 1).steps).toContain(
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
		// Identifiers removed by the pools hard cut name their replacement.
		for (const [removed, replacement] of Object.entries(
			REMOVED_WORKFLOW_REPLACEMENTS,
		))
			expect(() => registry.definition(removed, 1)).toThrow(
				new RegExp(
					`unknown/removed definition: ${removed} \\(use ${replacement}\\)`,
				),
			);
	});
	test("new definitions pin exact step and behavior identities", () => {
		const registry = registerBuiltins();
		const legacy = registry.definition("openspec", 1);
		const pinned = registry.definition(
			"openspec",
			definitionVersionForBehaviorPins(6),
		);
		expect(pinned.stepRefs).toEqual(
			pinned.steps.map((id) => ({ id, version: 1, behaviorVersion: 1 })),
		);
		expect(pinned.digest).not.toBe(legacy.digest);
		for (const id of pinned.steps)
			expect(registry.stepForDefinition(pinned, id).id).toBe(id);
		expect(registry.stepForDefinition(legacy, "core.plan").version).toBe(1);
	});
	test("resolves a requested step version and fails closed for missing compatibility", () => {
		const registry = new WorkflowRegistry(
			BUILTIN_EFFECTS,
			BUILTIN_CAPABILITIES,
		);
		const first = testStep("versioned.step");
		registry.registerStep(first);
		registry.registerStep({
			...first,
			version: 2,
			behaviorVersion: 2,
			reduce() {
				throw new Error("second behavior");
			},
		});
		const definition = registry.registerWorkflow({
			id: "versioned-flow",
			version: 1,
			label: "Versioned",
			initial: "versioned.step",
			terminal: ["versioned.step"],
			steps: ["versioned.step"],
			stepRefs: [{ id: "versioned.step", version: 2, behaviorVersion: 2 }],
			edges: [],
		});
		const resolved = registry.stepForDefinition(definition, "versioned.step");
		expect(resolved.version).toBe(2);
		expect(() =>
			resolved.reduce({} as WorkflowSnapshot, { outcome: "next" }),
		).toThrow(/second behavior/);
		expect(() =>
			registry.stepForDefinition(
				{
					...definition,
					stepRefs: [{ id: "versioned.step", version: 2, behaviorVersion: 1 }],
				},
				"versioned.step",
			),
		).toThrow(/behavior compatibility mismatch/);
		const legacy = registry.registerWorkflow({
			id: "unsupported-legacy",
			version: 1,
			label: "Unsupported legacy",
			initial: "versioned.step",
			terminal: ["versioned.step"],
			steps: ["versioned.step"],
			edges: [],
		});
		expect(() => registry.stepForDefinition(legacy, "versioned.step")).toThrow(
			/unsupported legacy step compatibility mapping/,
		);
	});
	test("pinned behavior versions make different completion decisions on one graph", () => {
		const registry = new WorkflowRegistry(
			BUILTIN_EFFECTS,
			BUILTIN_CAPABILITIES,
		);
		const first = {
			...testStep("versioned.complete", ["complete"]),
			behaviorVersion: 1,
			reduce(snapshot: WorkflowSnapshot) {
				return {
					snapshot: { ...snapshot, status: "completed" as const },
					effects: [],
				};
			},
		};
		const second = {
			...first,
			version: 2,
			behaviorVersion: 2,
			reduce(snapshot: WorkflowSnapshot) {
				return {
					snapshot: { ...snapshot, status: "attention-required" as const },
					effects: [],
				};
			},
		};
		registry.registerStep(first);
		registry.registerStep(second);
		const register = (version: number, stepVersion: number) =>
			registry.registerWorkflow({
				id: "versioned-completion-flow",
				version,
				label: `Versioned completion ${version}`,
				initial: "versioned.complete",
				terminal: ["versioned.complete"],
				steps: ["versioned.complete"],
				stepRefs: [
					{
						id: "versioned.complete",
						version: stepVersion,
						behaviorVersion: stepVersion,
					},
				],
				edges: [],
			});
		const complete = (version: number) => {
			const definition = registry.definition(
				"versioned-completion-flow",
				version,
			);
			return registry
				.stepForDefinition(definition, "versioned.complete")
				.reduce({} as WorkflowSnapshot, { outcome: "complete" }).snapshot
				.status;
		};
		register(1, 1);
		register(2, 2);
		expect(complete(1)).toBe("completed");
		expect(complete(2)).toBe("attention-required");
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
		const legacy = registry.definition("openspec", 1);
		const configured = registry.definition("openspec", 20);
		expect(configured.digest).not.toBe(legacy.digest);
		expect(
			configured.edges.find(
				(edge) => edge.from === "core.verification" && edge.outcome === "fix",
			)?.loop?.maxAttempts,
		).toBe(20);
		for (let rounds = 1; rounds <= 20; rounds++) {
			const version = rounds === 6 ? 1 : rounds === 1 ? 21 : rounds;
			expect(registry.definition("openspec", version)).toBeTruthy();
			for (const id of ["openspec-propose", "openspec-fusion-propose"])
				expect(registry.definition(id, version)).toBeTruthy();
		}
		const planFusion = registry.definition("openspec-fusion", 120);
		const openspecPolicyTier = registry.definition("openspec", 120);
		expect(
			rolesForDefinition(
				"openspec",
				openspecPolicyTier.steps,
				registry,
				0,
				openspecPolicyTier,
			),
		).toMatchObject({
			"core.wiki": ["wiki"],
		});
		const fusionProposal = registry.definition("openspec-fusion-propose", 20);
		expect(
			rolesForDefinition(
				"openspec-fusion",
				planFusion.steps,
				registry,
				2,
				planFusion,
			)["fusion.plan"],
		).toEqual(
			rolesForDefinition(
				"openspec-fusion-propose",
				fusionProposal.steps,
				registry,
				2,
				fusionProposal,
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
		const before = registry.definition("openspec", 1).digest;
		registry.registerStep(testStep("extension.audit"));
		expect(registry.definition("openspec", 1).digest).toBe(before);
		expect(registry.definition("openspec", 1).steps).not.toContain(
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
			// (rounds + 200) for rounds 1..20 — versions 201..220. The newer
			// behavior-pin tier (rounds + 300), full-tool research tier
			// (rounds + 400), and family-traits tier (rounds + 800) also carry
			// policy blocks.
			const policyBearing = registry
				.definitions()
				.filter(
					(definition) =>
						(definition.version >= 201 && definition.version <= 220) ||
						(definition.version >= 301 && definition.version <= 320) ||
						(definition.version >= 401 && definition.version <= 420) ||
						(definition.version >= 801 && definition.version <= 820),
				);
			expect(policyBearing.length).toBeGreaterThan(0);
			for (const definition of policyBearing)
				expect(definition.policy).toBeTruthy();
			// The pre-manifest-policy tiers (legacy, wikiGate-policy, and the
			// frozen 1000 set) keep registering under their original versions
			// with no `policy` field, so their digests are the ones asserted
			// unchanged in test/workflow-steps.test.ts's full-catalog pin. Every
			// tier since the manifest-policy one (including the
			// classifier-driven triage-routing, stage-gate, step-routing, and
			// family-traits tiers) declares a policy.
			for (const definition of registry
				.definitions()
				.filter(
					(definition) =>
						(definition.version < 201 || definition.version > 220) &&
						(definition.version < 301 || definition.version > 320) &&
						(definition.version < 401 || definition.version > 420) &&
						(definition.version < 501 || definition.version > 520) &&
						(definition.version < 601 || definition.version > 620) &&
						(definition.version < 701 || definition.version > 720) &&
						(definition.version < 801 || definition.version > 820),
				))
				expect(definition.policy).toBeUndefined();
		});
	});
});

describe("family traits (add-definition-family-traits)", () => {
	const registry = registerBuiltins();
	const traitsVersion = definitionVersionForFamilyTraits(6);
	const FAMILY_IDS: readonly string[] = [
		"openspec",
		"openspec-apply",
		"openspec-propose",
		"openspec-fusion",
		"openspec-fusion-propose",
		"no-openspec",
		"solo",
		"rebase",
		"verify",
	];
	const DOCUMENTATION_IDS: readonly string[] = [
		"wiki",
		"wiki-comments",
		"research",
	];
	/** The consistent baseline every rejection below varies one field of: a
	 * change-free, delivery-free, planner-free repository family. */
	const BASE_TRAITS = {
		changeArtifacts: "none",
		planning: "none",
		changeIdentity: "none",
		delivery: "none",
		startRequirements: [],
		openspecVerifier: true,
	} as const;
	/** Register a minimal terminal-step graph with a traits block attached, so
	 * a structural rejection can be isolated from the graph checks. */
	function registerWithTraits(
		traits: unknown,
		steps: readonly [string, ...string[]],
		targetKind = "repository",
	) {
		const entry = new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES);
		for (const step of steps) entry.registerStep(testStep(step));
		return entry.registerWorkflow({
			id: "policy-flow",
			version: 1,
			label: "Policy flow",
			initial: steps[0],
			terminal: [steps[steps.length - 1] as string],
			steps: [...steps],
			edges: [],
			policy: {
				targetKind,
				checkoutRequired: false,
				requiresReadOnlyResearcher: false,
				traits,
			},
		} as never);
	}

	test("rejects traits on a non-repository target, naming the manifest", () => {
		expect(() =>
			registerWithTraits(BASE_TRAITS, ["extension.audit"], "wiki"),
		).toThrow(/family traits outside repository target in policy-flow/);
	});

	test("rejects an unknown enum value in each trait", () => {
		for (const [field, message] of [
			["changeArtifacts", /unknown change artifacts trait/],
			["planning", /unknown planning trait/],
			["changeIdentity", /unknown change identity trait/],
			["delivery", /unknown delivery trait/],
		] as const)
			expect(() =>
				registerWithTraits({ ...BASE_TRAITS, [field]: "alien" }, [
					"extension.audit",
				]),
			).toThrow(message);
		expect(() =>
			registerWithTraits({ ...BASE_TRAITS, startRequirements: ["alien"] }, [
				"extension.audit",
			]),
		).toThrow(/invalid start requirements trait in policy-flow/);
		expect(() =>
			registerWithTraits(
				{ ...BASE_TRAITS, startRequirements: ["task", "task"] },
				["extension.audit"],
			),
		).toThrow(/invalid start requirements trait in policy-flow/);
		// The shape half of the guard: a block written without the field, or
		// with a bare string, fails by name instead of raising a `TypeError`.
		for (const startRequirements of [undefined, "task"])
			expect(() =>
				registerWithTraits({ ...BASE_TRAITS, startRequirements }, [
					"extension.audit",
				]),
			).toThrow(/invalid start requirements trait in policy-flow/);
	});

	test("rejects traits inconsistent with the graph's steps", () => {
		for (const [traits, steps, message] of [
			[
				{ ...BASE_TRAITS, changeArtifacts: "openspec", planning: "fusion" },
				["extension.audit"],
				/fusion planning without fusion.plan/,
			],
			[
				{ ...BASE_TRAITS, changeArtifacts: "openspec", planning: "single" },
				["extension.audit"],
				/single planning without core.plan/,
			],
			[BASE_TRAITS, ["core.plan"], /no planning with a planning step/],
			[BASE_TRAITS, ["fusion.plan"], /no planning with a planning step/],
			[
				{ ...BASE_TRAITS, delivery: "pull-request" },
				["extension.audit"],
				/pull-request delivery without core.delivery/,
			],
			[BASE_TRAITS, ["core.archive"], /change-free workflow with core.archive/],
			[
				{ ...BASE_TRAITS, changeIdentity: "workflow-id" },
				["extension.audit"],
				/workflow-id change identity without OpenSpec artifacts/,
			],
			[
				{ ...BASE_TRAITS, changeIdentity: "planned" },
				["extension.audit"],
				/planned change identity without OpenSpec artifacts/,
			],
		] as const)
			expect(() => registerWithTraits(traits, steps)).toThrow(message);
	});

	test("accepts a consistent traits block and pins it on the compiled definition", () => {
		const compiled = registerWithTraits(BASE_TRAITS, ["extension.audit"]);
		expect(compiled.policy?.traits).toEqual(BASE_TRAITS);
	});

	test("every repository code-change family declares traits at the traits tier", () => {
		for (const id of FAMILY_IDS) {
			const declared = registry.definition(id, traitsVersion).policy?.traits;
			expect(declared).toBeTruthy();
			// Parity (design D3): the fallback the engine reads for an earlier tier
			// is the same table this tier is built from, so the two cannot drift.
			expect(declared).toEqual(
				effectiveFamilyTraits(
					registry.definition(id, definitionVersionForStepRouting(6)),
				),
			);
		}
	});

	test("only the repository code-change families declare traits", () => {
		const tier = registry
			.definitions()
			.filter((definition) => definition.version === traitsVersion);
		expect(tier.length).toBeGreaterThan(0);
		for (const definition of tier)
			expect(Boolean(definition.policy?.traits)).toBe(
				FAMILY_IDS.includes(definition.id),
			);
	});

	test("effective traits resolve at every registered tier for the families only", () => {
		const seen = new Set<string>();
		for (const definition of registry.definitions()) {
			const traits = effectiveFamilyTraits(definition);
			if (FAMILY_IDS.includes(definition.id)) {
				expect(traits).toBeTruthy();
				seen.add(definition.id);
			} else if (DOCUMENTATION_IDS.includes(definition.id))
				expect(traits).toBeUndefined();
		}
		expect([...seen].sort()).toEqual([...FAMILY_IDS].sort());
	});

	test("every declared trait value is pinned, family by family", () => {
		// The full matrix, one row per repository code-change family and one entry
		// per trait (TQV-003). Every value is asserted, so a single-field edit to
		// `FAMILY_TRAITS` fails here instead of silently changing what the next
		// change's readers will do.
		const EXPECTED: Readonly<Record<string, WorkflowFamilyTraits>> = {
			openspec: {
				changeArtifacts: "openspec",
				planning: "single",
				changeIdentity: "planned",
				delivery: "pull-request",
				startRequirements: ["clean-tree", "openspec-project"],
				openspecVerifier: true,
			},
			"openspec-apply": {
				changeArtifacts: "openspec",
				planning: "none",
				changeIdentity: "workflow-id",
				delivery: "pull-request",
				startRequirements: [
					"clean-tree",
					"openspec-project",
					"openspec-change",
				],
				openspecVerifier: true,
			},
			"openspec-propose": {
				changeArtifacts: "openspec",
				planning: "single",
				changeIdentity: "planned",
				delivery: "none",
				startRequirements: ["openspec-project"],
				openspecVerifier: true,
			},
			"openspec-fusion": {
				changeArtifacts: "openspec",
				planning: "fusion",
				changeIdentity: "planned",
				delivery: "pull-request",
				startRequirements: ["clean-tree", "openspec-project"],
				openspecVerifier: true,
			},
			"openspec-fusion-propose": {
				changeArtifacts: "openspec",
				planning: "fusion",
				changeIdentity: "planned",
				delivery: "none",
				startRequirements: ["openspec-project"],
				openspecVerifier: true,
			},
			"no-openspec": {
				changeArtifacts: "none",
				planning: "none",
				changeIdentity: "none",
				delivery: "pull-request",
				startRequirements: ["task", "clean-tree"],
				openspecVerifier: false,
			},
			solo: {
				changeArtifacts: "none",
				planning: "none",
				changeIdentity: "none",
				delivery: "none",
				startRequirements: ["task", "clean-tree"],
				openspecVerifier: true,
			},
			rebase: {
				changeArtifacts: "none",
				planning: "none",
				changeIdentity: "none",
				delivery: "none",
				startRequirements: ["clean-tree", "rebase-refs"],
				openspecVerifier: true,
			},
			verify: {
				changeArtifacts: "none",
				planning: "none",
				changeIdentity: "none",
				delivery: "none",
				startRequirements: ["base-commit"],
				openspecVerifier: true,
			},
		};
		for (const id of FAMILY_IDS)
			expect([
				id,
				effectiveFamilyTraits(registry.definition(id, traitsVersion)),
			]).toEqual([id, EXPECTED[id]]);
	});

	test("every trait stays consistent with the graph and the start requirements", () => {
		for (const id of FAMILY_IDS) {
			const definition = registry.definition(id, traitsVersion);
			const traits = effectiveFamilyTraits(definition);
			if (!traits) throw new Error(`missing traits for ${id}`);
			// A family declares OpenSpec change artifacts exactly when its start
			// validates an OpenSpec project: the change-free families
			// (steps/implementation.ts's former `CHANGE_FREE_IMPLEMENTATION`) have
			// neither, and now read the trait instead of an id list
			// (read-family-traits-instead-of-ids).
			expect(traits.changeArtifacts === "none").toBe(
				!traits.startRequirements.includes("openspec-project"),
			);
			// The graph is the source of the planning mode, exactly as
			// `validateFamilyTraits` reads it.
			expect(traits.planning).toBe(
				definition.steps.includes("fusion.plan")
					? "fusion"
					: definition.steps.includes("core.plan")
						? "single"
						: "none",
			);
			// The workflow-id change identity is the apply family's; a change-free
			// family has no change identity at all.
			expect(traits.changeIdentity).toBe(
				traits.changeArtifacts === "none"
					? "none"
					: id === "openspec-apply"
						? "workflow-id"
						: "planned",
			);
		}
	});

	test("the traits tier differs from the step-routing tier only by its traits block", () => {
		for (const id of [...FAMILY_IDS, ...DOCUMENTATION_IDS]) {
			const below = registry.definition(id, definitionVersionForStepRouting(6));
			const above = registry.definition(id, traitsVersion);
			for (const field of [
				"id",
				"label",
				"initial",
				"terminal",
				"steps",
				"stepRefs",
				"edges",
				"allowedOutcomes",
			] as const)
				expect([id, field, above[field]]).toEqual([id, field, below[field]]);
			expect([id, below.policy?.traits]).toEqual([id, undefined]);
			expect([id, Boolean(above.policy?.traits)]).toEqual([
				id,
				FAMILY_IDS.includes(id),
			]);
		}
	});

	test("the traits tier keeps its published digests", () => {
		// Literal pins for the versions new starts resolve today: a later edit to
		// `FAMILY_TRAITS` or to this tier's family list moves a digest, and an
		// in-flight workflow pinned to the old one would fail `pin-mismatch`.
		// 801..820 is the family-traits tier; only 6 is pinned here (the default
		// round count the other suites build), plus the two tiers added
		// immediately before it.
		const expected: Readonly<Record<string, string>> = {
			openspec:
				"cfa0d0ccc98fc53e5bd02d0d3583dae303322370222b09aa3daaf03c4f50ebd5",
			"openspec-apply":
				"ae8bf3c08bc676f96aff6dcbdcea0e9b21e0e6dd779fabfa2d7cb632191e9309",
			"openspec-propose":
				"17abd93f89793826176593938bc35979df725b0d5b9e75c7e01a192b038f89d6",
			"openspec-fusion":
				"019c678e5cd0ca839fbbaf75d1435f02f78707c12b2a35eeedc588d118aaa7f8",
			"openspec-fusion-propose":
				"f4a04814763f35ed2984d1610f5653c999d49d5b1b5363472261213cfdff0891",
			"no-openspec":
				"1daf01b29c7cb19fb3d6dc654a15b84f65a5662e9edd2b7b116e0b578accc7bf",
			solo: "7224eaf5e703d3c94149e6d630c602d3ff23bf2313b47ce3a938b9dd823de191",
			rebase:
				"65cc5d6cf4b0bdcc9690bf749798873c12915fe8898d717496540795cb639de0",
			verify:
				"c0a185bd0d224ddf00c64f42d3fae01a2d96fc070fbf227d6165a7773dabe689",
			wiki: "23b5fb7ae4db9ac37804ef55585efae31961235d059886f3c4c9ac526968216b",
			"wiki-comments":
				"bef26705cc29c22b887293dd85d6c930648ef60f46aa894713a86e10f58f53b2",
			research:
				"f66c5e0dfa29b6ca024766240f5cd2439c65e555878457cc369f8c1e32ecd8ec",
		};
		for (const [id, digest] of Object.entries(expected))
			expect([id, registry.definition(id, traitsVersion).digest]).toEqual([
				id,
				digest,
			]);
		// The stage-gate and step-routing tiers, which had no literal pin before
		// this change: `openspec` is the definition every later tier is compared
		// against.
		for (const [version, digest] of [
			[
				definitionVersionForStageGates(6),
				"b13fbc03ac5a31d53c410df54aaa54ea40a1e7ce2e7d9ddecabac8f1e5ecb769",
			],
			[
				definitionVersionForStepRouting(6),
				"3cb37d5eb3dd1b179892c488d339147f6c0d43aa6ec2bb3652e049dcca4b96fd",
			],
		] as const)
			expect(registry.definition("openspec", version).digest).toBe(digest);
	});
});
