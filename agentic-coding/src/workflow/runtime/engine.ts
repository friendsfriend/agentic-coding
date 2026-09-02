// The transactional kernel: `WorkflowEngine`'s public API (start, dispatch,
// status, list, capability issuance/authorization delegates, effect
// claiming) and the `reduce()` command-type dispatch table that replaces the
// former private-method branch chain. Every reducer, and every leaf helper
// (store/evidence/capability/dialogue/migration/view/kernel), is imported
// rather than reimplemented here — this file is the residue once all of
// that is moved out. Moved out of runtime.ts (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	commandContract,
	parseSnapshot,
	type WorkflowCommand,
	type WorkflowRun,
	WorkflowRuntimeError,
	type WorkflowSnapshot,
	type WorkflowView,
} from "../contracts.ts";
import { effectiveManifestPolicy } from "../definitions.ts";
import {
	childTrace,
	parseTraceparent,
	TelemetrySink,
	traceparent,
} from "../observability.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import { ensureBundle, wikiRoot } from "../wiki.ts";
import {
	authorizeAgentCapability as capabilityAuthorizeAgentCapability,
	authorizeExactRunCapability as capabilityAuthorizeExactRunCapability,
	issueRunCapability as capabilityIssueRunCapability,
	hashToken,
} from "./capability.ts";
import type {
	ClaimedEffect,
	DispatchResult,
	RepairPreview,
	StartWorkflowInput,
} from "./engine-types.ts";
import {
	currentBranch,
	sourceContentFingerprint,
	validateStartEvidence,
	wikiBaselineFor,
} from "./evidence.ts";
import {
	enqueue,
	enterStep,
	freshStep,
	validateFusionRouting,
} from "./kernel.ts";
import { agentHandoff } from "./reducers/agent-handoff.ts";
import { agentQuestion, expireQuestion } from "./reducers/agent-question.ts";
import { developerAction } from "./reducers/developer-action.ts";
import { effectResult } from "./reducers/effect-result.ts";
import { repair, repin, resume } from "./reducers/repair.ts";
import { recordResearchHandoff } from "./reducers/research-handoff.ts";
import {
	type EffectRow,
	effectFromRow,
	type InstanceRow,
	instance,
	json,
	nowIso,
	openStore,
	payload,
	rollback,
	runs,
	activeRunForRole as storeActiveRunForRole,
	effectIsLive as storeEffectIsLive,
	getRun as storeGetRun,
	getSnapshot as storeGetSnapshot,
	validateEffect,
	validateSnapshot,
	writeSnapshot,
} from "./store.ts";
import {
	canonicalRepository,
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	validateWorkflowId,
	wikiWorkflowDataRoot,
} from "./targets.ts";
import {
	viewById,
	list as viewList,
	previewRepair as viewPreviewRepair,
	status as viewStatus,
} from "./view.ts";

