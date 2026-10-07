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
	TRIAGE_DECISION_INPUT_MAX_BYTES,
	type WorkflowCommand,
	type WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import {
	APPLY_PHASE_STEPS,
	buildRoutingDecisionSummary,
	type ClassifierAnswer,
	FILE_JUDGMENT_INTEGRATION,
	FILE_JUDGMENT_MAX_PATHS,
	FILE_JUDGMENT_QUESTION_ID,
	GATE_INTEGRATION,
	PLAN_PHASE_STEPS,
	parseClassifierAnswer,
	ROUTING_INTEGRATION,
	type RoutingDecisionSummary,
	selectRosterEntries,
	selectSingleEntry,
	TRIAGE_INTEGRATION,
	TRIAGE_NOUL_FLOOR,
	triageRoleQuestions,
} from "../../classifiers.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { effectiveFamilyTraits } from "../../definitions/manifest-policy.ts";
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
	WorkflowFamilyTraits,
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
						fileJudgment?: unknown;
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
			// Which roles a round needs is a classification like any other, so it
			// belongs in the same history the dashboard reads: before this, an
			// answered role classification left no record at all and only a
			// fail-open ever surfaced as attention.
			recordTriageClassification(
				snapshot,
				definition.id,
				effectiveFamilyTraits(definition),
				payload,
				now,
			);
			// The per-file judgment sweep answers one question per candidate file,
			// so it is recorded as the one sweep it was rather than as one record
			// per file, which a change-sized fan-out could never fit in the bounded
			// history.
			recordFileJudgmentClassification(snapshot, payload.fileJudgment, now);
			// The verification gate is decided on this step, so its verdict is
			// recorded here too: a round that skipped triage AND verification
			// must be as auditable as one that ran them.
			recordGateDecision(snapshot, payload.gate, now);
			// The sweep's section is recorded as evidence rather than inlined: a
			// verifier's assignment already renders evidence into its inputs, so the
			// path travels as a content-bound reference and the text stays in the
			// artifact. A payload without one — no changed files, or a classifier
			// outage — records nothing, which is the fail-open contract.
			const signals = (
				data as { fileSignals?: { path?: unknown; digest?: unknown } } | null
			)?.fileSignals;
			if (
				typeof signals?.path === "string" &&
				typeof signals.digest === "string"
			)
				snapshot.evidence.push({
					kind: "file-signals",
					path: signals.path,
					digest: signals.digest,
				});
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

/** The reason a triage pass carries, or undefined when it answered. The reason
 * is what lets a later reader tell "the classifier chose no role" apart from
 * "the classifier could not be asked". A fail-open with no reason reads the
 * same here as in the attention entry, so one outage has one wording. */
function triageFailure(payload: {
	failOpen?: unknown;
	reason?: unknown;
}): string | undefined {
	if (payload.failOpen !== true) return undefined;
	return typeof payload.reason === "string" && payload.reason.trim()
		? payload.reason.trim().slice(0, 1000)
		: "unknown reason";
}

/** The classifier model a classification names, or "unknown" when the payload
 * carried none. A missing model must stay visible as missing: an unnamed
 * answer is still an answer, but an unnamed model is not a decision anybody
 * can reproduce. */
function classifierModel(value: unknown): string {
	return typeof value === "string" && value.trim() ? value : "unknown";
}

/** Record the round's verifier-role classification: one record per question
 * the round asked, exactly as a routing pass records one per pool question, so
 * every classification the engine made lands in one history the dashboard can
 * show. A pass that obtained no usable answer at all is recorded as a single
 * record instead: eight records that all say "no usable answer" are one event,
 * not eight.
 *
 * Recording is diagnostic. The whole append runs inside an empty catch, so a
 * snapshot that cannot hold the history never turns a successful classification
 * into a failed effect. */
