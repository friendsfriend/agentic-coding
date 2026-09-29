// The `effect.result` reducer: applies an effect-runner outcome to its
// outbox row and delegates step-owned effect completion decisions to the
// registered behavior. Workspace setup/close and cleanup remain runtime-wide
// lifecycle mechanics.
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
	CLASSIFIER_DECISION_CONTENT_MAX_BYTES,
	CLASSIFIER_DECISION_INPUT_MAX_BYTES,
	CLASSIFIER_DECISION_MAX_RECORDS,
	type ClassifierDecisionRecord,
	GATE_DECISION_CONTENT_MAX_BYTES,
	GATE_DECISION_MAX_RECORDS,
	type GateDecisionRecord,
	type JsonValue,
	type WorkflowCommand,
	type WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import {
	APPLY_PHASE_STEPS,
	buildRoutingDecisionSummary,
	type ClassifierAnswer,
	GATE_INTEGRATION,
	PLAN_PHASE_STEPS,
	parseClassifierAnswer,
	ROUTING_INTEGRATION,
	type RoutingDecisionSummary,
	selectRosterEntries,
	selectSingleEntry,
	TRIAGE_INTEGRATION,
} from "../../classifiers.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { loadConfigWithProvenance } from "../../effects.ts";
import {
	type AgentsConfig,
	applyFusionRoster,
	applyRoutingSelections,
	type CategorySelection,
	enforceReadOnlySteps,
	parseAgentsConfig,
	poolEntries,
	preflightProfile,
	resolvePreset,
} from "../../profiles.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import {
	applyCompletionResult,
	enqueue,
	enterStep,
	validateFusionRouting,
} from "../kernel.ts";
import { boundedError, type EffectRow, json, nowIso } from "../store.ts";

/** Apply the answered pool selections to the pinned routing. Every single
 * selection replaces every route of its step (one verification pool covers all
 * verifier roles); a fusion roster recomputes `planner-1..N`. Failures keep the
 * tagged-default routing and record attention rather than stranding the run. */
export function applyClassifierRouting(
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
	data: unknown,
	now: () => Date = () => new Date(),
): RoutingDecisionSummary | undefined {
	try {
		const payload =
			data && typeof data === "object"
				? (data as {
						integration?: unknown;
						phase?: unknown;
						answers?: unknown;
						model?: unknown;
						state?: unknown;
						category?: unknown;
						failOpen?: unknown;
						reason?: unknown;
						roles?: unknown;
						gate?: unknown;
					})
				: {};
		// A stage gate resolves no pool: it changes no route and only leaves a
		// durable record of what was decided, so it never touches the pinned
		// routing below.
		if (payload.integration === GATE_INTEGRATION) {
			recordGateDecision(snapshot, payload, now);
			return;
		}
		// The verifier-role integration resolves no pool: it changes no route and
		// only surfaces a fail-open classification as attention, so it never
		// touches the pinned routing below.
		if (payload.integration === TRIAGE_INTEGRATION) {
			recordTriageAttention(snapshot, {
				failOpen: payload.failOpen,
				reason: payload.reason,
				roles: payload.roles,
			});
			// The verification gate is decided on this step, so its verdict is
			// recorded here too: a round that skipped triage AND verification
			// must be as auditable as one that ran them.
			recordGateDecision(snapshot, payload.gate, now);
			return;
		}
		const loaded = loadConfigWithProvenance({
			repository: snapshot.metadata.repository || undefined,
			repositoryIndependent: !snapshot.metadata.repository,
		});
		const agents = parseAgentsConfig(
			loaded.config.agents,
			loaded.config,
			loaded.provenance.files.join(", ") || undefined,
		);
		const preset = snapshot.metadata.selectedPreset
			? resolvePreset(agents, snapshot.metadata.selectedPreset)
			: undefined;
		if (payload.integration !== ROUTING_INTEGRATION)
			throw new Error(
				`unknown model.classify integration: ${String(payload.integration)}`,
			);
		return applyPoolRouting(
			snapshot,
			definition,
			registry,
			agents,
			preset,
			payload,
			now,
		);
	} catch (error) {
		snapshot.attention = [
			...(snapshot.attention ?? []),
			`classifier routing update failed: ${boundedError(error)}`,
		];
		return undefined;
	}
}