export class WorkflowEngine {
	constructor(
		readonly registry: WorkflowRegistry,
		private readonly now: () => Date = () => new Date(),
		private readonly onCommitted: (repository: string) => void = () => {},
	) {}
	start(input: StartWorkflowInput): DispatchResult {
		validateWorkflowId(input.workflowId);
		// Resolved before the target-kind guard so the guard reads the pinned
		// definition's declared policy (design D1) instead of comparing
		// `input.definitionId` against a literal id or id array.
		const definition = this.registry.definition(
			input.definitionId,
			input.definitionVersion ?? 1,
		);
		const policy = effectiveManifestPolicy(definition);
		const wikiOnlyTarget =
			isWikiWorkflowTarget(input.repo) && policy.targetKind === "wiki";
		const researchTarget = isResearchWorkflowTarget(input.repo);
		if (
			(isWikiWorkflowTarget(input.repo) && !wikiOnlyTarget) ||
			(researchTarget && policy.targetKind !== "research")
		)
			throw new WorkflowRuntimeError(
				"start-guard",
				"the repository-independent target is invalid for this workflow",
			);
		const repository = researchTarget
			? input.repositoryContext
				? canonicalRepository(input.repositoryContext)
				: ""
			: wikiOnlyTarget
				? ""
				: canonicalRepository(input.repo);
		// Keep an explicitly supplied worktree path for the workflow view while
		// resolving it separately for repository guards. On macOS, /var is a
		// symlink to /private/var; canonicalizing the stored path would make the
		// view differ from the path the caller supplied.
		const worktree = researchTarget
			? path.resolve(wikiWorkflowDataRoot())
			: wikiOnlyTarget
				? path.resolve(ensureBundle())
				: input.worktree === undefined
					? fs.realpathSync(path.resolve(input.repo))
					: path.resolve(input.worktree);
		if (researchTarget) fs.mkdirSync(worktree, { recursive: true });
		const resolvedWorktree = fs.realpathSync(worktree);
		if (policy.requiresReadOnlyResearcher) {
			const route = input.routing.routes.find(
				(item) =>
					item.stepId === definition.initial && item.role === "researcher",
			);
			if (
				!route?.profile.capabilities.includes("read-only") ||
				route.profile.capabilities.includes("shell") ||
				route.profile.capabilities.includes("edit")
			)
				throw new WorkflowRuntimeError(
					"start-guard",
					"research requires a read-only researcher profile without shell or edit capabilities",
				);
		}
		// Distinct from `policy.checkoutRequired`: this decides whether start
		// seeds a source-content baseline, not whether checkout mode is
		// required — `openspec-propose`/`openspec-fusion-propose` also require
		// checkout but never seed this baseline.
		const wikiOnly = definition.id === "wiki";
		if (researchTarget && !input.metadata.task?.trim())
			throw new WorkflowRuntimeError(
				"start-guard",
				"research requires non-empty task",
			);
		const sameCheckout = policy.checkoutRequired;
		if (sameCheckout) {
			if (input.mode !== "checkout")
				throw new WorkflowRuntimeError(
					"start-guard",
					"proposal workflows require checkout mode",
				);
			if (resolvedWorktree !== repository)
				throw new WorkflowRuntimeError(
					"start-guard",
					"proposal workflows must use the repository checkout",
				);
			const branch = currentBranch(repository);
			if (!branch || input.metadata.branch !== branch)
				throw new WorkflowRuntimeError(
					"start-guard",
					"proposal workflows require the named current branch",
				);
		}
		if (!wikiOnlyTarget && !researchTarget)
			validateStartEvidence(repository, input, sameCheckout);
		if (
			["openspec-fusion-full", "openspec-fusion-propose"].includes(
				definition.id,
			)
		)
			validateFusionRouting(definition.id, input.routing);
		const at = nowIso(this.now);
		const workflowId = input.workflowId;
		// No change identifier exists at start: the planner chooses the change
		// id(s) during the plan step, and the engine records the declared
		// primary into metadata.changeId at plan handoff. `openspec-apply` has
		// no planner step, so its pre-existing change is the workflow id itself.
		const startChangeId =
			input.definitionId === "openspec-apply" ? input.workflowId : "";
		const snapshot: WorkflowSnapshot = {
			schemaVersion: 1,
			workflowId,
			revision: 0,
			definition: {
				id: definition.id,
				version: definition.version,
				digest: definition.digest,
			},
			status: "active",
			currentStep: definition.initial,
			step: {
				...freshStep(1),
				...(input.context === undefined
					? {}
					: { context: payload(input.context) }),
			},
			metadata: {
				...input.metadata,
				repository,
				worktree,
				changeId: startChangeId,
				createdAt: at,
				updatedAt: at,
				stepEnteredAt: at,
				...(definition.steps.includes("core.wiki") ||
				definition.id === "research"
					? { wikiRoot: path.resolve(wikiRoot()) }
					: {}),
			},
			routing: input.routing,
			evidence: [],
			loopCounts: {},
			attention: [],
			developerDialogue: [],
			...(wikiOnly || (researchTarget && repository)
				? {
						sourceBaseline: {
							fingerprint: sourceContentFingerprint(
								repository,
								path.resolve(wikiRoot()),
							),
						},
					}
				: {}),
			...(wikiOnlyTarget
				? { wikiBaseline: wikiBaselineFor(worktree, input.context) }
				: {}),
		};
		validateSnapshot(snapshot, definition, [], this.registry);
		const storeTarget =
			wikiOnlyTarget || researchTarget ? input.repo : repository;
		const db = openStore(storeTarget);
		try {
			db.exec("BEGIN IMMEDIATE");
			if (
				db
					.query("SELECT 1 FROM workflow_instances WHERE id=?")
					.get(input.workflowId)
			)
				throw new WorkflowRuntimeError(
					"already-exists",
					`workflow already exists: ${input.workflowId}`,
				);
			db.query(
				"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
			).run(
				workflowId,
				startChangeId,
				repository,
				worktree,
				definition.id,
				definition.version,
				definition.digest,
				0,
				snapshot.status,
				snapshot.currentStep,
				json(snapshot),
				at,
				at,
			);
			db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
				workflowId,
				0,
				"workflow.started",
				json({ kind: "developer" }),
				json({ definition: snapshot.definition }),
				at,
			);
			if (input.mode || wikiOnlyTarget || researchTarget)
				enqueue(
					db,
					snapshot,
					"workspace.setup",
					`workspace:${workflowId}:setup`,
					{
						mode: input.mode ?? (researchTarget ? "research" : "wiki"),
						sameCheckout,
						branch: snapshot.metadata.branch,
						baseCommit: snapshot.metadata.baseCommit,
						...(wikiOnlyTarget ? { wikiRoot: worktree } : {}),
					},
				);
			else enterStep(db, snapshot, definition, this.registry, this.now);
			writeSnapshot(db, snapshot);
			db.exec("COMMIT");
		} catch (error) {
			rollback(db);
			throw error;
		} finally {
			db.close();
		}
		this.telemetry(snapshot, "workflow.started");
		this.onCommitted(storeTarget);
		return {
			snapshot,
			view: viewById(storeTarget, workflowId, this.registry, this.now),
		};
	}
	dispatch(repo: string, raw: unknown): DispatchResult {
		const command = commandContract.parse(raw);
		const db = openStore(repo);
		try {
			db.exec("BEGIN IMMEDIATE");
			const located = this.locate(db, command);
			const snapshot = parseSnapshot(JSON.parse(located.snapshot_json));
			const repin =
				command.type === "operator.repin" ||
				(command.type === "developer.action" && command.actionId === "re-pin");
			const definition = repin
				? this.registry.definition(
						snapshot.definition.id,
						snapshot.definition.version,
					)
				: this.registry.definition(
						snapshot.definition.id,
						snapshot.definition.version,
						snapshot.definition.digest,
					);
			const runList = runs(db, snapshot.workflowId);
			if (!repin)
				validateSnapshot(snapshot, definition, runList, this.registry);
			const event = this.reduce(db, snapshot, definition, command);
			snapshot.revision += 1;
			snapshot.metadata.updatedAt = nowIso(this.now);
			validateSnapshot(
				snapshot,
				definition,
				runs(db, snapshot.workflowId),
				this.registry,
			);
			writeSnapshot(db, snapshot);
			db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
				snapshot.workflowId,
				snapshot.revision,
				event.type,
				json(event.actor),
				json(event.data),
				nowIso(this.now),
			);
			db.exec("COMMIT");
			this.telemetry(
				snapshot,
				event.type,
				command.type === "agent.handoff" ||
					command.type === "agent.question" ||
					command.type === "agent.question-expire" ||
					command.type === "agent.research-handoff"
					? { runId: command.runId }
					: command.type === "effect.result"
						? { effectId: command.effectId }
						: undefined,
			);
			this.onCommitted(
				isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)
					? wikiRoot(true)
					: canonicalRepository(repo),
			);
			return {
				snapshot,
				view: viewById(repo, snapshot.workflowId, this.registry, this.now),
			};
		} catch (error) {
			rollback(db);
			if (
				error instanceof WorkflowRuntimeError &&
				["unauthorized", "stale-run", "artifact", "stale-effect"].includes(
					error.code,
				)
			) {
				const subject =
					command.type === "agent.handoff"
						? command.runId
						: command.type === "effect.result"
							? command.effectId
							: command.type;
				try {
					db.query(
						"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
					).run(
						randomUUID(),
						null,
						command.type,
						subject,
						error.message.slice(0, 2048),
						nowIso(this.now),
					);
				} catch {
					/* bounded rejection audit is best effort */
				}
			}
			throw error;
		} finally {
			db.close();
		}
	}
	status(repo: string, workflowId: string): WorkflowView {
		return viewStatus(repo, workflowId, this.registry, this.now);
	}
	previewRepair(repo: string, workflowId: string): RepairPreview[] {
		return viewPreviewRepair(repo, workflowId, this.registry);
	}
	effectIsLive(repo: string, effectId: string, lease: string): boolean {
		return storeEffectIsLive(repo, effectId, lease);
	}
	claimEffects(repo: string, limit = 10, leaseMs = 30_000): ClaimedEffect[] {
		const db = openStore(repo);
		const claimed: ClaimedEffect[] = [];
		try {
			db.exec("BEGIN IMMEDIATE");
			const at = this.now();
			const rows = db
				.query(
					`SELECT * FROM workflow_outbox AS ready WHERE ((ready.status IN ('pending','retry') AND (ready.next_attempt_at IS NULL OR ready.next_attempt_at<=?)) OR (ready.status='running' AND ready.lease_expires_at<=?)) AND NOT (ready.kind IN ('delivery.commit','delivery.push') AND EXISTS (SELECT 1 FROM workflow_outbox AS promotion WHERE promotion.workflow_id=ready.workflow_id AND promotion.kind='wiki.verify' AND promotion.status<>'completed')) ORDER BY ready.rowid LIMIT ?`,
				)
				.all(at.toISOString(), at.toISOString(), limit) as EffectRow[];
			for (const row of rows) {
				const owner = instance(db, row.workflow_id);
				const snapshot = parseSnapshot(JSON.parse(owner.snapshot_json));
				const definition = this.registry.definition(
					snapshot.definition.id,
					snapshot.definition.version,
					snapshot.definition.digest,
				);
				const runList = runs(db, snapshot.workflowId);
				validateSnapshot(snapshot, definition, runList, this.registry);
				validateEffect(row, snapshot, runList, this.registry);
				const lease = randomUUID();
				const expires = new Date(at.getTime() + leaseMs).toISOString();
				db.query(
					"UPDATE workflow_outbox SET status='running', attempts=attempts+1, lease=?, lease_expires_at=? WHERE id=?",
				).run(lease, expires, row.id);
				const effect = {
					...effectFromRow({
						...row,
						status: "running",
						attempts: row.attempts + 1,
						lease,
						lease_expires_at: expires,
					}),
					lease,
				} as ClaimedEffect;
				if (effect.kind === "agent.launch") {
					const runId = String(
						(effect.payload as { runId?: string }).runId ?? "",
					);
					const run = runList.find((item) => item.id === runId);
					if (!run)
						throw new Error(`agent.launch references unknown run ${runId}`);
					if (!run.capabilityHash) {
						const token = randomBytes(32).toString("base64url");
						db.query(
							"UPDATE workflow_runs SET capability_hash=? WHERE id=? AND status IN ('pending','working')",
						).run(hashToken(token), runId);
						effect.runToken = token;
					}
				}
				claimed.push(effect);
			}
			db.exec("COMMIT");
			return claimed;
		} catch (error) {
			rollback(db);
			throw error;
		} finally {
			db.close();
		}
	}
	issueRunCapability(repo: string, runId: string): string {
		return capabilityIssueRunCapability(repo, runId);
	}
	list(repo: string): WorkflowView[] {
		return viewList(repo, this.registry, this.now);
	}
	getRun(repo: string, runId: string): WorkflowRun {
		return storeGetRun(repo, runId);
	}
	// See store.ts's `activeRunForRole` doc comment for why this resolves by
	// (workflowId, stepId, role) rather than a client-supplied
	// runId/generation/token.
	activeRunForRole(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
	): WorkflowRun {
		return storeActiveRunForRole(repo, workflowId, stepId, role);
	}
	/** Validate the launch-bound capability for a role-scoped CLI operation. */
	authorizeAgentCapability(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
		token: string,
	): WorkflowRun {
		return capabilityAuthorizeAgentCapability(
			repo,
			workflowId,
			stepId,
			role,
			token,
			this.registry,
			this.now,
		);
	}
	/** Validate a capability against the exact run that issued it. This is used
	 * by subprocess-facing commands; role-scoped lookup is intentionally not
	 * sufficient because a child process must not select a sibling run. */
	authorizeExactRunCapability(
		repo: string,
		workflowId: string,
		runId: string,
		stepId: string,
		role: string,
		token: string,
	): WorkflowRun {
		return capabilityAuthorizeExactRunCapability(
			repo,
			workflowId,
			runId,
			stepId,
			role,
			token,
			this.registry,
			this.now,
		);
	}
	getSnapshot(repo: string, workflowId: string): WorkflowSnapshot {
		return storeGetSnapshot(repo, workflowId, this.registry, this.now);
	}

	private telemetry(
		snapshot: WorkflowSnapshot,
		event: string,
		identity?: { runId?: string; effectId?: string },
	): void {
		const context = childTrace(parseTraceparent(process.env.TRACEPARENT));
		new TelemetrySink(
			snapshot.definition.id === "wiki-comments"
				? path.join(wikiWorkflowDataRoot(), snapshot.workflowId)
				: path.join(
						snapshot.metadata.worktree,
						".herdr-workflow",
						snapshot.workflowId,
					),
		).emit({
			schemaVersion: 1,
			at: nowIso(this.now),
			layer: "engine",
			event,
			workflowId: snapshot.workflowId,
			stepId: snapshot.currentStep,
			...identity,
			traceparent: traceparent(context),
		});
	}

	private reduce(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: WorkflowCommand,
	): { type: string; actor: unknown; data: unknown } {
		if (command.type === "developer.action")
			return developerAction(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
			);
		if (command.type === "agent.question")
			return agentQuestion(db, snapshot, command, this.now);
		if (command.type === "agent.question-expire")
			return expireQuestion(db, snapshot, command, this.now);
		if (command.type === "agent.handoff")
			return agentHandoff(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
			);
		if (command.type === "agent.research-handoff")
			return recordResearchHandoff(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
			);
		if (command.type === "effect.result")
			return effectResult(
				db,
				snapshot,
				definition,
				command,
				this.registry,
				this.now,
			);
		if (command.type === "operator.repair")
			return repair(db, snapshot, definition, command, this.registry, this.now);
		if (command.type === "operator.repin")
			return repin(db, snapshot, definition, command, this.registry, this.now);
		if (command.type === "operator.resume")
			return resume(db, snapshot, definition, command, this.registry, this.now);
		throw new WorkflowRuntimeError("invalid-command", "unsupported command");
	}
	private locate(db: Database, command: WorkflowCommand): InstanceRow {
		if (command.type === "agent.handoff") {
			const row = db
				.query("SELECT workflow_id FROM workflow_runs WHERE id=?")
				.get(command.runId) as { workflow_id: string } | null;
			if (!row) throw new WorkflowRuntimeError("not-found", "run not found");
			return instance(db, row.workflow_id);
		}
		if (command.type === "effect.result") {
			const row = db
				.query("SELECT workflow_id FROM workflow_outbox WHERE id=?")
				.get(command.effectId) as { workflow_id: string } | null;
			if (!row) throw new WorkflowRuntimeError("not-found", "effect not found");
			return instance(db, row.workflow_id);
		}
		return instance(db, command.workflowId);
	}
}
