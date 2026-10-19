// The env-setup family's registration and step behaviors
// (`add-environment-setup-workflow`, tasks 2.1-2.2): the graph's bounded loops,
// the pinned policy, and the effects each step enqueues.
import { describe, expect, test } from "bun:test";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import {
	definitionVersionForStagedRoot,
	effectiveFamilyTraits,
} from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions/registerBuiltins.ts";
import { outcomeForActionId } from "../src/workflow/runtime/reducers/developer-action.ts";
import {
	ENV_SETUP_APPROVE_ACTION,
	ENV_SETUP_REVIEW_ACTION,
	envSetupBehaviors,
} from "../src/workflow/steps/env-setup.ts";
import type { StepBehavior } from "../src/workflow/steps/types.ts";

/** One registered behavior, resolved once so the assertions below read the
 * step's hooks without an optional chain on every call. */
function behavior(stepId: string): StepBehavior {
	const entry = envSetupBehaviors[stepId];
	if (!entry) throw new Error(`missing ${stepId} behavior`);
	return entry;
}

const registry = registerBuiltins(undefined, 6);
const version = definitionVersionForStagedRoot(6);
const definition = registry.definition("env-setup", version);

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
	return {
		schemaVersion: 1,
		workflowId: "wf-env-1",
		revision: 3,
		definition: { id: "env-setup", version, digest: "d" },
		status: "active",
		currentStep: "setup.author",
		step: {
			attempt: 1,
			mode: "apply",
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles: [],
			testRunStarted: false,
			results: [],
		},
		metadata: {
			repository: "/repo/shop",
			worktree: "/repo/shop",
			changeId: "",
			branch: "main",
			baseBranch: "main",
			baseCommit: "",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			stepEnteredAt: "2026-01-01T00:00:00.000Z",
			app: "shop",
			setupDraftsDir: "/config/.drafts/env-setup/wf-env-1",
		},
		routing: { defaultProfile: "default", routes: [] },
		evidence: [],
		loopCounts: {},
		attention: [],
		developerDialogue: [],
		...overrides,
	} as WorkflowSnapshot;
}

describe("env-setup family registration", () => {
	test("the family is registered at the newest tier with its seven steps", () => {
		expect(definition?.id).toBe("env-setup");
		expect(definition?.steps).toEqual([
			"setup.author",
			"setup.validate",
			"setup.approval",
			"setup.promote",
			"setup.smoke",
			"setup.smoke.review",
			"setup.rollback",
			"core.completed",
			"core.closed",
		]);
		expect(definition?.initial).toBe("setup.author");
	});

	test("it runs against the repository checkout and requires a clean tree", () => {
		expect(definition?.policy?.checkoutRequired).toBe(true);
		expect(effectiveFamilyTraits(definition)?.startRequirements).toEqual([
			"clean-tree",
		]);
		expect(effectiveFamilyTraits(definition)?.delivery).toBe("none");
	});

	test("the validation failure loops back to the author, bounded to five rounds", () => {
		const edge = definition?.edges.find(
			(candidate) =>
				candidate.from === "setup.validate" && candidate.outcome === "failed",
		);
		expect(edge?.to).toBe("setup.author");
		expect(edge?.loop?.maxAttempts).toBe(5);
		const approval = definition?.edges.find(
			(candidate) =>
				candidate.from === "setup.approval" && candidate.outcome === "comments",
		);
		expect(approval?.to).toBe("setup.author");
	});

	test("only the author runs an agent, and its brief is the family's asset", () => {
		const agentSteps = (definition?.steps ?? []).filter(
			(stepId) => registry.step(stepId, 1).actor === "agent",
		);
		expect(agentSteps).toEqual(["setup.author"]);
		expect(
			behavior("setup.author").instructionAssetForRole?.({ role: "env-setup" }),
		).toBe("env-setup.md");
		expect(registry.step("setup.author", 1).instructionAssets).toContain(
			"env-setup.md",
		);
	});
});