/** Record one stage-gate decision. Recording is diagnostic: a snapshot that
 * cannot hold the record must not turn a successful gate effect into a failed
 * one, so the whole append runs inside an empty `catch`. An actual skip also
 * appends an attention entry naming the stage, which is what makes
 * `workflow status` show a skipped test suite or human review without any new
 * status surface. */
function recordGateDecision(
	snapshot: WorkflowSnapshot,
	payload: unknown,
	now: () => Date,
): void {
	if (!payload || typeof payload !== "object") return;
	const result = payload as {
		stage?: unknown;
		policy?: unknown;
		decision?: unknown;
		forced?: unknown;
		noul?: unknown;
		reason?: unknown;
	};
	if (result.decision !== "run" && result.decision !== "skip") return;
	const stage = typeof result.stage === "string" ? result.stage : "unknown";
	const policy = typeof result.policy === "string" ? result.policy : "always";
	const record: GateDecisionRecord = {
		id: `${snapshot.workflowId}:${snapshot.revision}:gate:${stage}:${snapshot.gateDecisions?.length ?? 0}`,
		at: now().toISOString(),
		stepId: snapshot.currentStep,
		stage,
		policy,
		decision: result.decision,
		forced: result.forced === true,
		...(typeof result.noul === "number" && Number.isFinite(result.noul)
			? { noul: result.noul }
			: {}),
		...(typeof result.reason === "string" && result.reason.trim()
			? { reason: result.reason }
			: {}),
	};
	try {
		appendGateDecision(snapshot, record);
	} catch {
		/* a gate decision that cannot be stored never fails the effect */
	}
	if (result.decision === "skip")
		snapshot.attention = [
			...(snapshot.attention ?? []),
			`stage gate skipped ${stage} (policy ${policy}, necessity ${record.noul ?? "unknown"})`,
		];
	// A forced run because the decision FAILED is the one forced run that must
	// stay audible: `always` and an answered run carry no reason, so the
	// mandatory-gate scenario stays attention-free while an outage, a missing
	// credential, or an unusable answer is named.
	else if (record.reason)
		snapshot.attention = [
			...(snapshot.attention ?? []),
			`stage gate could not be decided for ${stage} (policy ${policy}); the stage ran anyway: ${record.reason}`,
		];
}

/** Append with a fixed record count and a fixed aggregate size, shifting the
 * oldest record first. */
function appendGateDecision(
	snapshot: WorkflowSnapshot,
	record: GateDecisionRecord,
): void {
	const history = [...(snapshot.gateDecisions ?? []), record];
	while (
		history.length > 0 &&
		(history.length > GATE_DECISION_MAX_RECORDS ||
			Buffer.byteLength(JSON.stringify(history)) >
				GATE_DECISION_CONTENT_MAX_BYTES)
	)
		history.shift();
	snapshot.gateDecisions = history;
}

function recordTriageAttention(
	snapshot: WorkflowSnapshot,
	payload: { failOpen?: unknown; reason?: unknown; roles?: unknown },
): void {
	if (payload.failOpen === true) {
		const reason =
			typeof payload.reason === "string" && payload.reason.trim()
				? payload.reason
				: "unknown reason";
		snapshot.attention = [
			...(snapshot.attention ?? []),
			`verifier role classification failed open: ${reason}`,
		];
		return;
	}
	// A zero-role round is a legitimate classifier verdict, but it also skips
	// every domain verifier, so it is recorded: a later reader can tell "the
	// classifier judged no domain verifier necessary" from a silently dropped
	// gate.
	if (Array.isArray(payload.roles) && payload.roles.length === 0)
		snapshot.attention = [
			...(snapshot.attention ?? []),
			"verifier role classification selected no domain verifier; the round ran the full suite only",
		];
}

