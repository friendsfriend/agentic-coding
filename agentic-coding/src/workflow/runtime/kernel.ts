// The shared step-transition primitives used by migration, every reducer,
// and the engine's own start/dispatch paths: enqueueing an effect, applying
// a step's reduction, creating a run, entering a step, and transitioning
// across an edge. Also the small pure step-shape helpers these primitives
// need (freshStep, resolveArrivalContext) and the fusion-specific helpers
// (validateFusionRouting, fusionPlannerRoles, fusionDraftInputs) and
// round-cleanup helpers (stopRoundAgents, expireRuns, expireSiblingRuns).
// Grouped separately from engine.ts because migration.ts and every
// reducers/*.ts module need these without needing the WorkflowEngine class
// itself — importing engine.ts from either would close the cycle
// `engine.ts -> reducers/migration -> engine.ts`. Moved verbatim out of
// runtime.ts (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
	EffectKind,
	JsonValue as JsonValueType,
	WorkflowRouting,
	WorkflowRun,
	WorkflowSnapshot,
} from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	StepDefinition,
	WorkflowEdge,
	WorkflowRegistry,
} from "../registry.ts";
import { fusionPlannerRoles as stepFusionPlannerRoles } from "../steps/planning.ts";
import type {
	ArriveResult,
	StepArrivalPrior,
	StepBehavior,
} from "../steps/types.ts";
import { expireQuestions } from "./dialogue.ts";
import { wikiVerificationPayload } from "./evidence.ts";
import { json, nowIso, payload, runs as storeRuns } from "./store.ts";
import { wikiWorkflowDataRoot } from "./targets.ts";

export function enqueue(
	db: Database,
	snapshot: WorkflowSnapshot,
	kind: EffectKind,
	key: string,
	data: unknown,
): void {
	const id = randomUUID();
	db.query(
		"INSERT OR IGNORE INTO workflow_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		snapshot.workflowId,
		snapshot.revision + 1,
		kind,
		key,
		json(payload(data)),
		"pending",
		0,
		4,
		null,
		null,
		null,
		null,
	);
}

export function applyReduction(
	db: Database,
	snapshot: WorkflowSnapshot,
	step: Readonly<StepDefinition>,
	reduction: ReturnType<StepDefinition["reduce"]>,
): void {
	if (
		reduction.snapshot.workflowId !== snapshot.workflowId ||
		reduction.snapshot.revision !== snapshot.revision ||
		reduction.snapshot.currentStep !== snapshot.currentStep ||
		reduction.snapshot.definition.digest !== snapshot.definition.digest
	)
		throw new WorkflowRuntimeError(
			"reducer-contract",
			`step ${step.id} changed engine-owned identity`,
		);
	Object.assign(snapshot, structuredClone(reduction.snapshot));
	for (const effect of reduction.effects) {
		if (!step.allowedEffects.includes(effect.kind))
			throw new WorkflowRuntimeError(
				"reducer-contract",
				`step ${step.id} requested forbidden effect ${effect.kind}`,
			);
		enqueue(
			db,
			snapshot,
			effect.kind,
			effect.idempotencyKey,
			JSON.parse(JSON.stringify(effect.payload)) as JsonValueType,
		);
	}
}

