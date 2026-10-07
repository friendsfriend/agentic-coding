// Engine reads family traits instead of repository family identifiers
// (read-family-traits-instead-of-ids): the static guard that fails on any
// repository code-change family id comparison outside the definitions catalog,
// plus the step-behavior proof that a definition with a new id behaves by its
// declared traits. See docs/workflow-architecture.md for the layer matrix and
// the family-traits tier.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	checkRepositoryFamilyIdComparisons,
	REPOSITORY_FAMILY_IDS,
} from "../scripts/workflow-architecture.ts";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import type { WorkflowFamilyTraits } from "../src/workflow/registry.ts";
import { implementationBehavior } from "../src/workflow/steps/implementation.ts";
import { lifecycleBehaviors } from "../src/workflow/steps/lifecycle.ts";
import { verificationBehaviors } from "../src/workflow/steps/verification.ts";

const SRC_ROOT = path.join(import.meta.dir, "..", "src");
const FIXTURES = path.join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"source-layer-boundaries",
);
const fixtureRoot = (...parts: string[]) =>
	path.join(FIXTURES, ...parts, "src");
const rel = (root: string, file: string) =>
	path.relative(root, file).split(path.sep).join("/");

function snapshot(definitionId: string): WorkflowSnapshot {
	return {
		schemaVersion: 1,
		workflowId: "test",
		revision: 1,
		definition: { id: definitionId, version: 801, digest: "digest" },
		status: "active",
		currentStep: "core.completed",
		step: {
			attempt: 1,
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles: [],
			testRunStarted: false,
			results: [],
		},
		metadata: {
			repository: "",
			worktree: "",
			changeId: "",
			branch: "",
			baseBranch: "",
			baseCommit: "",
			createdAt: "",
			updatedAt: "",
			stepEnteredAt: "",
		},
		routing: { defaultProfile: "", routes: [] },
		evidence: [],
		loopCounts: {},
		attention: [],
		developerDialogue: [],
	};
}

/** The composition this change exists for: a registered repository definition
 * with an id the engine has never seen declares its own traits. */
const COMPOSED_TRAITS: WorkflowFamilyTraits = {
	changeArtifacts: "none",
	planning: "none",
	changeIdentity: "none",
	delivery: "none",
	startRequirements: ["task", "clean-tree"],
	openspecVerifier: false,
};

describe("repository family id comparisons (read-family-traits-instead-of-ids)", () => {
	test("the guard covers every repository code-change family", () => {
		expect([...REPOSITORY_FAMILY_IDS].sort()).toEqual([
			"no-openspec",
			"openspec",
			"openspec-apply",
			"openspec-fusion",
			"openspec-fusion-propose",
			"openspec-propose",
			"rebase",
			"solo",
			"verify",
		]);
	});

	test("src compares no definition id to a repository family name outside the definitions catalog", () => {
		expect(checkRepositoryFamilyIdComparisons(SRC_ROOT)).toEqual([]);
	});

	test("a family-id comparison outside the catalog fails and names the module", () => {
		const root = fixtureRoot("negative", "family-id-read");
		const issues = checkRepositoryFamilyIdComparisons(root);
		// One per planted shape: a roster `has`, two equality branches, a
		// `startsWith`, and the two `switch` cases.
		expect(issues.length).toBeGreaterThanOrEqual(5);
		expect(rel(root, issues[0].file)).toBe("workflow/steps/bad.ts");
		expect(issues[0].rule).toBe("family:id-comparison");
		for (const issue of issues)
			expect(issue.message).toContain("family traits");
		const text = issues.map((issue) => issue.message).join("\n");
		for (const family of ["openspec-fusion", "no-openspec", "solo"])
			expect(text).toContain(`"${family}"`);
	});

	test("documentation-family checks, trait reads, and the family catalog stay legal", () => {
		const root = fixtureRoot("positive", "family-traits");
		expect(checkRepositoryFamilyIdComparisons(root)).toEqual([]);
	});

	test("the definitions catalog is the one place a family id may be compared", () => {
		// `FAMILY_TRAITS`/`MANIFEST_POLICY` are keyed by family id, and the
		// trait enums are declared there: the guard skips that tree on purpose
		// rather than reporting its own catalog.
		expect(
			checkRepositoryFamilyIdComparisons(
				path.join(SRC_ROOT, "workflow", "definitions"),
			),
		).toEqual([]);
	});
});

describe("step behaviors decide by traits, not by definition id", () => {
	test("an unknown id declaring changeArtifacts none runs implementation change-free", () => {
		const composed = snapshot("composed-repository-flow");
		// The built-in path would pass no evidence for this id and the guard
		// would reject it; the declared trait is what exempts it.
		expect(() =>
			implementationBehavior.validateEvidence?.({
				snapshot: composed,
				evidence: undefined,
				traits: COMPOSED_TRAITS,
			}),
		).not.toThrow();
		// Without traits the same unknown id falls back to the catalog table,
		// which has nothing for it: the change-evidence guard applies.
		expect(() =>
			implementationBehavior.validateEvidence?.({
				snapshot: composed,
				evidence: undefined,
			}),
		).toThrow();
	});

	test("an unknown id declaring delivery none offers only close on completion", () => {
		const composed = snapshot("composed-repository-flow");
		expect(
			lifecycleBehaviors["core.completed"]
				?.developerActions?.({
					snapshot: composed,
					traits: COMPOSED_TRAITS,
				})
				?.map((action) => action.id),
		).toEqual(["close"]);
		expect(
			lifecycleBehaviors["core.completed"]
				?.developerActions?.({
					snapshot: composed,
					traits: { ...COMPOSED_TRAITS, delivery: "pull-request" },
				})
				?.map((action) => action.id),
		).toEqual(["create-pr", "close"]);
	});

	test("a declared false openspecVerifier drops the role, declared true keeps it", () => {
		const composed = snapshot("composed-repository-flow");
		const roles = (traits: WorkflowFamilyTraits) =>
			verificationBehaviors["core.verification"]?.candidateRoles?.({
				definitionId: "composed-repository-flow",
				fusionPlannerCount: 0,
				traits,
			}) ?? [];
		expect(roles(COMPOSED_TRAITS)).not.toContain("openspec-verifier");
		expect(roles({ ...COMPOSED_TRAITS, openspecVerifier: true })).toContain(
			"openspec-verifier",
		);
		expect(composed.definition.id).toBe("composed-repository-flow");
	});
});
