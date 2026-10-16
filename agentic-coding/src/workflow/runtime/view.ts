// The read model: workflow/list/status projection, repair preview, and the
// run/effect projection into `WorkflowView`. Read path only. Moved verbatim
// out of runtime.ts (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type {
	WorkflowDefinitionGraph,
	WorkflowView,
} from "../../contracts/workflow.ts";
import { decodeSnapshot, WorkflowRuntimeError } from "../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowEdge,
	WorkflowRegistry,
} from "../registry.ts";
import { isInsertedStep } from "../steps/routing.ts";
import {
	resolveDefinition,
	resolveDefinitionWithOrigin,
} from "./definitions.ts";
import { ORCHESTRATOR_QUESTION_TARGET } from "./dialogue.ts";
import type { RepairPreview } from "./engine-types.ts";
import {
	ACTIVE_RUN,
	actions,
	boundedError,
	effects,
	instance,
	observedStore,
	openReadStore,
	runs,
	STORE_SCHEMA_VERSION,
	unsupportedStoreVersion,
	validateSnapshot,
} from "./store.ts";

/** The compiled graph of a pinned definition, in walk order: a breadth-first
 * walk from the definition's initial step, taking each step's own edges in
 * declared order, so two reads of one definition always list the same steps in
 * the same order. Every declared step is listed — registration already rejects
 * an unreachable one, and a step the walk cannot reach is appended in declared
 * order rather than hidden from the reader. The graph is projected here, never
 * in the dashboard: the TUI is a presentation client and never reads the
 * registry. */
function projectDefinitionGraph(
	registry: WorkflowRegistry,
	definition: Readonly<CompiledWorkflowDefinition>,
): WorkflowDefinitionGraph {
	const outbound = new Map<string, WorkflowEdge[]>();
	for (const edge of definition.edges) {
		const edges = outbound.get(edge.from);
		if (edges) edges.push(edge);
		else outbound.set(edge.from, [edge]);
	}
	const order: string[] = [];
	const seen = new Set<string>();
	// One growing queue with a read cursor: a step is enqueued once per inbound
	// edge, and each is visited at most once.
	const queue: string[] = [definition.initial];
	for (let index = 0; index < queue.length; index++) {
		const id = queue[index];
		if (id === undefined || seen.has(id)) continue;
		seen.add(id);
		order.push(id);
		for (const edge of outbound.get(id) ?? [])
			if (!seen.has(edge.to)) queue.push(edge.to);
	}
	for (const id of definition.steps) if (!seen.has(id)) order.push(id);
	return {
		steps: order.map((id) => {
			const step = registry.stepForDefinition(definition, id);
			return {
				id,
				label: step.label,
				actor: step.actor,
				inserted: isInsertedStep(id),
			};
		}),
		edges: definition.edges.map((edge) => ({
			from: edge.from,
			outcome: edge.outcome,
			to: edge.to,
			...(edge.loop ? { loop: { maxAttempts: edge.loop.maxAttempts } } : {}),
		})),
	};
}

function publicDialogue(
	snapshot: NonNullable<WorkflowView["developerDialogue"]>,
): NonNullable<WorkflowView["developerDialogue"]> {
	return snapshot.map(
		({
			timerNonce: _timerNonce,
			answerNonceHash: _answerNonceHash,
			targetRunId: _targetRunId,
			...question
		}) => question,
	);
}

/** Pending questions the developer may answer in the modal. Peer-agent
 * questions are delivered and answered by another agent, so they never open the
 * developer modal even while they are pending. Records still routed to the
 * orchestrator stay listed: the orchestrator answers or forwards them first,
 * but the developer is the backstop when it does not act
 * (make-developer-questions-asynchronous). */
function pendingDeveloperQuestions(
	snapshot: NonNullable<WorkflowView["developerDialogue"]>,
	now: () => Date,
): NonNullable<WorkflowView["developerDialogue"]> {
	return publicDialogue(snapshot).filter(
		(item) =>
			(item.targetRole === undefined ||
				item.targetRole === ORCHESTRATOR_QUESTION_TARGET) &&
			item.status === "pending" &&
			Date.parse(item.expiresAt) > now().getTime(),
	);
}