export function createRun(
	db: Database,
	snapshot: WorkflowSnapshot,
	step: Readonly<StepDefinition>,
	role: string,
	now: () => Date,
): WorkflowRun {
	const id = randomUUID();
	const route =
		snapshot.routing.routes.find(
			(item) => item.stepId === step.id && item.role === role,
		) ??
		snapshot.routing.routes.find(
			(item) => item.stepId === step.id && !item.role,
		) ??
		snapshot.routing.routes.find(
			(item) => item.profile.name === snapshot.routing.defaultProfile,
		);
	if (!route)
		throw new WorkflowRuntimeError(
			"routing",
			`missing pinned route for ${step.id}/${role}`,
		);
	const directory =
		snapshot.definition.id === "wiki-comments"
			? path.join(wikiWorkflowDataRoot(), snapshot.workflowId, "runs")
			: path.join(
					snapshot.metadata.worktree,
					".herdr-workflow",
					snapshot.workflowId,
					"runs",
				);
	const assignmentPath = path.join(directory, `${id}.assignment.md`);
	const outputPath = path.join(directory, `${id}.output.json`);
	const expires = new Date(now().getTime() + 24 * 3600_000).toISOString();
	const created = nowIso(now);
	const allowedOutcomes: WorkflowRun["allowedOutcomes"] =
		snapshot.definition.id === "research" && step.id === "core.research"
			? ["blocked", "failed"]
			: ["complete", "blocked", "failed"];
	const run: WorkflowRun = {
		id,
		workflowId: snapshot.workflowId,
		stepId: step.id,
		role,
		generation: snapshot.step.attempt,
		attempt: snapshot.step.attempt,
		status: "pending",
		profile: route.profile,
		issuedRevision: snapshot.revision,
		allowedOutcomes,
		capabilityHash: "",
		capabilityExpiresAt: expires,
		assignmentPath,
		outputPath,
		outputSchema: { id: step.output.id, version: step.output.version },
		createdAt: created,
	};
	db.query(
		"INSERT INTO workflow_runs(id,workflow_id,step_id,role,generation,attempt,status,profile_json,issued_revision,allowed_outcomes_json,capability_hash,capability_expires_at,assignment_path,output_path,output_schema_id,output_schema_version,output_digest,handle_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		run.workflowId,
		run.stepId,
		role,
		run.generation,
		run.attempt,
		run.status,
		json(run.profile),
		run.issuedRevision,
		json(run.allowedOutcomes),
		"",
		expires,
		assignmentPath,
		outputPath,
		step.output.id,
		step.output.version,
		null,
		null,
		created,
		null,
	);
	snapshot.step.activeRunIds.push(id);
	enqueue(db, snapshot, "artifact.write", `run:${id}:assignment`, {
		runId: id,
	});
	enqueue(db, snapshot, "agent.launch", `run:${id}:launch`, { runId: id });
	return run;
}

export function freshStep(attempt: number): WorkflowSnapshot["step"] {
	return {
		attempt,
		activeRunIds: [],
		completedRunIds: [],
		selectedRoles: [],
		testRunStarted: false,
		results: [],
	};
}

/** Ordered context carry-over resolver (design D3): the `wiki-comments`
 * definition override beats a self-loop's preserved context, which beats the
 * output-carrying step list, which beats comments-into-wiki/archive, which
 * beats wiki-approval + complete -> wikiVerificationPayload. Steps opt into
 * the step-keyed rules via declared `StepBehavior` flags; the definition
 * override and the loop-shape rule are generic and stay here. */
export function resolveArrivalContext(
	behaviorFor: (stepId: string) => StepBehavior | undefined,
	definitionId: string,
	edge: WorkflowEdge,
	outcome: string,
	output: unknown,
	priorContext: JsonValueType | undefined,
	wikiVerification: () => JsonValueType,
): JsonValueType | undefined {
	const destination = behaviorFor(edge.to);
	const definitionOverride =
		definitionId === "wiki-comments" && priorContext !== undefined;
	const loopSelfEdge =
		!!edge.loop && priorContext !== undefined && edge.to === edge.from;
	const carriesOutput =
		output !== undefined && destination?.carriesOutputContext === true;
	const acceptsComments =
		destination?.acceptsCommentsContext === true && outcome === "comments";
	const producesWikiVerification =
		destination?.producesWikiVerificationContext === true &&
		outcome === "complete";
	if (
		!(
			definitionOverride ||
			loopSelfEdge ||
			carriesOutput ||
			acceptsComments ||
			producesWikiVerification
		)
	)
		return undefined;
	if (definitionOverride) return priorContext;
	if (producesWikiVerification) return wikiVerification();
	return output === undefined
		? priorContext
		: (JSON.parse(JSON.stringify(output)) as JsonValueType);
}

