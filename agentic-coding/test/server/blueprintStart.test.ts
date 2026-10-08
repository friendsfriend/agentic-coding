// add-orchestrator-blueprint-workflows: the start half of the blueprint path.
// The server compiles a blueprint, stores its definition in the target store
// with its origin, pins the label/rationale/digest on the workflow's metadata
// and starts through the ordinary start boundary; a blueprint the compiler
// rejects is refused before anything is written.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	prepareBlueprintWorkflowStart,
	validateWorkflowBlueprint,
} from "../../src/server/operations/blueprints.ts";
import { registerBuiltins } from "../../src/workflow/definitions.ts";
import {
	openReadStore,
	storedDefinition,
} from "../../src/workflow/runtime/store.ts";
import { WorkflowEngine } from "../../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "../support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

const registry = registerBuiltins();

/** A valid logical blueprint that needs exactly one model pool (the
 * implementation step's). */
function blueprint(): Record<string, unknown> {
	return {
		label: "Small fix",
		rationale: "One implementation agent, start to finish.",
		traits: {
			changeArtifacts: "none",
			planning: "none",
			changeIdentity: "none",
			delivery: "none",
			startRequirements: ["task"],
			openspecVerifier: false,
		},
		verificationRounds: 6,
		steps: ["core.implementation", "core.completed", "core.closed"],
		edges: [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.completed",
			},
			{
				from: "core.implementation",
				outcome: "blocked",
				to: "core.implementation",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.implementation",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	};
}

/** A blueprint that bypasses developer review: the compiler refuses it. */
function reviewFreeBlueprint(): Record<string, unknown> {
	const value = blueprint();
	return {
		...value,
		label: "Review-free delivery",
		traits: {
			changeArtifacts: "none",
			planning: "none",
			changeIdentity: "none",
			delivery: "pull-request",
			startRequirements: ["task"],
			openspecVerifier: false,
		},
		steps: [
			"core.implementation",
			"core.verification",
			"core.delivery",
			"core.completed",
			"core.closed",
		],
		edges: [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.verification",
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.delivery",
			},
			{
				from: "core.verification",
				outcome: "fix",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	};
}

function repository(): string {
	return createTempRepoFixture("blueprint-start-", repoPreset.readme);
}

/** Give the fixture an `origin` remote whose HEAD is `main`, the start
 * boundary's default `base_branch`. */
function withRemote(root: string): void {
	execFileSync("git", ["remote", "add", "origin", root], { cwd: root });
	execFileSync("git", ["fetch", "-q", "origin"], { cwd: root });
	execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: root });
}

/** Run a body with `HERDR_WORKFLOW_CONFIG` pointed at a preset file outside the
 * repository: one pool for the implementation step, and a profile that never
 * needs a real agent executable. */
function withPresetConfig<T>(body: () => T): T {
	const previous = process.env.HERDR_WORKFLOW_CONFIG;
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-config-")),
		"config.json",
	);
	fs.writeFileSync(
		file,
		`${JSON.stringify({
			agents: {
				default_profile: "p",
				profiles: { p: { runtime: "pi-durable", executable: "/bin/true" } },
				presets: {
					fixed: {
						default_profile: "p",
						pools: {
							"core.implementation": [
								{ label: "only", profile: "p", default: true },
							],
						},
					},
				},
			},
		})}\n`,
	);
	process.env.HERDR_WORKFLOW_CONFIG = file;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
	}
}

describe("blueprint start", () => {
	test("compiles, stores with its origin, pins the metadata and starts", () => {
		const root = repository();
		withRemote(root);
		try {
			withPresetConfig(() => {
				const validation = validateWorkflowBlueprint(blueprint());
				if (!validation.ok || !validation.digest)
					throw new Error("expected the blueprint to validate");
				const prepared = prepareBlueprintWorkflowStart({
					repo: root,
					workflowId: "blueprint-task",
					blueprint: blueprint(),
					task: "fix the flag",
					mode: "worktree",
					preset: "fixed",
					principal: "orchestrator",
					enforceHumanReviewGates: true,
					startedBy: "orchestrator",
				});
				// The start pins the digest the validate route answered.
				expect(prepared.input.definitionId).toStartWith("custom.");
				expect(prepared.input.metadata.blueprint).toEqual({
					label: "Small fix",
					rationale: "One implementation agent, start to finish.",
					digest: validation.digest,
				});
				expect(prepared.input.metadata.startedBy).toBe("orchestrator");
				// Orchestrator starts keep the human gates pinned.
				expect(prepared.input.metadata.gatePolicies).toMatchObject({
					planApproval: "always",
					developerReview: "always",
					wiki: "always",
				});

				// The definition row is content-addressed and carries the origin.
				const db = openReadStore(root);
				try {
					const row = storedDefinition(db, prepared.input.definitionId, 1);
					if (!row) throw new Error("expected the definition to be stored");
					expect(row.digest.length).toBeGreaterThan(0);
					expect(JSON.parse(row.origin_json)).toMatchObject({
						kind: "blueprint",
						principal: "orchestrator",
						label: "Small fix",
					});
				} finally {
					db.close();
				}

				const started = new WorkflowEngine(registry).start(prepared.input);
				expect(started.snapshot.definition.id).toBe(
					prepared.input.definitionId,
				);
				expect(started.snapshot.definition.digest).toBe(validation.digest);
				expect(started.snapshot.metadata.blueprint?.digest).toBe(
					validation.digest,
				);
				expect(started.snapshot.currentStep).toBe("core.route-implementation");
				expect(started.view.definition.id).toBe(prepared.input.definitionId);

				// A retried start reuses the same stored definition: storing is
				// idempotent by digest.
				const again = prepareBlueprintWorkflowStart({
					repo: root,
					workflowId: "blueprint-task-2",
					blueprint: blueprint(),
					task: "fix the flag",
					mode: "worktree",
					preset: "fixed",
				});
				expect(again.input.definitionId).toBe(prepared.input.definitionId);
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a rejected blueprint is refused before anything is written", () => {
		const root = repository();
		withRemote(root);
		try {
			withPresetConfig(() => {
				expect(() =>
					prepareBlueprintWorkflowStart({
						repo: root,
						workflowId: "blueprint-refused",
						blueprint: reviewFreeBlueprint(),
						task: "deliver it",
						mode: "worktree",
						preset: "fixed",
					}),
				).toThrow(/review\.implementation-review/);
			});
			// No store was initialized or migrated: the compile happens first.
			expect(fs.existsSync(path.join(root, ".herdr-workflow"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a blueprint that declares the checkout forces checkout mode", () => {
		const root = repository();
		withRemote(root);
		try {
			withPresetConfig(() => {
				const prepared = prepareBlueprintWorkflowStart({
					repo: root,
					workflowId: "blueprint-checkout",
					blueprint: { ...blueprint(), checkoutRequired: true },
					task: "fix the flag",
					mode: "worktree",
					preset: "fixed",
				});
				expect(prepared.input.mode).toBe("checkout");
				expect(prepared.input.sameCheckout).toBe(true);
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
