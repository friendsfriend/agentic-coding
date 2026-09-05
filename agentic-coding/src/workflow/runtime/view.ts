// The read model: workflow/list/status projection, repair preview, and the
// run/effect projection into `WorkflowView`. Read path only. Moved verbatim
// out of runtime.ts (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type { WorkflowView } from "../contracts.ts";
import { parseSnapshot, WorkflowRuntimeError } from "../contracts.ts";
import type { WorkflowRegistry } from "../registry.ts";
import type { RepairPreview } from "./engine-types.ts";
import { migrateLegacy } from "./migration.ts";
import {
	ACTIVE_RUN,
	actions,
	boundedError,
	effects,
	expireDueQuestions,
	instance,
	openStore,
	runs,
	tableExists,
	validateSnapshot,
} from "./store.ts";
import { canonicalRepository, isWikiWorkflowTarget } from "./targets.ts";

export function diagnosticView(
	changeId: string,
	diagnostic: string,
): WorkflowView {
	return {
		workflowId: `legacy:${changeId}`,
		changeId,
		revision: 0,
		definition: {
			id: "migration-required",
			version: 0,
			digest: "",
			label: "Migration required",
		},
		status: "attention-required",
		repository: "",
		worktree: "",
		branch: "",
		baseCommit: "",
		createdAt: "",
		updatedAt: "",
		currentStep: {
			id: "repair-required",
			label: "Repair required",
			attempt: 0,
			enteredAt: "",
		},
		runs: [],
		routing: { defaultProfile: "", routes: [] },
		effects: [],
		observations: [],
		health: { valid: false, attention: [diagnostic], diagnostic },
		developerDialogue: [],
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
		const snapshot = parseSnapshot(JSON.parse(row.snapshot_json));
		const definition = registry.definition(
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
		);
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
		const availableActions = actions(snapshot, registry).filter(
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
			status: snapshot.status,
			repository: snapshot.metadata.repository,
			worktree: snapshot.metadata.worktree,
			branch: snapshot.metadata.branch,
			baseCommit: snapshot.metadata.baseCommit,
			...(snapshot.metadata.workspace
				? { workspace: snapshot.metadata.workspace }
				: {}),
			...(snapshot.metadata.task !== undefined
				? { task: snapshot.metadata.task }
				: {}),
			createdAt: snapshot.metadata.createdAt,
			updatedAt: snapshot.metadata.updatedAt,
			currentStep: {
				id: snapshot.currentStep,
				label: registry.step(snapshot.currentStep).label,
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
				...(run.handle?.paneId ? { paneId: run.handle.paneId } : {}),
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
			developerDialogue: snapshot.developerDialogue,
			pendingQuestions: snapshot.developerDialogue.filter(
				(item) =>
					item.status === "pending" &&
					Date.parse(item.expiresAt) > now().getTime(),
			),
			availableActions: [...availableActions, ...failedActions],
		};
	} catch (error) {
		const diagnostic = boundedError(error);
		if (/pin mismatch/.test(diagnostic)) {
			try {
				const row = instance(db, id);
				const snapshot = parseSnapshot(JSON.parse(row.snapshot_json));
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
					...(snapshot.metadata.workspace
						? { workspace: snapshot.metadata.workspace }
						: {}),
					...(snapshot.metadata.task !== undefined
						? { task: snapshot.metadata.task }
						: {}),
					createdAt: snapshot.metadata.createdAt,
					updatedAt: snapshot.metadata.updatedAt,
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
					developerDialogue: snapshot.developerDialogue,
					pendingQuestions: snapshot.developerDialogue.filter(
						(item) =>
							item.status === "pending" &&
							Date.parse(item.expiresAt) > now().getTime(),
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
	const db = openStore(repo);
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
	const db = openStore(repo);
	try {
		// Primary addressing is by the user-supplied workflow id (the row key).
		// Fall back to the recorded change id so in-flight workflows started
		// before the identity split remain addressable by the id they were
		// started with, then to the legacy `workflows` table migration path.
		let row = db
			.query("SELECT id FROM workflow_instances WHERE id=?")
			.get(workflowId) as { id: string } | null;
		if (!row)
			row = db
				.query("SELECT id FROM workflow_instances WHERE change_id=?")
				.get(workflowId) as { id: string } | null;
		if (!row) {
			if (!isWikiWorkflowTarget(repo))
				migrateLegacy(db, canonicalRepository(repo), workflowId, registry, now);
			row = db
				.query("SELECT id FROM workflow_instances WHERE change_id=?")
				.get(workflowId) as { id: string } | null;
		}
		if (!row) {
			const diagnostic = db
				.query(
					"SELECT diagnostic FROM workflow_migration_diagnostics WHERE change_id=?",
				)
				.get(workflowId) as { diagnostic: string } | null;
			if (diagnostic) return diagnosticView(workflowId, diagnostic.diagnostic);
			throw new WorkflowRuntimeError(
				"not-found",
				`workflow not found: ${workflowId}`,
			);
		}
		expireDueQuestions(db, row.id, registry, now);
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
	const db = openStore(repo);
	try {
		if (tableExists(db, "workflows"))
			for (const row of db
				.query("SELECT change_id FROM workflows")
				.all() as Array<{ change_id: string }>)
				if (
					!db
						.query("SELECT 1 FROM workflow_instances WHERE change_id=?")
						.get(row.change_id)
				)
					if (!isWikiWorkflowTarget(repo))
						migrateLegacy(
							db,
							canonicalRepository(repo),
							row.change_id,
							registry,
							now,
						);
		const views = (
			db
				.query("SELECT id FROM workflow_instances ORDER BY updated_at DESC")
				.all() as Array<{ id: string }>
		).map((row) => view(db, row.id, registry, now));
		const diagnostics = (
			db
				.query(
					"SELECT change_id,diagnostic FROM workflow_migration_diagnostics",
				)
				.all() as Array<{ change_id: string; diagnostic: string }>
		).map((row) => diagnosticView(row.change_id, row.diagnostic));
		return [...views, ...diagnostics];
	} finally {
		db.close();
	}
}

export function previewRepair(
	repo: string,
	workflowId: string,
	registry: WorkflowRegistry,
): RepairPreview[] {
	const db = openStore(repo);
	try {
		const row = instance(db, workflowId);
		const snapshot = parseSnapshot(JSON.parse(row.snapshot_json));
		const definition = registry.definition(
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
					registry.step(stepId).actor !== "system",
			)
			.map((stepId) => ({
				targetStep: stepId,
				label: registry.step(stepId).label,
				expiresRuns: activeRuns.map((run) => run.id),
				retainedEvidence: snapshot.evidence.map((item) => item.digest),
			}));
	} finally {
		db.close();
	}
}