export function transition(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	outcome: string,
	output: unknown,
	registry: WorkflowRegistry,
	now: () => Date,
): void {
	const step = registry.step(snapshot.currentStep);
	applyReduction(
		db,
		snapshot,
		step,
		step.reduce(snapshot, { outcome, output }),
	);
	const edge = definition.edges.find(
		(item) => item.from === snapshot.currentStep && item.outcome === outcome,
	);
	if (!edge)
		throw new WorkflowRuntimeError(
			"illegal-outcome",
			`no ${outcome} transition from ${snapshot.currentStep}`,
		);
	const prior: StepArrivalPrior = {
		attempt: snapshot.step.attempt,
		results: snapshot.step.results,
		context: snapshot.step.context,
	};
	if (edge.loop) {
		const key = `${edge.from}:${edge.outcome}`;
		const attempts = (snapshot.loopCounts[key] ?? 0) + 1;
		snapshot.loopCounts[key] = attempts;
		if (attempts >= edge.loop.maxAttempts) {
			snapshot.status = "attention-required";
			snapshot.attention = [`retry limit reached at ${snapshot.currentStep}`];
			return;
		}
	}
	snapshot.currentStep = edge.to;
	snapshot.metadata.stepEnteredAt = nowIso(now);
	snapshot.step = freshStep(edge.loop ? prior.attempt + 1 : 1);
	const destination = registry.step(edge.to);
	const arrival: ArriveResult =
		destination.behavior?.onArrive?.({
			snapshot,
			edge,
			outcome,
			output,
			prior,
		}) ?? {};
	if (arrival.attempt !== undefined) snapshot.step.attempt = arrival.attempt;
	if (arrival.mode !== undefined) snapshot.step.mode = arrival.mode;
	if (arrival.results !== undefined) snapshot.step.results = arrival.results;
	if (arrival.selectedRoles !== undefined) {
		snapshot.step.selectedRoles = arrival.selectedRoles;
		if (!arrival.selectedRoles.length) snapshot.step.testRunStarted = true;
	}
	const context = resolveArrivalContext(
		(id) => registry.step(id).behavior,
		snapshot.definition.id,
		edge,
		outcome,
		output,
		prior.context,
		() => wikiVerificationPayload(snapshot),
	);
	if (context !== undefined) snapshot.step.context = context;
	snapshot.status = arrival.status ?? "active";
	for (const effect of edge.effects ?? [])
		enqueue(
			db,
			snapshot,
			effect.kind,
			`${snapshot.workflowId}:${effect.idempotencyKey}:${snapshot.revision}`,
			effect.kind === "wiki.verify"
				? snapshot.definition.id === "wiki-comments"
					? wikiVerificationPayload(snapshot)
					: (prior.context ?? wikiVerificationPayload(snapshot))
				: effect.payload,
		);
	enterStep(db, snapshot, definition, registry, now);
}

export function enterStep(
	db: Database,
	snapshot: WorkflowSnapshot,
	_definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
	now: () => Date,
): void {
	const step = registry.step(snapshot.currentStep);
	applyReduction(db, snapshot, step, step.enter(snapshot));
	const hasLiveRun = (role: string): boolean => {
		if (
			snapshot.step.results.some(
				(result) => result.role === role && result.outputDigest,
			)
		)
			return true;
		return snapshot.step.activeRunIds.some((id) => {
			const row = db
				.query("SELECT role FROM workflow_runs WHERE id=?")
				.get(id) as { role?: string } | undefined;
			return row?.role === role;
		});
	};
	const enqueueEffect = (
		kind: EffectKind,
		key: string,
		payload: JsonValueType,
	) => enqueue(db, snapshot, kind, key, payload);
	if (step.actor === "agent") {
		if (!step.behavior) throw new Error(`missing step behavior: ${step.id}`);
		if (!step.behavior.roles)
			throw new Error(`missing role behavior for agent step ${step.id}`);
		const roles = step.behavior.roles({ snapshot });
		const entry = step.behavior.onEnter?.({
			snapshot,
			enqueue: enqueueEffect,
			hasLiveRun,
		});
		const skip = new Set(entry?.skipRoles ?? []);
		for (const role of roles) {
			if (skip.has(role)) continue;
			createRun(db, snapshot, step, role, now);
		}
		return;
	}
	step.behavior?.onEnter?.({ snapshot, enqueue: enqueueEffect, hasLiveRun });
}