function applyPoolRouting(
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
	agents: AgentsConfig,
	preset: ReturnType<typeof resolvePreset> | undefined,
	payload: {
		phase?: unknown;
		answers?: unknown;
		model?: unknown;
		state?: unknown;
		failOpen?: unknown;
		reason?: unknown;
	},
	now: () => Date,
): RoutingDecisionSummary {
	if (payload.failOpen === true) {
		// A classifier outage is not a verdict: routing keeps the pool defaults
		// already pinned in the snapshot, and the outage is recorded so a later
		// reader can tell "the classifier chose these" from "the classifier was
		// unreachable". The per-step fallback attention below names each step.
		const reason =
			typeof payload.reason === "string" && payload.reason.trim()
				? payload.reason
				: "unknown reason";
		snapshot.attention = [
			...(snapshot.attention ?? []),
			`classifier routing failed open; kept the pool defaults: ${reason}`,
		];
	}
	const phase = payload.phase === "apply" ? "apply" : "plan";
	const answers: Record<string, ClassifierAnswer> =
		payload.answers &&
		typeof payload.answers === "object" &&
		!Array.isArray(payload.answers)
			? Object.fromEntries(
					Object.entries(payload.answers).map(([stepId, answer]) => [
						stepId,
						parseClassifierAnswer(answer),
					]),
				)
			: {};
	const steps = phase === "plan" ? PLAN_PHASE_STEPS : APPLY_PHASE_STEPS;
	const selections: CategorySelection[] = [];
	const attention: string[] = [];
	const decisions: Array<{
		stepId: string;
		entries: ReturnType<typeof poolEntries>;
		answer: ClassifierAnswer;
		applied: boolean;
		attention?: string;
	}> = [];
	let rosterProfiles: string[] | undefined;
	const specs = steps
		.filter((stepId) => definition.steps.includes(stepId))
		.map((stepId) => ({
			stepId,
			mode:
				registry.stepForDefinition(definition, stepId).behavior
					?.classification ?? "single",
			entries: poolEntries(preset, stepId),
		}));
	for (const spec of specs) {
		const { stepId, mode, entries } = spec;
		if (entries.length === 0)
			throw new Error(
				`classifier routing has no model pool for ${stepId}; define it in Settings → Presets`,
			);
		const answer = parseClassifierAnswer(answers[stepId]);
		if (mode === "roster") {
			const selected = selectRosterEntries(entries, answer);
			if (selected.attention)
				attention.push(`${stepId}: ${selected.attention}`);
			rosterProfiles = selected.profiles;
			decisions.push({
				stepId,
				entries,
				answer,
				applied: selected.attention === undefined,
				...(selected.attention ? { attention: selected.attention } : {}),
			});
			continue;
		}
		const selected = selectSingleEntry(entries, answer);
		if (selected.attention) attention.push(`${stepId}: ${selected.attention}`);
		if (selected.profile)
			selections.push({ stepId, profileName: selected.profile });
		decisions.push({
			stepId,
			entries,
			answer,
			applied: selected.attention === undefined,
			...(selected.attention ? { attention: selected.attention } : {}),
		});
	}
	// Overlay this pass's selections onto the pinned routes so an earlier pass's
	// classification is preserved (a plain rebuild would revert every route to
	// its pool default and flatten the fusion roster).
	let routing = applyRoutingSelections(snapshot.routing, agents, selections);
	if (rosterProfiles?.length)
		routing = applyFusionRoster(routing, agents, rosterProfiles);
	routing = enforceReadOnlySteps(
		routing,
		(stepId) => registry.stepForDefinition(definition, stepId).requirements,
	);
	if (rosterProfiles?.length) validateFusionRouting(definition.id, routing);
	for (const route of routing.routes)
		preflightProfile(
			route.profile,
			registry.stepForDefinition(definition, route.stepId).requirements,
		);
	snapshot.routing = routing;
	if (attention.length)
		snapshot.attention = [...(snapshot.attention ?? []), ...attention];
	try {
		appendClassifierDecisions(
			snapshot,
			decisions.map((decision, index) => ({
				id: `${snapshot.workflowId}:${snapshot.revision}:routing:${phase}:${decision.stepId}:${index}`,
				at: now().toISOString(),
				integration: ROUTING_INTEGRATION,
				phase,
				questionId: decision.stepId,
				model:
					typeof payload.model === "string" && payload.model.trim()
						? payload.model
						: "unknown",
				...truncateClassifierInput(
					typeof payload.state === "string" ? payload.state : "",
				),
				options: decision.entries.map((entry) => {
					const criteria = normalizeJson(entry.criteria);
					return {
						label: entry.label,
						profile: entry.profile,
						...(criteria === undefined ? {} : { criteria }),
					};
				}),
				answer: decision.answer,
				result: {
					applied: decision.applied,
					profiles: [
						...new Set(
							routing.routes
								.filter((route) => route.stepId === decision.stepId)
								.map((route) => route.profile.name),
						),
					],
					...(decision.attention ? { attention: decision.attention } : {}),
				},
			})),
		);
	} catch {
		// Decision history is diagnostic. A successful routing update must never
		// become a failed classifier effect because its record could not be stored.
	}
	return buildRoutingDecisionSummary(phase, specs, answers);
}