describe("the post-promotion smoke check cannot run before approval", () => {
	/** Whether a step is reachable from the initial step without passing through
	 * `gate`: a breadth-first walk over the compiled edges. */
	const reachableWithout = (target: string, gate: string): boolean => {
		const edges = (definition?.edges ?? []) as ReadonlyArray<{
			from: string;
			to: string;
		}>;
		const seen = new Set<string>(["setup.author"]);
		const queue = ["setup.author"];
		while (queue.length > 0) {
			const step = queue.shift() as string;
			if (step === target) return true;
			for (const edge of edges) {
				if (edge.from !== step) continue;
				if (edge.to === gate || seen.has(edge.to)) continue;
				seen.add(edge.to);
				queue.push(edge.to);
			}
		}
		return false;
	};

	test("the smoke step is only reachable through the approval edge", () => {
		const edges = (definition?.edges ?? []) as ReadonlyArray<{
			from: string;
			to: string;
			outcome: string;
		}>;
		const intoSmoke = edges.filter((edge) => edge.to === "setup.smoke");
		expect(intoSmoke.map((edge) => `${edge.from}:${edge.outcome}`)).toEqual([
			"setup.promote:complete",
		]);
		const intoPromote = edges.filter((edge) => edge.to === "setup.promote");
		expect(
			intoPromote.map((edge) => `${edge.from}:${edge.outcome}`).sort(),
		).toEqual(["setup.approval:approve", "setup.promote:failed"]);
		// And the walk agrees: without passing through the developer gate the
		// smoke step (and the rollback behind it) is unreachable.
		expect(reachableWithout("setup.smoke", "setup.approval")).toBe(false);
		expect(reachableWithout("setup.rollback", "setup.approval")).toBe(false);
	});

	test("the smoke review offers rollback and keep, and both map to a declared outcome", () => {
		const step = definition?.steps.includes("setup.smoke.review");
		expect(step).toBe(true);
		const actions = behavior("setup.smoke.review").developerActions?.(
			{} as never,
		);
		const ids = (actions ?? []).map((action) => action.id);
		expect(ids).toEqual(["rollback-promotion", "accept-smoke-failure"]);
		for (const id of ids) expect(outcomeForActionId(id)).toBe(id);
	});
});