export function validateFusionRouting(
	definitionId: string,
	routing: WorkflowRouting,
): void {
	const plannerRoutes = routing.routes.filter(
		(route) => route.stepId === "fusion.plan",
	);
	const roles = plannerRoutes.map((route) => route.role);
	const resolvedRoles = fusionPlannerRoles(routing);
	const expected = Array.from(
		{ length: roles.length },
		(_, index) => `planner-${index + 1}`,
	);
	if (
		roles.length < 2 ||
		roles.length > 5 ||
		resolvedRoles.length !== roles.length ||
		!expected.every((role) => resolvedRoles.includes(role))
	)
		throw new WorkflowRuntimeError(
			"fusion-routing",
			`${definitionId} requires contiguous planner-1..planner-N routings`,
		);
	const digests = plannerRoutes.map((route) => route.profile.digest);
	if (new Set(digests).size !== digests.length)
		throw new WorkflowRuntimeError(
			"fusion-routing",
			`${definitionId} requires distinct planner profiles`,
		);
}
/** Ordered planner roles (planner-1..N) pinned in the snapshot's fusion routes.
 * The model list is start-time configuration: each planner-i route carries the
 * i-th profile, so retries and restarts re-resolve identically from the
 * recorded routes without extra snapshot schema. */
export function fusionPlannerRoles(routing: WorkflowRouting): string[] {
	return stepFusionPlannerRoles(routing);
}
/** Validated planner drafts in stable role order, deduplicated by role with
 * the latest digest winning (a repaired or retried role may re-submit). */
export function fusionDraftInputs(snapshot: WorkflowSnapshot): JsonValueType {
	const byRole = new Map<string, { path: string; digest: string }>();
	for (const item of snapshot.evidence) {
		const match = /^fusion\.plan:(planner-[1-5])$/.exec(item.kind);
		if (match?.[1])
			byRole.set(match[1], { path: item.path, digest: item.digest });
	}
	return fusionPlannerRoles(snapshot.routing)
		.filter((role) => byRole.has(role))
		.map((role) => ({
			role,
			path: byRole.get(role)?.path ?? "",
			digest: byRole.get(role)?.digest ?? "",
		}));
}

/**
 * Stops the agents for every core.triage/core.verification run that belongs
 * to the round transitioning away (pass/fix/limit). Runs within a round
 * complete individually as they finish, so by the time the round is over
 * their handles no longer live in activeRunIds; find them by shared round
 * attempt instead, mirroring the failed-path cleanup in expireSiblingRuns so
 * verifier/triage panes never outlive their round.
 */
export function stopRoundAgents(
	db: Database,
	snapshot: WorkflowSnapshot,
	attempt: number,
): void {
	const roundRuns = storeRuns(db, snapshot.workflowId).filter(
		(run) =>
			(run.stepId === "core.triage" || run.stepId === "core.verification") &&
			run.attempt === attempt &&
			run.handle,
	);
	for (const run of roundRuns)
		enqueue(
			db,
			snapshot,
			"agent.stop",
			`run:${run.id}:stop:${run.generation}`,
			{
				runId: run.id,
			},
		);
}
export function expireSiblingRuns(
	db: Database,
	snapshot: WorkflowSnapshot,
	now: () => Date,
): void {
	const siblings = storeRuns(db, snapshot.workflowId).filter((run) =>
		snapshot.step.activeRunIds.includes(run.id),
	);
	for (const run of siblings) {
		db.query(
			"UPDATE workflow_runs SET status='expired',capability_hash='',completed_at=? WHERE id=? AND status IN ('pending','working')",
		).run(nowIso(now), run.id);
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND json_extract(payload_json,'$.runId')=?",
		).run(snapshot.workflowId, run.id);
		if (run.handle)
			enqueue(
				db,
				snapshot,
				"agent.stop",
				`run:${run.id}:stop:${run.generation}`,
				{
					runId: run.id,
				},
			);
	}
	expireQuestions(
		snapshot,
		siblings.map((run) => run.id),
		now,
	);
	snapshot.step.activeRunIds = [];
}
export function expireRuns(
	db: Database,
	snapshot: WorkflowSnapshot,
	now: () => Date,
): void {
	const runIds = [...snapshot.step.activeRunIds];
	for (const id of runIds) {
		db.query(
			"UPDATE workflow_runs SET status='expired',capability_hash='',completed_at=? WHERE id=? AND status IN ('pending','working')",
		).run(nowIso(now), id);
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind IN ('artifact.write','agent.launch','agent.prompt') AND json_extract(payload_json,'$.runId')=?",
		).run(snapshot.workflowId, id);
	}
	if (snapshot.definition.id === "research")
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind='workspace.setup'",
		).run(snapshot.workflowId);
	expireQuestions(snapshot, runIds, now);
	snapshot.step.activeRunIds = [];
}
