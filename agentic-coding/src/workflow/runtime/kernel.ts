// The shared step-transition primitives used by every reducer and by the
// engine's own start/dispatch paths: enqueueing an effect, applying
// a step's reduction, creating a run, entering a step, and transitioning
// across an edge. Also the small pure step-shape helpers these primitives
// need (freshStep, resolveArrivalContext) and the fusion-specific helpers
// (validateFusionRouting, fusionPlannerRoles, fusionDraftInputs) and
// run-expiry helpers (expireRuns, expireSiblingRuns).
// Grouped separately from engine.ts because every reducers/*.ts module needs
// these without needing the WorkflowEngine class itself — importing engine.ts
// from a reducer would close the cycle `engine.ts -> reducers/* ->
// engine.ts`. Moved verbatim out of runtime.ts (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
	DeveloperDialogueRecord,
	EffectKind,
	JsonValue as JsonValueType,
	WorkflowRouting,
	WorkflowRun,
	WorkflowSnapshot,
} from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import { redactTelemetryText } from "../observability.ts";
import type {
	CompiledWorkflowDefinition,
	StepDefinition,
	WorkflowEdge,
	WorkflowRegistry,
} from "../registry.ts";
import { DEBUG_ROLE } from "../steps/debug.ts";
import { fusionPlannerRoles as stepFusionPlannerRoles } from "../steps/planning.ts";
import { STEP_ROUTES } from "../steps/routing.ts";
import type {
	ArriveResult,
	CompletionResult,
	StepArrivalPrior,
	StepBehavior,
} from "../steps/types.ts";
import { DEBUG_INVESTIGATE_STEP } from "./debug-requests.ts";
import { answeredQuestionRecord, expireQuestions } from "./dialogue.ts";
import { wikiVerificationPayload } from "./evidence.ts";
import {
	ACTIVE_RUN,
	json,
	nowIso,
	payload,
	runs as storeRuns,
} from "./store.ts";
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

function completionJson(value: unknown, label: string): JsonValueType {
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValueType;
	} catch {
		throw new WorkflowRuntimeError("reducer-contract", `${label} must be JSON`);
	}
}

/** Merge a completion's re-verification record into the snapshot, field by
 * field: the runtime stamps the baseline and the delta while a step records the
 * plan and the decision, so a spread of the whole record would let one writer
 * erase the other's work. Every field is shape-checked at this boundary like the
 * other completion fields, so a malformed record is a reducer-contract failure
 * rather than a snapshot that later widens for the wrong reason. */
function applyVerificationScope(
	snapshot: WorkflowSnapshot,
	record: CompletionResult["verificationScope"],
): void {
	if (record === undefined) return;
	if (!record || typeof record !== "object" || Array.isArray(record))
		throw scopeProblem("verification scope");
	const scope = record as Record<string, unknown>;
	const problems = [
		...(scope.round === undefined || isCount(scope.round)
			? []
			: [scopeProblem("verification scope round")]),
		...planProblems(scope.plan),
		...reportedProblems(scope.reported),
		...baselineProblems("baseline", scope.baseline),
		...baselineProblems("delta", scope.delta),
		...decisionProblems(scope.decision),
	];
	const first = problems[0];
	if (first) throw first;
	const merged: NonNullable<WorkflowSnapshot["verificationScope"]> = {
		...(snapshot.verificationScope ?? {}),
	};
	if (scope.round !== undefined) merged.round = scope.round as number;
	if (scope.plan !== undefined)
		merged.plan = scope.plan as NonNullable<typeof merged.plan>;
	if (scope.reported !== undefined)
		merged.reported = scope.reported as NonNullable<typeof merged.reported>;
	if (scope.baseline !== undefined)
		merged.baseline = scope.baseline as NonNullable<typeof merged.baseline>;
	if (scope.delta !== undefined)
		merged.delta = scope.delta as NonNullable<typeof merged.delta>;
	if (scope.decision !== undefined)
		merged.decision = scope.decision as NonNullable<typeof merged.decision>;
	snapshot.verificationScope = merged;
}