/** Pending questions routed to the orchestrator first
 * (route-developer-questions-through-orchestrator). The orchestrator session
 * reads these to answer or forward them; the developer never sees them until
 * they are forwarded (their marker cleared). */
function pendingOrchestratorQuestions(
	snapshot: NonNullable<WorkflowView["developerDialogue"]>,
	now: () => Date,
): NonNullable<WorkflowView["developerDialogue"]> {
	return publicDialogue(snapshot).filter(
		(item) =>
			item.targetRole === "orchestrator" &&
			item.status === "pending" &&
			Date.parse(item.expiresAt) > now().getTime(),
	);
}

export function diagnosticView(
	changeId: string,
	diagnostic: string,
): WorkflowView {
	return {
		workflowId: changeId,
		changeId,
		revision: 0,
		definition: {
			id: "unavailable",
			version: 0,
			digest: "",
			label: "Unavailable",
		},
		status: "attention-required",
		repository: "",
		worktree: "",
		branch: "",
		baseCommit: "",
		createdAt: "",
		updatedAt: "",
		currentStep: {
			id: "unavailable",
			label: "Unavailable",
			attempt: 0,
			enteredAt: "",
		},
		runs: [],
		routing: { defaultProfile: "", routes: [] },
		effects: [],
		observations: [],
		health: { valid: false, attention: [diagnostic], diagnostic },
		developerDialogue: [],
		classifierDecisions: [],
		gateDecisions: [],
		pendingQuestions: [],
		availableActions: [],
	};
}

