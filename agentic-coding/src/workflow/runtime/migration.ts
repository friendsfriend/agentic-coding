// Legacy `workflows` table discovery, phase-to-step mapping, legacy evidence
// conversion, and migration diagnostics. Least-covered path in the package
// (see docs/workflow-architecture.md) — moved verbatim, with no signature
// change beyond taking registry and clock as explicit parameters instead of
// `this`. Moved out of runtime.ts (split-workflow-god-modules).
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowSnapshot } from "../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import { enterStep, freshStep } from "./kernel.ts";
import {
	boundedError,
	json,
	nowIso,
	rollback,
	tableExists,
	validateSnapshot,
	writeSnapshot,
} from "./store.ts";
import { canonicalStorePath } from "./targets.ts";

function stableLegacy(raw: string): string {
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		for (const key of [
			"verificationSecondRowPane",
			"verificationSecondRowRole",
			"verificationPaneOrder",
			"panes",
			"tabs",
		])
			delete value[key];
		const sort = (item: unknown): unknown =>
			Array.isArray(item)
				? item.map(sort)
				: item && typeof item === "object"
					? Object.fromEntries(
							Object.entries(item as Record<string, unknown>)
								.sort(([a], [b]) => a.localeCompare(b))
								.map(([key, child]) => [key, sort(child)]),
						)
					: item;
		return JSON.stringify(sort(value));
	} catch {
		return raw;
	}
}
function legacyEvidence(
	worktree: string,
	changeId: string,
): WorkflowSnapshot["evidence"] {
	const files = [
		path.join(worktree, ".herdr-workflow", changeId, "request.md"),
		path.join(worktree, "openspec", "changes", changeId, "proposal.md"),
		path.join(worktree, "openspec", "changes", changeId, "design.md"),
		path.join(worktree, "openspec", "changes", changeId, "tasks.md"),
	];
	return files.flatMap((file) => {
		try {
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error(`unsafe legacy evidence: ${file}`);
			return [
				{
					kind: path.basename(file),
					path: file,
					digest: createHash("sha256")
						.update(fs.readFileSync(file))
						.digest("hex"),
				},
			];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	});
}

export function migrationDiagnostic(
	db: Database,
	repository: string,
	changeId: string,
	diagnostic: string,
	source: string,
	now: () => Date,
): void {
	db.query(
		"INSERT OR REPLACE INTO workflow_migration_diagnostics VALUES (?,?,?,?,?)",
	).run(
		changeId,
		repository,
		diagnostic.slice(0, 2048),
		source.slice(0, 65536),
		nowIso(now),
	);
}

export function migrateLegacy(
	db: Database,
	repository: string,
	changeId: string,
	registry: WorkflowRegistry,
	now: () => Date,
): void {
	if (!tableExists(db, "workflows")) return;
	const source = db
		.query("SELECT state FROM workflows WHERE change_id=?")
		.get(changeId) as { state: string } | null;
	if (!source) return;
	let legacy: Record<string, unknown>;
	try {
		const value = JSON.parse(source.state);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("state must be object");
		legacy = value as Record<string, unknown>;
	} catch (error) {
		migrationDiagnostic(
			db,
			repository,
			changeId,
			`malformed legacy state: ${boundedError(error)}`,
			source.state,
			now,
		);
		return;
	}
	const worktree =
		typeof legacy.worktree === "string"
			? path.resolve(legacy.worktree)
			: repository;
	const mirror = path.join(worktree, ".herdr-workflow", "herdr.db");
	if (
		path.resolve(mirror) !== path.resolve(canonicalStorePath(repository)) &&
		fs.existsSync(mirror)
	) {
		try {
			const mirrorDb = new Database(mirror, { readonly: true });
			try {
				if (tableExists(mirrorDb, "workflows")) {
					const other = mirrorDb
						.query("SELECT state FROM workflows WHERE change_id=?")
						.get(changeId) as { state: string } | null;
					if (
						other &&
						stableLegacy(other.state) !== stableLegacy(source.state)
					) {
						migrationDiagnostic(
							db,
							repository,
							changeId,
							"conflicting repository and worktree legacy mirrors",
							source.state,
							now,
						);
						return;
					}
				}
			} finally {
				mirrorDb.close();
			}
		} catch (error) {
			migrationDiagnostic(
				db,
				repository,
				changeId,
				`legacy mirror unavailable: ${boundedError(error)}`,
				source.state,
				now,
			);
			return;
		}
	}
	const phase = String(legacy.phase ?? "");
	const legacyWorkflowType =
		typeof legacy.workflowType === "string" ? legacy.workflowType : undefined;
	const workflowType =
		legacyWorkflowType === "standard"
			? "openspec-full"
			: (legacyWorkflowType ??
				(Array.isArray(legacy.workflowModules) &&
				!(legacy.workflowModules as unknown[]).includes("plan")
					? (legacy.workflowModules as unknown[]).includes("archive")
						? "openspec-apply"
						: "no-openspec"
					: "openspec-full"));
	const stepMap: Record<string, string> = {
		explore: "core.plan",
		proposed: "core.plan-approval",
		apply: "core.implementation",
		fix: "core.implementation",
		triage: "core.triage",
		verify: "core.verification",
		"developer-review": "core.developer-review",
		archive: "core.archive",
		committing: "core.delivery",
		completed: "core.completed",
		closed: "core.closed",
	};
	const currentStep =
		phase === "paused" ? "core.implementation" : stepMap[phase];
	let definition: CompiledWorkflowDefinition;
	try {
		definition = registry.definition(workflowType, 1);
		if (!currentStep || !definition.steps.includes(currentStep))
			throw new Error(`phase ${phase} cannot map to ${workflowType}`);
	} catch (error) {
		migrationDiagnostic(
			db,
			repository,
			changeId,
			`legacy mapping failed: ${boundedError(error)}`,
			source.state,
			now,
		);
		return;
	}
	const at = nowIso(now);
	const workflowId = randomUUID();
	const model =
		typeof legacy.workerModel === "string" ? legacy.workerModel : undefined;
	const profile = {
		name: "legacy-pi",
		runtime: "pi" as const,
		executable: "pi",
		...(model ? { model } : {}),
		tools: ["read", "bash", "edit", "write"],
		extensions: [],
		readOnly: false,
		capabilities: [
			"interactive",
			"prompt",
			"persistent-session",
			"run-environment",
			"observe",
			"shell",
			"edit",
			"runtime-bridge",
		] as const,
		digest: createHash("sha256")
			.update(json({ runtime: "pi", model }))
			.digest("hex"),
	};
	const routing = {
		defaultProfile: profile.name,
		routes: definition.steps
			.filter((id) => registry.step(id).actor === "agent")
			.map((stepId) => ({ stepId, profile })),
	};
	const status =
		phase === "paused"
			? "paused"
			: phase === "completed"
				? "completed"
				: phase === "closed"
					? "closed"
					: "active";
	let evidence: WorkflowSnapshot["evidence"];
	try {
		evidence = legacyEvidence(worktree, changeId);
	} catch (error) {
		migrationDiagnostic(
			db,
			repository,
			changeId,
			`legacy evidence invalid: ${boundedError(error)}`,
			source.state,
			now,
		);
		return;
	}
	const snapshot: WorkflowSnapshot = {
		schemaVersion: 1,
		workflowId,
		revision: 1,
		definition: {
			id: definition.id,
			version: definition.version,
			digest: definition.digest,
		},
		status,
		currentStep,
		step: freshStep(Math.max(1, Number(legacy.verificationRound ?? 1))),
		metadata: {
			repository,
			worktree,
			changeId,
			branch: String(legacy.branch ?? "unknown"),
			baseBranch: String(legacy.baseBranch ?? "unknown"),
			baseCommit: String(legacy.baseCommit ?? "unknown"),
			...(typeof legacy.workspace === "string"
				? { workspace: legacy.workspace }
				: {}),
			...(typeof legacy.task === "string" && legacy.task.trim()
				? { task: legacy.task }
				: {}),
			...(typeof legacy.ticketNumber === "string"
				? { ticket: legacy.ticketNumber }
				: {}),
			createdAt: typeof legacy.createdAt === "string" ? legacy.createdAt : at,
			updatedAt: at,
			stepEnteredAt: at,
		},
		routing,
		evidence,
		loopCounts:
			currentStep === "core.verification"
				? {
						"core.verification:round": Math.max(
							1,
							Number(legacy.verificationRound ?? 1),
						),
					}
				: {},
		attention: [],
		developerDialogue: [],
	};
	try {
		validateSnapshot(snapshot, definition, [], registry);
		db.exec("BEGIN IMMEDIATE");
		db.query(
			"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			workflowId,
			changeId,
			repository,
			worktree,
			definition.id,
			definition.version,
			definition.digest,
			1,
			snapshot.status,
			currentStep,
			json(snapshot),
			snapshot.metadata.createdAt,
			at,
		);
		db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
			workflowId,
			1,
			"legacy.migrated",
			json({ kind: "system" }),
			json({ sourceVersion: 0, phase, workflowType }),
			at,
		);
		if (snapshot.status === "active")
			enterStep(db, snapshot, definition, registry, now);
		writeSnapshot(db, snapshot);
		db.query(
			"DELETE FROM workflow_migration_diagnostics WHERE change_id=?",
		).run(changeId);
		db.exec("COMMIT");
	} catch (error) {
		rollback(db);
		migrationDiagnostic(
			db,
			repository,
			changeId,
			`legacy migration failed: ${boundedError(error)}`,
			source.state,
			now,
		);
	}
}