function recordTriageClassification(
	snapshot: WorkflowSnapshot,
	definitionId: string,
	traits: WorkflowFamilyTraits | undefined,
	payload: {
		model?: unknown;
		state?: unknown;
		answers?: unknown;
		roles?: unknown;
		failOpen?: unknown;
		reason?: unknown;
	},
	now: () => Date,
): void {
	const questions = triageRoleQuestions(definitionId, traits);
	if (!questions.length) return;
	const answers =
		payload.answers &&
		typeof payload.answers === "object" &&
		!Array.isArray(payload.answers)
			? Object.fromEntries(
					Object.entries(payload.answers).map(([questionId, answer]) => [
						questionId,
						parseClassifierAnswer(answer),
					]),
				)
			: {};
	const roles = Array.isArray(payload.roles)
		? payload.roles.filter((role): role is string => typeof role === "string")
		: [];
	const attention = triageFailure(payload);
	const model = classifierModel(payload.model);
	const input = truncateClassifierInput(
		typeof payload.state === "string" ? payload.state : "",
		TRIAGE_DECISION_INPUT_MAX_BYTES,
	);
	const answered = (questionId: string): number | undefined => {
		const answer = answers[questionId];
		return answer?.type === "noul" ? answer.noul : undefined;
	};
	const at = now().toISOString();
	const record = (
		id: string,
		questionId: string,
		noul: number | undefined,
		selected: boolean,
		profiles: string[],
	): ClassifierDecisionRecord => ({
		id,
		at,
		integration: TRIAGE_INTEGRATION,
		questionId,
		model,
		...input,
		options: [],
		answer: {
			type: "noul",
			...(noul === undefined ? {} : { noul }),
		},
		result: {
			applied: selected,
			profiles,
			...(attention ? { attention } : {}),
		},
	});
	const prefix = [snapshot.workflowId, snapshot.revision, "triage"].join(":");
	try {
		appendClassifierDecisions(
			snapshot,
			questions.some((question) => answered(question.questionId) !== undefined)
				? questions.map((question, index) => {
						const noul = answered(question.questionId);
						// A role runs only when this round actually selected it: a
						// necessity value above the floor is necessary but not
						// sufficient, because an unanswered sibling question fails
						// the whole round open.
						const selected =
							noul !== undefined &&
							noul >= TRIAGE_NOUL_FLOOR &&
							roles.includes(question.role);
						return record(
							`${prefix}:${question.questionId}:${index}`,
							question.questionId,
							noul,
							selected,
							selected ? [question.role] : [],
						);
					})
				: [
						record(
							`${prefix}:verifier-roles`,
							"verifier-roles",
							undefined,
							false,
							[],
						),
					],
		);
	} catch {
		/* decision history is diagnostic, never an effect failure */
	}
}

/** Record one per-file judgment sweep as the single classification it was: a
 * sweep asks one question per candidate file, so one record per file could
 * never fit a bounded history on a large change. The banded verdicts travel as
 * the record's options (path, band, necessity) and the coverage counts in its
 * attention line, so the dashboard shows what the sweep decided without reading
 * the artifact. */