function normalizeJson(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined
			? undefined
			: (JSON.parse(encoded) as JsonValue);
	} catch {
		return undefined;
	}
}

function truncateClassifierInput(input: string): {
	input: string;
	inputTruncated: boolean;
} {
	if (Buffer.byteLength(input) <= CLASSIFIER_DECISION_INPUT_MAX_BYTES)
		return { input, inputTruncated: false };
	let truncated = Buffer.from(input)
		.subarray(0, CLASSIFIER_DECISION_INPUT_MAX_BYTES)
		.toString("utf8");
	while (Buffer.byteLength(truncated) > CLASSIFIER_DECISION_INPUT_MAX_BYTES)
		truncated = truncated.slice(0, -1);
	return { input: truncated, inputTruncated: true };
}

function appendClassifierDecisions(
	snapshot: WorkflowSnapshot,
	decisions: ClassifierDecisionRecord[],
): void {
	const history = [...(snapshot.classifierDecisions ?? [])];
	for (const decision of decisions) {
		history.push(decision);
		while (
			history.length > 0 &&
			(history.length > CLASSIFIER_DECISION_MAX_RECORDS ||
				Buffer.byteLength(JSON.stringify(history)) >
					CLASSIFIER_DECISION_CONTENT_MAX_BYTES)
		)
			history.shift();
	}
	snapshot.classifierDecisions = history;
}