function scopeProblem(detail: string): WorkflowRuntimeError {
	return new WorkflowRuntimeError("reducer-contract", `invalid ${detail}`);
}

function isCount(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isTextList(value: unknown): boolean {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isRoleList(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	for (const item of value) {
		if (!item || typeof item !== "object") return false;
		if (typeof (item as { role?: unknown }).role !== "string") return false;
		if (typeof (item as { reason?: unknown }).reason !== "string") return false;
	}
	return true;
}

function reportedProblems(reported: unknown): WorkflowRuntimeError[] {
	if (reported === undefined) return [];
	if (!reported || typeof reported !== "object" || Array.isArray(reported))
		return [scopeProblem("verification scope reported roles")];
	const shaped = reported as { round?: unknown; roles?: unknown };
	return [
		...(isCount(shaped.round)
			? []
			: [scopeProblem("verification scope reported round")]),
		...(isTextList(shaped.roles)
			? []
			: [scopeProblem("verification scope reported roles")]),
	];
}

function planProblems(plan: unknown): WorkflowRuntimeError[] {
	if (plan === undefined) return [];
	if (!Array.isArray(plan)) return [scopeProblem("verification scope plan")];
	const problems: WorkflowRuntimeError[] = [];
	for (const entry of plan) {
		if (!entry || typeof entry !== "object") {
			problems.push(scopeProblem("verification scope plan entry"));
			continue;
		}
		const shaped = entry as { role?: unknown; files?: unknown };
		if (typeof shaped.role !== "string")
			problems.push(scopeProblem("verification scope plan role"));
		if (!isTextList(shaped.files))
			problems.push(scopeProblem("verification scope plan files"));
	}
	return problems;
}

function baselineProblems(
	key: "baseline" | "delta",
	value: unknown,
): WorkflowRuntimeError[] {
	if (value === undefined) return [];
	if (!value || typeof value !== "object" || Array.isArray(value))
		return [scopeProblem(`verification scope ${key}`)];
	const shaped = value as {
		round?: unknown;
		complete?: unknown;
		files?: unknown;
		threshold?: unknown;
	};
	const problems: WorkflowRuntimeError[] = [];
	if (!isCount(shaped.round))
		problems.push(scopeProblem(`verification scope ${key} round`));
	if (typeof shaped.complete !== "boolean")
		problems.push(scopeProblem(`verification scope ${key} flag`));
	if (!Array.isArray(shaped.files))
		problems.push(scopeProblem(`verification scope ${key} files`));
	if (key === "delta" && !isCount(shaped.threshold))
		problems.push(scopeProblem("verification scope threshold"));
	return problems;
}

function decisionProblems(decision: unknown): WorkflowRuntimeError[] {
	if (decision === undefined) return [];
	if (!decision || typeof decision !== "object" || Array.isArray(decision))
		return [scopeProblem("verification scope decision")];
	const shaped = decision as Record<string, unknown>;
	const problems: WorkflowRuntimeError[] = [];
	for (const key of [
		"round",
		"threshold",
		"touched",
		"changed",
		"baselineCount",
	])
		if (!isCount(shaped[key]))
			problems.push(scopeProblem(`verification scope decision ${key}`));
	if (typeof shaped.mode !== "string")
		problems.push(scopeProblem("verification scope decision mode"));
	if (typeof shaped.reason !== "string")
		problems.push(scopeProblem("verification scope decision reason"));
	if (!isRoleList(shaped.rerun))
		problems.push(scopeProblem("verification scope decision rerun"));
	if (!isRoleList(shaped.skipped))
		problems.push(scopeProblem("verification scope decision skipped"));
	return problems;
}

/** Append a completion's attention entries to the workflow's own list, with the
 * same redaction the handoff's `blocked` path applies: a step's wording is the
 * workflow's record, so a credential shape an agent echoed can never reach it. */
function appendAttention(
	snapshot: WorkflowSnapshot,
	entries: CompletionResult["attention"],
): void {
	if (entries === undefined) return;
	if (
		!Array.isArray(entries) ||
		entries.some((entry) => typeof entry !== "string")
	)
		throw new WorkflowRuntimeError(
			"reducer-contract",
			"invalid attention entry",
		);
	if (!entries.length) return;
	snapshot.attention = [
		...(snapshot.attention ?? []),
		...entries.map((entry) => redactTelemetryText(entry)),
	];
}

export function applyCompletionResult(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	step: Readonly<StepDefinition>,
	result: CompletionResult | undefined,
	registry: WorkflowRegistry,
	now: () => Date,
): void {
	if (!result) return;
	if (typeof result !== "object" || Array.isArray(result))
		throw new WorkflowRuntimeError(
			"reducer-contract",
			"invalid completion result",
		);
	if (
		(result.deferTransition !== undefined &&
			typeof result.deferTransition !== "boolean") ||
		(result.runs !== undefined && !Array.isArray(result.runs)) ||
		(result.effects !== undefined && !Array.isArray(result.effects))
	)
		throw new WorkflowRuntimeError(
			"reducer-contract",
			"invalid completion fields",
		);
	if (result.metadata?.changeId !== undefined) {
		if (typeof result.metadata.changeId !== "string")
			throw new WorkflowRuntimeError("reducer-contract", "invalid change ID");
		snapshot.metadata.changeId = result.metadata.changeId;
	}
	if (result.metadata?.stageTestReportMarkdown !== undefined) {
		if (typeof result.metadata.stageTestReportMarkdown !== "string")
			throw new WorkflowRuntimeError(
				"reducer-contract",
				"invalid stageTestReportMarkdown",
			);
		snapshot.metadata.stageTestReportMarkdown =
			result.metadata.stageTestReportMarkdown;
	}
	for (const key of [
		"stageTestPlan",
		"stageTestReport",
		"stagePlanBlocks",
		"stageReplay",
		"stageReplayHeal",
	] as const) {
		const value = result.metadata?.[key];
		if (value !== undefined) {
			try {
				snapshot.metadata[key] = JSON.parse(JSON.stringify(value)) as never;
			} catch {
				throw new WorkflowRuntimeError("reducer-contract", `invalid ${key}`);
			}
		}
	}
	if (result.step) {
		if (
			(result.step.selectedRoles !== undefined &&
				!Array.isArray(result.step.selectedRoles)) ||
			(result.step.appendResults !== undefined &&
				!Array.isArray(result.step.appendResults))
		)
			throw new WorkflowRuntimeError(
				"reducer-contract",
				"invalid step updates",
			);
		if (result.step.selectedRoles !== undefined) {
			if (
				result.step.selectedRoles.some((role) => typeof role !== "string") ||
				new Set(result.step.selectedRoles).size !==
					result.step.selectedRoles.length
			)
				throw new WorkflowRuntimeError(
					"reducer-contract",
					"invalid selected roles",
				);
			const destination = definition.edges.find(
				(edge) =>
					edge.from === snapshot.currentStep &&
					edge.outcome === (result.transition?.outcome ?? "complete"),
			)?.to;
			if (!destination)
				throw new WorkflowRuntimeError(
					"reducer-contract",
					"selected roles require a completion destination",
				);
			// A per-step routing step owns no roles of its own: a selection that
			// lands on one belongs to the agent step that route step selects a
			// model for, which is also where the candidate catalog and the pinned
			// routes are keyed (classifier-driven-step-model-selection). Reading
			// the raw edge destination here rejected every real triage plan once
			// the route step sat between triage and verification.
			const roleStep = STEP_ROUTES[destination]?.target ?? destination;
			const destinationStep = registry.stepForDefinition(definition, roleStep);
			const candidates = destinationStep.behavior?.candidateRoles?.({
				definitionId: definition.id,
				traits: effectiveFamilyTraits(definition),
				fusionPlannerCount: snapshot.routing.routes.filter(
					(route) => route.stepId === "fusion.plan",
				).length,
			});
			for (const role of result.step.selectedRoles) {
				if (
					!candidates?.includes(role) ||
					!snapshot.routing.routes.some(
						(route) =>
							route.stepId === roleStep &&
							(route.role === role || route.role === undefined),
					)
				)
					throw new WorkflowRuntimeError(
						"reducer-contract",
						`selected role is not a pinned ${roleStep} route: ${role}`,
					);
			}
			snapshot.step.selectedRoles = [...result.step.selectedRoles];
		}
		if (result.step.testRunStarted !== undefined) {
			if (typeof result.step.testRunStarted !== "boolean")
				throw new WorkflowRuntimeError(
					"reducer-contract",
					"invalid test-run flag",
				);
			snapshot.step.testRunStarted = result.step.testRunStarted;
		}
		for (const entry of result.step.appendResults ?? []) {
			if (
				typeof entry.runId !== "string" ||
				typeof entry.role !== "string" ||
				!Number.isInteger(entry.critical) ||
				(entry.outputDigest !== undefined &&
					typeof entry.outputDigest !== "string")
			)
				throw new WorkflowRuntimeError(
					"reducer-contract",
					"invalid step result",
				);
			snapshot.step.results.push({ ...entry });
		}
	}
	const transitionRequest = result.transition;
	if (transitionRequest) {
		if (typeof transitionRequest.outcome !== "string")
			throw new WorkflowRuntimeError("reducer-contract", "invalid transition");
		if (transitionRequest.output !== undefined)
			completionJson(transitionRequest.output, "transition output");
		if (
			!definition.edges.some(
				(edge) =>
					edge.from === snapshot.currentStep &&
					edge.outcome === transitionRequest.outcome,
			)
		)
			throw new WorkflowRuntimeError(
				"reducer-contract",
				`illegal transition from ${snapshot.currentStep}: ${transitionRequest.outcome}`,
			);
	}
	const candidateRoles = step.behavior?.candidateRoles?.({
		definitionId: definition.id,
		traits: effectiveFamilyTraits(definition),
		fusionPlannerCount: snapshot.routing.routes.filter(
			(route) => route.stepId === "fusion.plan",
		).length,
	});
	for (const request of result.runs ?? []) {
		if (
			step.actor !== "agent" ||
			typeof request.role !== "string" ||
			(candidateRoles && !candidateRoles.includes(request.role))
		)
			throw new WorkflowRuntimeError("reducer-contract", "invalid run request");
	}
	for (const effect of result.effects ?? []) {
		if (
			!step.allowedEffects.includes(effect.kind) ||
			typeof effect.idempotencyKey !== "string"
		)
			throw new WorkflowRuntimeError(
				"reducer-contract",
				"invalid effect request",
			);
		completionJson(effect.payload, "effect payload");
	}
	for (const request of result.runs ?? [])
		createRun(db, snapshot, step, request.role, now);
	for (const effect of result.effects ?? [])
		enqueue(db, snapshot, effect.kind, effect.idempotencyKey, effect.payload);
	applyVerificationScope(snapshot, result.verificationScope);
	appendAttention(snapshot, result.attention);
	if (transitionRequest)
		transition(
			db,
			snapshot,
			definition,
			transitionRequest.outcome,
			transitionRequest.output,
			registry,
			now,
		);
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
		snapshot.definition.id === "wiki-comments" ||
		snapshot.definition.id === "stage-test"
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

/** Create one delegated debug request's side run
 * (add-debug-subagent-requests).
 *
 * The run belongs to the caller's workflow — so it shares the workflow's
 * environment owner and app holds — but it is deliberately **outside**
 * `snapshot.step.activeRunIds`: it runs the `debug` family's investigation step
 * under the `debug` role in the caller's own worktree, and no step transition,
 * sibling expiry or step reducer may touch it. Its profile is the requesting
 * run's, because the caller's routing table pins no `debug` route. */
export function createDebugRequestRun(
	db: Database,
	snapshot: WorkflowSnapshot,
	callerRun: Pick<WorkflowRun, "profile">,
	outputSchema: { readonly id: string; readonly version: number },
	now: () => Date,
): WorkflowRun {
	const id = randomUUID();
	const directory = path.join(
		snapshot.metadata.worktree,
		".herdr-workflow",
		snapshot.workflowId,
		"runs",
	);
	const assignmentPath = path.join(directory, `${id}.assignment.md`);
	const outputPath = path.join(directory, `${id}.output.json`);
	const expires = new Date(now().getTime() + 24 * 3600_000).toISOString();
	const created = nowIso(now);
	const run: WorkflowRun = {
		id,
		workflowId: snapshot.workflowId,
		stepId: DEBUG_INVESTIGATE_STEP,
		role: DEBUG_ROLE,
		// The delegated run opens its own conversation, so its first round is
		// generation 1: the assignment carries the full protocol and role brief.
		generation: 1,
		attempt: 1,
		status: "pending",
		profile: callerRun.profile,
		issuedRevision: snapshot.revision,
		allowedOutcomes: ["complete", "blocked", "failed"],
		capabilityHash: "",
		capabilityExpiresAt: expires,
		assignmentPath,
		outputPath,
		outputSchema: { id: outputSchema.id, version: outputSchema.version },
		createdAt: created,
	};
	db.query(
		"INSERT INTO workflow_runs(id,workflow_id,step_id,role,generation,attempt,status,profile_json,issued_revision,allowed_outcomes_json,capability_hash,capability_expires_at,assignment_path,output_path,output_schema_id,output_schema_version,output_digest,handle_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		run.id,
		run.workflowId,
		run.stepId,
		run.role,
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
		outputSchema.id,
		outputSchema.version,
		null,
		null,
		created,
		null,
	);
	return run;
}

/** Re-issue the run that asked a question once its answer is recorded
 * (make-developer-questions-asynchronous): the tool call that asked is gone by
 * then, so the answer reaches its run through the new attempt's prior-dialogue
 * context. Only the asking role is re-issued — a sibling run that already
 * completed is untouched — and only when the workflow is parked on that very
 * run: the question's step is the current step, its run handed off `blocked`,
 * and no other run of the role is active. Returns the resumed run, or
 * `undefined` when the state is not a parked asker (already resumed, still
 * working, moved on, paused, or terminal). */
export function resumeBlockedAsker(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
	question: Pick<DeveloperDialogueRecord, "runId" | "stepId" | "role">,
	now: () => Date,
): WorkflowRun | undefined {
	if (
		snapshot.status === "paused" ||
		snapshot.status === "completed" ||
		snapshot.status === "closed"
	)
		return undefined;
	if (question.stepId !== snapshot.currentStep) return undefined;
	if (!snapshot.step.completedRunIds.includes(question.runId)) return undefined;
	const runList = storeRuns(db, snapshot.workflowId);
	const asker = runList.find((run) => run.id === question.runId);
	if (asker?.status !== "blocked") return undefined;
	if (
		runList.some(
			(run) => run.role === question.role && ACTIVE_RUN.has(run.status),
		)
	)
		return undefined;
	const step = registry.stepForDefinition(definition, snapshot.currentStep);
	snapshot.step.attempt += 1;
	const resumed = createRun(db, snapshot, step, question.role, now);
	// Resume the workflow only when nothing else is parked: a second blocked run
	// keeps the workflow at `attention-required` for its own question.
	if (!runList.some((run) => run.id !== asker.id && run.status === "blocked")) {
		snapshot.status = "active";
		snapshot.attention = [];
	}
	return resumed;
}

/** Resume the asking run when an answer event names an answered record; the
 * developer path and the peer path return the same shape under their own event
 * type. Returns the event unchanged when no parked run matches the record, and
 * adds the resumed run id to the event data when one does. */
export function resumeAskerAfterAnswer(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
	event: { type: string; actor: unknown; data: unknown },
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	if (
		event.type !== "developer.question.answered" &&
		event.type !== "agent.question.answered"
	)
		return event;
	const answered = answeredQuestionRecord(snapshot, event.data);
	if (!answered) return event;
	// A `stage_login` hand-off record is answered by the developer so the browser
	// session can continue; it never resumes a parked run
	// (add-stage-interactive-login).
	if (answered.kind === "login-handoff") return event;
	const resumed = resumeBlockedAsker(
		db,
		snapshot,
		definition,
		registry,
		answered,
		now,
	);
	if (!resumed) return event;
	return {
		...event,
		data: {
			...(event.data as Record<string, unknown>),
			resumedRunId: resumed.id,
		},
	};
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
	const step = registry.stepForDefinition(definition, snapshot.currentStep);
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
	const destination = registry.stepForDefinition(definition, edge.to);
	const arrival: ArriveResult =
		destination.behavior?.onArrive?.({
			snapshot,
			traits: effectiveFamilyTraits(definition),
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
		(id) => registry.stepForDefinition(definition, id).behavior,
		snapshot.definition.id,
		edge,
		outcome,
		output,
		prior.context,
		() => wikiVerificationPayload(snapshot),
	);
	if (context !== undefined) snapshot.step.context = context;
	snapshot.status = arrival.status ?? "active";
	const enqueueEdgeEffects = () => {
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
	};
	// Start destination agents before unrelated transition effects. In archive
	// flows, wiki.verify can involve Git I/O; it must not hide archive launch
	// behind that potentially slow operation.
	if (destination.actor === "agent") {
		enterStep(db, snapshot, definition, registry, now);
		enqueueEdgeEffects();
	} else {
		enqueueEdgeEffects();
		enterStep(db, snapshot, definition, registry, now);
	}
}

export function enterStep(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
	now: () => Date,
): void {
	const step = registry.stepForDefinition(definition, snapshot.currentStep);
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
	const traits = effectiveFamilyTraits(definition);
	if (step.actor === "agent") {
		if (!step.behavior) throw new Error(`missing step behavior: ${step.id}`);
		if (!step.behavior.roles)
			throw new Error(`missing role behavior for agent step ${step.id}`);
		const roles = step.behavior.roles({ snapshot, traits });
		const entry = step.behavior.onEnter?.({
			snapshot,
			traits,
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
	step.behavior?.onEnter?.({
		snapshot,
		traits,
		enqueue: enqueueEffect,
		hasLiveRun,
	});
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
			"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND json_extract(payload_json,'$.runId')=?",
		).run(snapshot.workflowId, run.id);
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
	preserveRunningLaunches = false,
): void {
	const runIds = [...snapshot.step.activeRunIds];
	for (const id of runIds) {
		db.query(
			"UPDATE workflow_runs SET status='expired',capability_hash='',completed_at=? WHERE id=? AND status IN ('pending','working')",
		).run(nowIso(now), id);
		// A preset switch must retain a claimed launch row until its runner sees
		// cancellation, so its stop barrier cannot race adapter.launch.
		if (preserveRunningLaunches)
			db.query(
				"UPDATE workflow_outbox SET payload_json=json_set(payload_json,'$.cancelRequested',1) WHERE workflow_id=? AND status='running' AND kind='agent.launch' AND json_extract(payload_json,'$.runId')=?",
			).run(snapshot.workflowId, id);
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind IN ('artifact.write','agent.prompt') AND json_extract(payload_json,'$.runId')=?",
		).run(snapshot.workflowId, id);
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry') AND kind='agent.launch' AND json_extract(payload_json,'$.runId')=?",
		).run(snapshot.workflowId, id);
	}
	if (snapshot.definition.id === "research")
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind='workspace.setup'",
		).run(snapshot.workflowId);
	expireQuestions(snapshot, runIds, now);
	snapshot.step.activeRunIds = [];
}