describe("env-setup step behaviors", () => {
	test("the author brackets its turn with the write guard and starts only after it", () => {
		const enqueued: Array<{ kind: string; payload: unknown }> = [];
		const entry = behavior("setup.author").onEnter?.({
			snapshot: snapshot(),
			enqueue: (kind, _key, payload) => {
				enqueued.push({ kind, payload });
			},
			hasLiveRun: () => false,
		});
		// The run is withheld: an author process that could start before the
		// baseline exists could write before the fingerprint that catches it. The
		// baseline's completion launches it.
		expect(entry?.skipRoles).toEqual(["env-setup"]);
		// The staged configuration root is materialized first, then the baseline:
		// the author must write into a complete copy of the live configuration
		// (`staged-env-setup-config-root`), and the baseline is still taken before
		// the first author turn.
		expect(enqueued.map((effect) => effect.kind)).toEqual([
			"environment.setup-stage",
			"environment.setup-guard",
		]);
		const guard = enqueued[1];
		if (!guard) throw new Error("the author enqueued no guard effect");
		expect(guard.kind).toBe("environment.setup-guard");
		expect((guard.payload as { phase?: string }).phase).toBe("baseline");
		expect((guard.payload as { draftsDir?: string }).draftsDir).toBe(
			"/config/.drafts/env-setup/wf-env-1",
		);

		const completion = behavior("setup.author").onAgentComplete?.({
			snapshot: snapshot(),
			definitionId: "env-setup",
			hasStep: () => false,
			run: { id: "run-1", role: "env-setup", stepId: "setup.author" },
			outcome: "complete",
			remainingActiveRunIds: [],
			evidence: [],
		});
		expect(completion?.deferTransition).toBe(true);
		expect(completion?.transition).toBeUndefined();
		const check = completion?.effects?.[0];
		if (!check) throw new Error("the author handoff enqueued no guard effect");
		expect(check.kind).toBe("environment.setup-guard");
		expect((check.payload as { phase?: string }).phase).toBe("check");

		// The armed baseline is what releases the author's run.
		const launched = behavior("setup.author").onEffectComplete?.({
			definitionId: "workflow",
			snapshot: snapshot(),
			effect: {
				kind: "environment.setup-guard",
				payload: { phase: "baseline" } as never,
				data: { phase: "baseline", armed: true },
			},
		});
		expect(launched?.runs).toEqual([{ role: "env-setup" }]);
		expect(launched?.transition).toBeUndefined();

		// A failed guard check never reaches this hook: the effect fails
		// permanently and the workflow parks in attention-required. A completed
		// check is what lets the author hand off to validation.
		const afterGuard = behavior("setup.author").onEffectComplete?.({
			definitionId: "workflow",
			snapshot: snapshot(),
			effect: {
				kind: "environment.setup-guard",
				payload: { phase: "check" } as never,
			},
		});
		expect(afterGuard?.transition).toEqual({ outcome: "complete" });
	});

	test("validation enqueues the gate and reports its verdict", () => {
		const enqueued: Array<{ kind: string; payload: unknown }> = [];
		behavior("setup.validate").onEnter?.({
			snapshot: snapshot(),
			enqueue: (kind, _key, payload) => {
				enqueued.push({ kind, payload });
			},
			hasLiveRun: () => false,
		});
		const gate = enqueued[0];
		if (!gate) throw new Error("validation enqueued no effect");
		expect(gate.kind).toBe("environment.validate");
		expect((gate.payload as { app?: string }).app).toBe("shop");

		const failed = behavior("setup.validate").onEffectComplete?.({
			definitionId: "workflow",
			snapshot: snapshot(),
			effect: {
				kind: "environment.validate",
				payload: {} as never,
				data: { ok: false, findings: [{ check: "port-collision" }] },
			},
		});
		expect(failed?.transition?.outcome).toBe("failed");
		expect(failed?.transition?.output).toEqual({
			ok: false,
			findings: [{ check: "port-collision" }],
		});

		const passed = behavior("setup.validate").onEffectComplete?.({
			definitionId: "workflow",
			snapshot: snapshot(),
			effect: {
				kind: "environment.validate",
				payload: {} as never,
				data: { ok: true, findings: [] },
			},
		});
		expect(passed?.transition?.outcome).toBe("complete");
	});

	test("the approval gate offers approve and the shared review action", () => {
		const actions = behavior("setup.approval").developerActions?.({
			snapshot: snapshot(),
		});
		expect(actions?.map((action) => action.id)).toEqual([
			ENV_SETUP_APPROVE_ACTION,
			ENV_SETUP_REVIEW_ACTION,
		]);
	});

	test("promotion checks the write guard first, then enqueues the promotion", () => {
		const enqueued: Array<{ kind: string; payload: unknown }> = [];
		behavior("setup.promote").onEnter?.({
			snapshot: snapshot(),
			enqueue: (kind, _key, payload) => {
				enqueued.push({ kind, payload });
			},
			hasLiveRun: () => false,
		});
		// The approved diff belongs to a configuration that must still be the one
		// on disk, so the guard's check runs before anything is written.
		expect(enqueued.map((entry) => entry.kind)).toEqual([
			"environment.setup-guard",
		]);
		const guard = enqueued[0];
		if (!guard) throw new Error("promotion enqueued no guard effect");
		expect((guard.payload as { phase?: string }).phase).toBe("check");

		// Only a clean check enqueues the promotion.
		const afterGuard = behavior("setup.promote").onEffectComplete?.({
			definitionId: "workflow",
			snapshot: snapshot(),
			effect: {
				kind: "environment.setup-guard",
				payload: { phase: "check" } as never,
				data: { phase: "check", ok: true },
			},
		});
		expect(afterGuard?.transition).toBeUndefined();
		expect(afterGuard?.effects?.map((entry) => entry.kind)).toEqual([
			"environment.promote",
		]);

		// A rolled-back promotion is a failure the graph retries, never a
		// completed step that published nothing.
		const rolledBack = behavior("setup.promote").onEffectComplete?.({
			definitionId: "workflow",
			snapshot: snapshot(),
			effect: {
				kind: "environment.promote",
				payload: {} as never,
				data: { ok: false, rolledBack: true },
			},
		});
		expect(rolledBack?.transition?.outcome).toBe("failed");
		const promoted = behavior("setup.promote").onEffectComplete?.({
			definitionId: "workflow",
			snapshot: snapshot(),
			effect: {
				kind: "environment.promote",
				payload: {} as never,
				data: { ok: true, draftsMoved: true },
			},
		});
		expect(promoted?.transition?.outcome).toBe("complete");
	});

	test("every action a developer step offers maps onto an outcome it declares", () => {
		// The check that catches an approval action whose outcome the graph never
		// accepts: the reducer maps the id, and the step's own outcome list must
		// contain the result.
		const builtins = registerBuiltins(undefined, 6);
		const checked: string[] = [];
		for (const entry of builtins.definitions()) {
			for (const stepId of entry.steps) {
				const step = builtins.stepForDefinition(entry, stepId);
				if (step.actor !== "developer") continue;
				const actions = step.behavior?.developerActions?.({
					snapshot: snapshot(),
				});
				for (const action of actions ?? []) {
					checked.push(`${stepId}:${action.id}`);
					expect(step.outcomes.includes(outcomeForActionId(action.id))).toBe(
						true,
					);
				}
			}
		}
		// The env-setup gate is one of the steps this covers.
		expect(checked).toContain("setup.approval:approve-setup");
	});

	test("the effect legality table allows every enqueued effect", () => {
		// The engine's own effect validation reads `allowedEffects`; a step that
		// enqueues an effect it does not declare is refused at transition time.
		expect(registry.step("setup.author", 1).allowedEffects).toContain(
			"environment.setup-guard",
		);
		expect(registry.step("setup.validate", 1).allowedEffects).toEqual([
			"environment.validate",
		]);
		expect(registry.step("setup.promote", 1).allowedEffects).toEqual([
			"environment.setup-guard",
			"environment.promote",
		]);
	});
});