function recordFileJudgmentClassification(
	snapshot: WorkflowSnapshot,
	payload: unknown,
	now: () => Date,
): void {
	if (!payload || typeof payload !== "object") return;
	const report = payload as {
		model?: unknown;
		section?: unknown;
		judged?: unknown;
		cleared?: unknown;
		cached?: unknown;
		skipped?: unknown;
		degenerate?: unknown;
		flagged?: unknown;
		unsure?: unknown;
	};
	const count = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.floor(value)
			: 0;
	// The engine owns the bound: a band list arriving over the effect boundary
	// cannot grow the record past what the bounded history can hold.
	const band = (
		value: unknown,
		verdict: string,
	): ClassifierDecisionRecord["options"] =>
		Array.isArray(value)
			? value.slice(0, FILE_JUDGMENT_MAX_PATHS).flatMap((entry) => {
					const path =
						entry && typeof entry === "object"
							? (entry as { path?: unknown }).path
							: undefined;
					if (typeof path !== "string" || !path) return [];
					const noul = (entry as { noul?: unknown }).noul;
					return [
						{
							label: path,
							profile: verdict,
							...(typeof noul === "number" && Number.isFinite(noul)
								? { criteria: noul }
								: {}),
						},
					];
				})
			: [];
	const flagged = band(report.flagged, "flag");
	const unsure = band(report.unsure, "unsure");
	const judged = count(report.judged);
	// A sweep that judged nothing is not a classification. The artifact and the
	// evidence reference record that it ran; this history records decisions.
	if (!judged && !flagged.length && !unsure.length) return;
	const degenerate = report.degenerate === true;
	const coverage = [
		`judged ${judged}`,
		...(count(report.cached) ? [`(${count(report.cached)} from cache)`] : []),
		`cleared ${count(report.cleared)}`,
		`flagged ${flagged.length}`,
		`unsure ${unsure.length}`,
		`not judged ${count(report.skipped)}`,
	];
	if (degenerate) coverage.push("(degenerate: every verdict is a finding)");
	try {
		appendClassifierDecisions(snapshot, [
			{
				id: [
					snapshot.workflowId,
					snapshot.revision,
					"file-judgment",
					snapshot.classifierDecisions?.length ?? 0,
				].join(":"),
				at: now().toISOString(),
				integration: FILE_JUDGMENT_INTEGRATION,
				questionId: FILE_JUDGMENT_QUESTION_ID,
				model: classifierModel(report.model),
				...truncateClassifierInput(
					typeof report.section === "string" ? report.section : "",
				),
				options: [...flagged, ...unsure],
				// One sweep asks one question per file, so it carries no single
				// necessity value: the bands above are the answer.
				answer: { type: "noul" },
				result: {
					applied: judged > 0 && !degenerate,
					profiles: [],
					attention: coverage.join(" "),
				},
			},
		]);
	} catch {
		/* decision history is diagnostic, never an effect failure */
	}
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
		/** The classifiable step a per-step routing payload asks about. Absent
		 * on a definition pinned to one of the pre-per-step tiers. */
		stepId?: unknown;
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
	// One question per route step: the step comes from the payload. A payload
	// without one is a pre-per-step phase pass, which keeps resolving through
	// its phase's step list.
	const steps =
		typeof payload.stepId === "string"
			? [payload.stepId]
			: phase === "plan"
				? PLAN_PHASE_STEPS
				: APPLY_PHASE_STEPS;
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

function truncateClassifierInput(
	input: string,
	limit = CLASSIFIER_DECISION_INPUT_MAX_BYTES,
): {
	input: string;
	inputTruncated: boolean;
} {
	if (Buffer.byteLength(input) <= limit)
		return { input, inputTruncated: false };
	let truncated = Buffer.from(input).subarray(0, limit).toString("utf8");
	while (Buffer.byteLength(truncated) > limit)
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
		if (typeof data.branch === "string") snapshot.metadata.branch = data.branch;
		enterStep(db, snapshot, definition, registry, now);
	}
	// The routing payload (which step was asked) lives on the effect row; the
	// answers live on the command. Both are needed: without the payload's
	// `stepId` a per-step routing effect would be read as a phase-wide pass and
	// re-answer steps whose models were already chosen.
	const routingDecision =
		command.outcome === "complete" && row.kind === "model.classify"
			? applyClassifierRouting(
					snapshot,
					definition,
					registry,
					{
						...(JSON.parse(row.payload_json) as Record<string, unknown>),
						...(command.data && typeof command.data === "object"
							? (command.data as Record<string, unknown>)
							: {}),
					},
					now,
				)
			: undefined;
	if (command.outcome === "complete") {
		const step = registry.stepForDefinition(definition, snapshot.currentStep);
		const completion = step.behavior?.onEffectComplete?.({
			snapshot: structuredClone(snapshot),
			traits: effectiveFamilyTraits(definition),
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