export function view(
	db: Database,
	id: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowView {
	const source = db
		.query(
			"SELECT change_id,repository,worktree FROM workflow_instances WHERE id=?",
		)
		.get(id) as {
		change_id: string;
		repository: string;
		worktree: string;
	} | null;
	try {
		const row = instance(db, id);
		const snapshot = decodeSnapshot(JSON.parse(row.snapshot_json));
		const resolved = resolveDefinitionWithOrigin(
			registry,
			db,
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
		);
		const definition = resolved.definition;
		const runList = runs(db, id);
		validateSnapshot(snapshot, definition, runList, registry);
		const effectList = effects(db, id);
		const failedActions = effectList
			.filter((effect) => effect.status === "failed")
			.map((effect) => ({
				id: `retry-effect:${effect.id}`,
				label: `Retry ${effect.kind}`,
				confirmation: "confirm" as const,
			}));
		const availableActions = actions(snapshot, definition, registry).filter(
			(action) =>
				action.id !== "create-pr" ||
				!effectList.some((effect) => effect.kind === "pull-request.create"),
		);
		if (
			!snapshot.metadata.executionSettings &&
			effectList.some(
				(effect) =>
					effect.kind === "delivery.push" ||
					effect.kind === "pull-request.create",
			)
		) {
			const preview = snapshot.metadata.executionSettingsPreview;
			availableActions.push({
				id: preview ? "adopt-settings" : "preview-settings",
				label: preview
					? `Adopt preview: remote=${preview.settings.remote}, PR=${preview.settings.prTool ?? "unavailable"}`
					: "Preview current execution settings",
				confirmation: "confirm",
			});
		}
		return {
			workflowId: snapshot.workflowId,
			changeId: snapshot.metadata.changeId,
			revision: snapshot.revision,
			definition: { ...snapshot.definition, label: definition.label },
			definitionOrigin: resolved.origin,
			...(snapshot.metadata.blueprint
				? { blueprintRationale: snapshot.metadata.blueprint.rationale }
				: {}),
			definitionGraph: projectDefinitionGraph(registry, definition),
			status: snapshot.status,
			repository: snapshot.metadata.repository,
			worktree: snapshot.metadata.worktree,
			branch: snapshot.metadata.branch,
			baseCommit: snapshot.metadata.baseCommit,
			...(snapshot.metadata.task !== undefined
				? { task: snapshot.metadata.task }
				: {}),
			createdAt: snapshot.metadata.createdAt,
			updatedAt: snapshot.metadata.updatedAt,
			...(snapshot.metadata.selectedPreset
				? { selectedPreset: snapshot.metadata.selectedPreset }
				: {}),
			// Read-side default: a snapshot written before the attribution existed
			// is operator-started work.
			startedBy: snapshot.metadata.startedBy ?? "developer",
			currentStep: {
				id: snapshot.currentStep,
				label: registry.stepForDefinition(definition, snapshot.currentStep)
					.label,
				attempt: snapshot.step.attempt,
				enteredAt: snapshot.metadata.stepEnteredAt,
				...(snapshot.step.context !== undefined
					? { context: snapshot.step.context }
					: {}),
			},
			runs: runList.map((run) => ({
				id: run.id,
				stepId: run.stepId,
				role: run.role,
				attempt: run.attempt,
				status: run.status,
				runtime: run.profile.runtime,
				profile: run.profile.name,
				...(run.profile.model ? { model: run.profile.model } : {}),
				...(run.handle?.hostSocket
					? { hostSocket: run.handle.hostSocket }
					: {}),
				...(run.handle?.conversationId
					? { conversationId: run.handle.conversationId }
					: {}),
				...(run.outputPath ? { outputPath: run.outputPath } : {}),
				...(run.outputDigest ? { outputDigest: run.outputDigest } : {}),
			})),
			routing: snapshot.routing,
			...(snapshot.metadata.executionSettingsPreview
				? {
						executionSettingsPreview:
							snapshot.metadata.executionSettingsPreview,
					}
				: {}),
			effects: effectList.map((effect) => ({
				id: effect.id,
				kind: effect.kind,
				status: effect.status,
				attempts: effect.attempts,
				...(effect.lastError ? { lastError: effect.lastError } : {}),
			})),
			observations: [],
			health: { valid: true, attention: snapshot.attention },
			developerDialogue: publicDialogue(snapshot.developerDialogue ?? []),
			classifierDecisions: snapshot.classifierDecisions ?? [],
			gateDecisions: snapshot.gateDecisions ?? [],
			pendingQuestions: pendingDeveloperQuestions(
				snapshot.developerDialogue ?? [],
				now,
			),
			orchestratorQuestions: pendingOrchestratorQuestions(
				snapshot.developerDialogue ?? [],
				now,
			),
			availableActions: [...availableActions, ...failedActions],
		};
	} catch (error) {
		const diagnostic = boundedError(error);
		if (/pin mismatch/.test(diagnostic)) {
			try {
				const row = instance(db, id);
				const snapshot = decodeSnapshot(JSON.parse(row.snapshot_json));
				return {
					workflowId: snapshot.workflowId,
					changeId: snapshot.metadata.changeId,
					revision: snapshot.revision,
					definition: {
						...snapshot.definition,
						digest: "",
						label: "Pin mismatch",
					},
					status: snapshot.status,
					repository: snapshot.metadata.repository,
					worktree: snapshot.metadata.worktree,
					branch: snapshot.metadata.branch,
					baseCommit: snapshot.metadata.baseCommit,
					...(snapshot.metadata.task !== undefined
						? { task: snapshot.metadata.task }
						: {}),
					createdAt: snapshot.metadata.createdAt,
					updatedAt: snapshot.metadata.updatedAt,
					...(snapshot.metadata.selectedPreset
						? { selectedPreset: snapshot.metadata.selectedPreset }
						: {}),
					startedBy: snapshot.metadata.startedBy ?? "developer",
					currentStep: {
						id: snapshot.currentStep,
						label: "Unavailable",
						attempt: snapshot.step.attempt,
						enteredAt: snapshot.metadata.stepEnteredAt,
					},
					runs: [],
					routing: snapshot.routing,
					...(snapshot.metadata.executionSettingsPreview
						? {
								executionSettingsPreview:
									snapshot.metadata.executionSettingsPreview,
							}
						: {}),
					effects: [],
					observations: [],
					health: { valid: false, attention: [diagnostic], diagnostic },
					developerDialogue: publicDialogue(snapshot.developerDialogue ?? []),
					classifierDecisions: snapshot.classifierDecisions ?? [],
					gateDecisions: snapshot.gateDecisions ?? [],
					pendingQuestions: pendingDeveloperQuestions(
						snapshot.developerDialogue ?? [],
						now,
					),
					availableActions: [
						{
							id: "re-pin",
							label: "Re-pin to current definition",
							confirmation: "confirm",
						},
					],
				};
			} catch {
				/* fall through to generic unavailable */
			}
		}
		return {
			workflowId: id,
			changeId: source?.change_id ?? "unknown",
			revision: 0,
			definition: {
				id: "unavailable",
				version: 0,
				digest: "",
				label: "Unavailable",
			},
			status: "attention-required",
			repository: source?.repository ?? "",
			worktree: source?.worktree ?? "",
			branch: "",
			baseCommit: "",
			createdAt: "",
			updatedAt: "",
			currentStep: {
				id: "unavailable",
				label: "Unavailable",
				attempt: 0,
				enteredAt: "",
			},
			runs: [],
			routing: { defaultProfile: "", routes: [] },
			effects: [],
			observations: [],
			health: { valid: false, attention: [], diagnostic },
			developerDialogue: [],
			classifierDecisions: [],
			pendingQuestions: [],
			availableActions: [],
		};
	}
}

export function viewById(
	repo: string,
	id: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowView {
	const db = openReadStore(repo);
	try {
		return view(db, id, registry, now);
	} finally {
		db.close();
	}
}

export function status(
	repo: string,
	workflowId: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowView {
	// One store open per read: a store this build cannot read is reported as a
	// diagnostic view rather than thrown at the caller.
	let db: Database;
	try {
		db = openReadStore(repo);
	} catch (error) {
		if (error instanceof WorkflowRuntimeError)
			return diagnosticView(workflowId, error.message);
		throw error;
	}
	try {
		let row = db
			.query("SELECT id FROM workflow_instances WHERE id=?")
			.get(workflowId) as { id: string } | null;
		if (!row)
			row = db
				.query("SELECT id FROM workflow_instances WHERE change_id=?")
				.get(workflowId) as { id: string } | null;
		if (!row)
			throw new WorkflowRuntimeError(
				"not-found",
				`workflow not found: ${workflowId}`,
			);
		return view(db, row.id, registry, now);
	} finally {
		db.close();
	}
}

export function list(
	repo: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowView[] {
	const observed = observedStore(repo);
	if (!observed)
		return [
			diagnosticView(
				"store",
				"workflow store is absent; initialize the store before writing",
			),
		];
	if (observed.version !== STORE_SCHEMA_VERSION)
		return [
			diagnosticView(
				"store",
				unsupportedStoreVersion(observed.version).message,
			),
		];
	let db: Database;
	try {
		db = openReadStore(repo);
	} catch (error) {
		return [
			diagnosticView(
				"store",
				error instanceof Error ? error.message : String(error),
			),
		];
	}
	try {
		return (
			db
				.query("SELECT id FROM workflow_instances ORDER BY updated_at DESC")
				.all() as Array<{ id: string }>
		).map((row) => view(db, row.id, registry, now));
	} finally {
		db.close();
	}
}

export function previewRepair(
	repo: string,
	workflowId: string,
	registry: WorkflowRegistry,
): RepairPreview[] {
	const db = openReadStore(repo);
	try {
		const row = instance(db, workflowId);
		const snapshot = decodeSnapshot(JSON.parse(row.snapshot_json));
		const definition = resolveDefinition(
			registry,
			db,
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
		);
		const activeRuns = runs(db, snapshot.workflowId).filter((run) =>
			ACTIVE_RUN.has(run.status),
		);
		return definition.steps
			.filter(
				(stepId) =>
					!definition.terminal.includes(stepId) &&
					registry.stepForDefinition(definition, stepId).actor !== "system",
			)
			.map((stepId) => ({
				targetStep: stepId,
				label: registry.stepForDefinition(definition, stepId).label,
				expiresRuns: activeRuns.map((run) => run.id),
				retainedEvidence: snapshot.evidence.map((item) => item.digest),
			}));
	} finally {
		db.close();
	}
}
