// The read model: workflow/list/status projection, repair preview, and the
// run/effect projection into `WorkflowView`. Read path only. Moved verbatim
// out of runtime.ts (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type {
	WorkflowDefinitionGraph,
	WorkflowEffect,
	WorkflowRun,
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
import {
	developerPendingQuestion,
	ORCHESTRATOR_QUESTION_TARGET,
} from "./dialogue.ts";
import type { RepairPreview } from "./engine-types.ts";
import {
	ACTIVE_RUN,
	actions,
	boundedError,
	type EffectRow,
	effectFromRow,
	effects,
	type InstanceRow,
	instance,
	observedStore,
	openReadStore,
	type RunRow,
	runFromRow,
	runs,
	STORE_SCHEMA_VERSION,
	unsupportedStoreVersion,
	validateDecodedSnapshot,
} from "./store.ts";
import { definitionStepActor, waitState, workflowWait } from "./waiting.ts";

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
	return publicDialogue(snapshot).filter((item) =>
		developerPendingQuestion(item, now),
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
			item.targetRole === ORCHESTRATOR_QUESTION_TARGET &&
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

/** The rows one view is built from, as thunks: a single read stays lazy in
 * exactly the order this path has always read (the row first, runs only after
 * the definition resolved, effects only after validation), while a listing that
 * already holds every workflow's rows hands them over without a query per
 * workflow. */
export interface ViewRows {
	/** The id the view is for: the requested one for a single read, the row's own
	 * for a listing. The fallback view names it when nothing else is readable. */
	readonly workflowId: string;
	/** Absent when the instance is gone: that reads as the generic unavailable
	 * view, never as a thrown error a caller could not act on. */
	readonly row: () => InstanceRow | undefined;
	readonly runs: () => WorkflowRun[];
	readonly effects: () => WorkflowEffect[];
}

export function view(
	db: Database,
	id: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowView {
	return viewFromRows(
		db,
		{
			workflowId: id,
			row: () => {
				try {
					return instance(db, id);
				} catch {
					return undefined;
				}
			},
			runs: () => runs(db, id),
			effects: () => effects(db, id),
		},
		registry,
		now,
	);
}

/** One `WorkflowView` from rows a caller already holds. The read path is the
 * same one `view` always ran; only where its rows come from differs. */
export function viewFromRows(
	db: Database,
	rows: ViewRows,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowView {
	try {
		const row = rows.row();
		if (!row)
			throw new WorkflowRuntimeError(
				"not-found",
				`workflow not found: ${rows.workflowId}`,
			);
		const snapshot = decodeSnapshot(JSON.parse(row.snapshot_json));
		const resolved = resolveDefinitionWithOrigin(
			registry,
			db,
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
		);
		const definition = resolved.definition;
		const runList = rows.runs();
		// The snapshot was decoded above: the schema check `validateSnapshot`
		// performs by decoding it again is already made for these exact bytes.
		validateDecodedSnapshot(snapshot, definition, runList, registry);
		const effectList = rows.effects();
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
		const waiting = workflowWait(
			waitState(
				snapshot,
				runList,
				definitionStepActor(registry, definition, snapshot.currentStep),
			),
		);
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
			// The last repair travels with the view so a reader sees why the workflow
			// sits at a step next to the blocked handoff that led there. Absent means
			// no repair has been recorded for this workflow.
			...(snapshot.repaired ? { repaired: snapshot.repaired } : {}),
			// The developer wait is read from the state that already blocks this
			// workflow, so it never disagrees with `pendingQuestions` or the run list.
			...(waiting ? { waiting } : {}),
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
				const row = rows.row();
				if (!row)
					throw new WorkflowRuntimeError(
						"not-found",
						"instance row unreadable",
					);
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
		// The row the view could not be built from, when it was readable at all:
		// the generic fallback names what the instance is, never a guess.
		// The row the view could not be built from, when it was readable at all:
		// the generic fallback names the instance, never a guess.
		const source = rows.row();
		return {
			workflowId: rows.workflowId,
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
		// One query per table rather than four per workflow. A listing of ~150
		// workflows asked SQLite for each instance, its runs, its effects and (for
		// the fallback view only) its identifying columns one workflow at a time:
		// roughly 600 statements per listing, paid by the event bus on every
		// reconcile tick and on every debounced repository refresh.
		const instances = db
			.query("SELECT * FROM workflow_instances ORDER BY updated_at DESC")
			.all() as InstanceRow[];
		if (instances.length === 0) return [];
		// The child reads stay lazy, exactly as the per-workflow path read them:
		// nothing is fetched until a view actually needs runs or effects, and the
		// grouping is built once for the whole listing when it does.
		let runsByWorkflow: Map<string, WorkflowRun[]> | undefined;
		const runsFor = (workflowId: string): WorkflowRun[] => {
			runsByWorkflow ??= groupByWorkflow(
				db
					.query("SELECT * FROM workflow_runs ORDER BY rowid")
					.all() as RunRow[],
				runFromRow,
			);
			return runsByWorkflow.get(workflowId) ?? [];
		};
		let effectsByWorkflow: Map<string, WorkflowEffect[]> | undefined;
		const effectsFor = (workflowId: string): WorkflowEffect[] => {
			effectsByWorkflow ??= groupByWorkflow(
				db
					.query("SELECT * FROM workflow_outbox ORDER BY rowid")
					.all() as EffectRow[],
				effectFromRow,
			);
			return effectsByWorkflow.get(workflowId) ?? [];
		};
		return instances.map((row) =>
			viewFromRows(
				db,
				{
					workflowId: row.id,
					row: () => row,
					runs: () => runsFor(row.id),
					effects: () => effectsFor(row.id),
				},
				registry,
				now,
			),
		);
	} finally {
		db.close();
	}
}

/** Group child rows by the workflow they belong to, keeping the row order one
 * workflow's own query returned (rowid order). */
function groupByWorkflow<Row extends { workflow_id: string }, Value>(
	rows: readonly Row[],
	map: (row: Row) => Value,
): Map<string, Value[]> {
	const grouped = new Map<string, Value[]>();
	for (const row of rows) {
		const values = grouped.get(row.workflow_id);
		if (values) values.push(map(row));
		else grouped.set(row.workflow_id, [map(row)]);
	}
	return grouped;
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