export function effectResult(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "effect.result" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_outbox WHERE id=?")
		.get(command.effectId) as EffectRow | null;
	if (
		!row ||
		row.workflow_id !== snapshot.workflowId ||
		row.status !== "running" ||
		row.lease !== command.lease ||
		Date.parse(row.lease_expires_at ?? "") <= now().getTime()
	)
		throw new WorkflowRuntimeError(
			"stale-effect",
			"effect lease is invalid or expired",
		);
	if (command.outcome === "complete") {
		db.query(
			"UPDATE workflow_outbox SET status='completed', lease=NULL, lease_expires_at=NULL WHERE id=?",
		).run(row.id);
		if (row.kind === "agent.launch") {
			const runId = String(
				(JSON.parse(row.payload_json) as { runId?: string }).runId ?? "",
			);
			if (runId && command.data && typeof command.data === "object")
				db.query(
					"UPDATE workflow_runs SET handle_json=?, status='working' WHERE id=? AND status IN ('pending','working')",
				).run(json(command.data), runId);
		}
		if (row.kind === "agent.prompt") {
			// A delivered peer prompt reports the hash of the nonce it minted; the
			// raw nonce only ever reached the addressed live session.
			const payload = JSON.parse(row.payload_json) as {
				questionId?: unknown;
			};
			const data =
				command.data && typeof command.data === "object"
					? (command.data as { answerNonceHash?: unknown })
					: {};
			if (
				typeof payload.questionId === "string" &&
				typeof data.answerNonceHash === "string"
			) {
				const question = snapshot.developerDialogue.find(
					(item) =>
						item.id === payload.questionId &&
						item.targetRunId !== undefined &&
						item.status === "pending",
				);
				if (question) question.answerNonceHash = data.answerNonceHash;
			}
		}
	} else if (command.outcome === "retry" && row.attempts < row.max_attempts) {
		const next = new Date(
			now().getTime() + Math.min(60_000, 1000 * 2 ** row.attempts),
		).toISOString();
		db.query(
			"UPDATE workflow_outbox SET status='retry', lease=NULL, lease_expires_at=NULL, next_attempt_at=?, last_error=? WHERE id=?",
		).run(next, boundedError(command.data), row.id);
	} else {
		db.query(
			"UPDATE workflow_outbox SET status='failed', lease=NULL, lease_expires_at=NULL, last_error=? WHERE id=?",
		).run(boundedError(command.data), row.id);
		// A failed peer-question prompt must resolve its dialogue record rather
		// than brick the whole workflow: the asking agent gets a bounded expired
		// answer and the workflow keeps running.
		const payload = JSON.parse(row.payload_json) as { questionId?: unknown };
		const peerQuestion =
			row.kind === "agent.prompt" && typeof payload.questionId === "string"
				? snapshot.developerDialogue.find(
						(item) =>
							item.id === payload.questionId &&
							item.status === "pending" &&
							item.targetRunId !== undefined,
					)
				: undefined;
		if (peerQuestion) {
			peerQuestion.status = "expired";
			peerQuestion.answeredAt = nowIso(now);
			peerQuestion.answer = { kind: "cancel" };
		} else {
			snapshot.status = "attention-required";
			snapshot.attention = [
				`effect ${row.kind} failed: ${boundedError(command.data)}`,
			];
		}
	}
	if (command.outcome === "complete" && row.kind === "workspace.setup") {
		const data =
			command.data && typeof command.data === "object"
				? (command.data as Record<string, unknown>)
				: {};
		if (typeof data.worktree === "string") {
			const candidate = path.resolve(data.worktree);
			const allowed = new Set<string>([
				path.resolve(snapshot.metadata.worktree),
			]);
			if (snapshot.metadata.repository) {
				allowed.add(path.resolve(snapshot.metadata.repository));
				const listed = Bun.spawnSync(
					[
						"git",
						"-C",
						snapshot.metadata.repository,
						"worktree",
						"list",
						"--porcelain",
					],
					{ stdout: "pipe", stderr: "ignore" },
				);
				for (const line of listed.stdout.toString().split("\n"))
					if (line.startsWith("worktree "))
						allowed.add(path.resolve(line.slice(9)));
			}
			const candidateReal = fs.realpathSync(candidate);
			const allowedReal = [...allowed].some((item) => {
				try {
					return fs.realpathSync(item) === candidateReal;
				} catch {
					return path.resolve(item) === candidate;
				}
			});
			if (!allowedReal)
				throw new WorkflowRuntimeError(
					"source-isolation",
					"workspace setup returned an unregistered worktree",
				);
			snapshot.metadata.worktree = candidateReal;
		}
		if (typeof data.workspace === "string")
			snapshot.metadata.workspace = data.workspace;
		if (typeof data.branch === "string") snapshot.metadata.branch = data.branch;
		enterStep(db, snapshot, definition, registry, now);
	}
	const routingDecision =
		command.outcome === "complete" && row.kind === "model.classify"
			? applyClassifierRouting(
					snapshot,
					definition,
					registry,
					command.data,
					now,
				)
			: undefined;
	if (command.outcome === "complete") {
		const step = registry.stepForDefinition(definition, snapshot.currentStep);
		const completion = step.behavior?.onEffectComplete?.({
			snapshot: structuredClone(snapshot),
			effect: {
				kind: row.kind,
				payload: JSON.parse(row.payload_json),
				data: command.data,
			},
		});
		applyCompletionResult(
			db,
			snapshot,
			definition,
			step,
			completion,
			registry,
			now,
		);
	}
	if (command.outcome === "complete" && row.kind === "workspace.close")
		enqueue(
			db,
			snapshot,
			"workspace.cleanup",
			`workspace:${snapshot.workflowId}:cleanup`,
			{ workflowId: snapshot.workflowId },
		);
	return {
		type: "effect.result",
		actor: { kind: "system", effectId: row.id },
		data: {
			outcome: command.outcome,
			...(routingDecision ? { routingDecision } : {}),
		},
	};
}
