import { Database } from "bun:sqlite";
import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
	DeveloperDialogueRecord,
	DeveloperQuestionItem,
	EffectKind,
	JsonValue,
	WorkflowActionView,
	WorkflowCommand,
	WorkflowEffect,
	WorkflowRouting,
	WorkflowRun,
	WorkflowSnapshot,
	WorkflowView,
} from "./contracts.ts";
import {
	commandContract,
	type DeveloperQuestionAnswer,
	parseDeveloperQuestionAnswer,
	parseSnapshot,
} from "./contracts.ts";
import { researchHandoffContract } from "./definitions.ts";
import {
	childTrace,
	parseTraceparent,
	TelemetrySink,
	traceparent,
} from "./observability.ts";
import type {
	CompiledWorkflowDefinition,
	StepDefinition,
	WorkflowRegistry,
} from "./registry.ts";
import { fusionPlannerRoles as stepFusionPlannerRoles } from "./steps/planning.ts";
import {
	conceptPath,
	ensureBundle,
	listConcepts,
	snapshotList,
	wikiBundleFingerprint,
	wikiConceptFingerprint,
	wikiRoot,
} from "./wiki.ts";

const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_DEVELOPER_DIALOGUE_RECORDS = 100;
export const QUESTION_WAIT_MS = 24 * 60 * 60_000;
const ACTIVE_RUN = new Set(["pending", "working"]);
const EFFECT_KINDS = new Set<EffectKind>([
	"workspace.setup",
	"artifact.write",
	"agent.launch",
	"agent.prompt",
	"agent.stop",
	"notification.show",
	"openspec.validate",
	"wiki.verify",
	"delivery.commit",
	"delivery.push",
	"pull-request.create",
	"workspace.close",
	"workspace.cleanup",
]);
export class WorkflowRuntimeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly currentRevision?: number,
	) {
		super(message);
	}
}
export function validateChangeId(value: string): string {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value))
		throw new WorkflowRuntimeError(
			"change-id",
			"change ID must be 1-80 lowercase letters, digits, or hyphens",
		);
	return value;
}

export function canonicalRepository(repo: string): string {
	const resolved = fs.realpathSync(path.resolve(repo));
	const result = Bun.spawnSync(
		[
			"git",
			"-C",
			resolved,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) throw new Error(`not a Git repository: ${repo}`);
	const common = fs.realpathSync(result.stdout.toString().trim());
	return path.basename(common) === ".git" ? path.dirname(common) : resolved;
}
/** Explicit locator for workflows that review the centralized wiki without a repository. */
export const WIKI_WORKFLOW_TARGET = "wiki://centralized";
export const RESEARCH_WORKFLOW_TARGET = "research://standalone";
export function wikiWorkflowTarget(): string {
	return WIKI_WORKFLOW_TARGET;
}
export function researchWorkflowTarget(): string {
	return RESEARCH_WORKFLOW_TARGET;
}
export function isWikiWorkflowTarget(repo: string): boolean {
	return repo === WIKI_WORKFLOW_TARGET;
}
export function isResearchWorkflowTarget(repo: string): boolean {
	return repo === RESEARCH_WORKFLOW_TARGET;
}
export function wikiWorkflowDataRoot(): string {
	return path.join(path.dirname(wikiRoot()), ".agentic-coding-workflow");
}
export function canonicalStorePath(repo: string): string {
	return isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)
		? path.join(wikiWorkflowDataRoot(), "herdr.db")
		: path.join(canonicalRepository(repo), ".herdr-workflow", "herdr.db");
}
function openStore(repo: string): Database {
	const file = canonicalStorePath(repo);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new Database(file, { create: true });
	db.exec(
		"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL",
	);
	db.exec(`
CREATE TABLE IF NOT EXISTS workflow_instances(id TEXT PRIMARY KEY, change_id TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active','paused','attention-required','completed','closed')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation));
CREATE TABLE IF NOT EXISTS workflow_events(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workflow_id,revision));
CREATE TABLE IF NOT EXISTS workflow_outbox(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','failed','expired')), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0), lease TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS workflow_security_audit(id TEXT PRIMARY KEY, workflow_id TEXT, kind TEXT NOT NULL, subject TEXT, diagnostic TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_migration_diagnostics(change_id TEXT PRIMARY KEY, repository TEXT NOT NULL, diagnostic TEXT NOT NULL, source_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status ON workflow_runs(workflow_id,status);
CREATE INDEX IF NOT EXISTS workflow_outbox_ready ON workflow_outbox(status,next_attempt_at,lease_expires_at);
`);
	const runColumns = new Set(
		(
			db.query("PRAGMA table_info(workflow_runs)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	if (!runColumns.has("issued_revision"))
		db.exec(
			"ALTER TABLE workflow_runs ADD COLUMN issued_revision INTEGER NOT NULL DEFAULT 0",
		);
	if (!runColumns.has("allowed_outcomes_json"))
		db.exec(
			`ALTER TABLE workflow_runs ADD COLUMN allowed_outcomes_json TEXT NOT NULL DEFAULT '["complete","blocked","failed"]'`,
		);
	return db;
}
interface InstanceRow {
	id: string;
	change_id: string;
	definition_id: string;
	definition_version: number;
	definition_digest: string;
	revision: number;
	snapshot_json: string;
}
interface RunRow {
	id: string;
	workflow_id: string;
	step_id: string;
	role: string;
	generation: number;
	attempt: number;
	status: WorkflowRun["status"];
	profile_json: string;
	issued_revision: number;
	allowed_outcomes_json: string;
	capability_hash: string;
	capability_expires_at: string;
	assignment_path: string;
	output_path: string | null;
	output_schema_id: string | null;
	output_schema_version: number | null;
	output_digest: string | null;
	handle_json: string | null;
	created_at: string;
	completed_at: string | null;
}
interface EffectRow {
	id: string;
	workflow_id: string;
	revision: number;
	kind: EffectKind;
	idempotency_key: string;
	payload_json: string;
	status: WorkflowEffect["status"];
	attempts: number;
	max_attempts: number;
	lease: string | null;
	lease_expires_at: string | null;
	next_attempt_at: string | null;
	last_error: string | null;
}
function runFromRow(row: RunRow): WorkflowRun {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		stepId: row.step_id,
		role: row.role,
		generation: row.generation,
		attempt: row.attempt,
		status: row.status,
		profile: JSON.parse(row.profile_json),
		issuedRevision: row.issued_revision,
		allowedOutcomes: JSON.parse(row.allowed_outcomes_json),
		capabilityHash: row.capability_hash,
		capabilityExpiresAt: row.capability_expires_at,
		assignmentPath: row.assignment_path,
		...(row.output_path ? { outputPath: row.output_path } : {}),
		...(row.output_schema_id && row.output_schema_version
			? {
					outputSchema: {
						id: row.output_schema_id,
						version: row.output_schema_version,
					},
				}
			: {}),
		...(row.output_digest ? { outputDigest: row.output_digest } : {}),
		...(row.handle_json ? { handle: JSON.parse(row.handle_json) } : {}),
		createdAt: row.created_at,
		...(row.completed_at ? { completedAt: row.completed_at } : {}),
	};
}
function effectFromRow(row: EffectRow): WorkflowEffect {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		revision: row.revision,
		kind: row.kind,
		idempotencyKey: row.idempotency_key,
		payload: JSON.parse(row.payload_json),
		status: row.status,
		attempts: row.attempts,
		maxAttempts: row.max_attempts,
		...(row.lease ? { lease: row.lease } : {}),
		...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
		...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
		...(row.last_error ? { lastError: row.last_error } : {}),
	};
}
function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
function tokenMatches(token: string, hash: string): boolean {
	const actual = Buffer.from(hashToken(token), "hex");
	const expected = Buffer.from(hash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function nowIso(now: () => Date): string {
	return now().toISOString();
}
function json(value: unknown): string {
	return JSON.stringify(value);
}
function payload(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export interface StartWorkflowInput {
	/** Canonical repository path, WIKI_WORKFLOW_TARGET, or RESEARCH_WORKFLOW_TARGET. */
	repo: string;
	/** Optional source repository used as read-only evidence by research. */
	repositoryContext?: string;
	/** Initial input retained in the current step as untrusted context. */
	context?: JsonValue;
	worktree?: string;
	changeId: string;
	definitionId: string;
	definitionVersion?: number;
	mode?: "worktree" | "checkout";
	sameCheckout?: boolean;
	metadata: Omit<
		WorkflowSnapshot["metadata"],
		| "repository"
		| "worktree"
		| "changeId"
		| "createdAt"
		| "updatedAt"
		| "stepEnteredAt"
	>;
	routing: WorkflowSnapshot["routing"];
}
export interface DispatchResult {
	snapshot: WorkflowSnapshot;
	view: WorkflowView;
}
export interface ClaimedEffect extends WorkflowEffect {
	runToken?: string;
}
export interface RepairPreview {
	targetStep: string;
	label: string;
	expiresRuns: string[];
	retainedEvidence: string[];
}

export class WorkflowEngine {
	constructor(
		readonly registry: WorkflowRegistry,
		private readonly now: () => Date = () => new Date(),
		private readonly onCommitted: (repository: string) => void = () => {},
	) {}
	start(input: StartWorkflowInput): DispatchResult {
		validateChangeId(input.changeId);
		const wikiOnlyTarget =
			isWikiWorkflowTarget(input.repo) &&
			input.definitionId === "wiki-comments";
		const researchTarget = isResearchWorkflowTarget(input.repo);
		if (
			(isWikiWorkflowTarget(input.repo) && !wikiOnlyTarget) ||
			(researchTarget && input.definitionId !== "research")
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
		const definition = this.registry.definition(
			input.definitionId,
			input.definitionVersion ?? 1,
		);
		if (researchTarget) {
			const route = input.routing.routes.find(
				(item) => item.stepId === "core.research" && item.role === "researcher",
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
		const proposal = ["openspec-propose", "openspec-fusion-propose"].includes(
			definition.id,
		);
		const wikiOnly = definition.id === "wiki";
		if (researchTarget && !input.metadata.task?.trim())
			throw new WorkflowRuntimeError(
				"start-guard",
				"research requires non-empty task",
			);
		const sameCheckout = proposal || wikiOnly;
		if (researchTarget && definition.id !== "research")
			throw new WorkflowRuntimeError(
				"start-guard",
				"invalid research definition",
			);
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
			this.validateStartEvidence(repository, input, sameCheckout);
		if (
			["openspec-fusion-full", "openspec-fusion-propose"].includes(
				definition.id,
			)
		)
			validateFusionRouting(definition.id, input.routing);
		const at = nowIso(this.now);
		const workflowId = randomUUID();
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
				changeId: input.changeId,
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
		this.validateSnapshot(snapshot, definition, []);
		const storeTarget =
			wikiOnlyTarget || researchTarget ? input.repo : repository;
		const db = openStore(storeTarget);
		try {
			db.exec("BEGIN IMMEDIATE");
			if (
				db
					.query("SELECT 1 FROM workflow_instances WHERE change_id=?")
					.get(input.changeId)
			)
				throw new WorkflowRuntimeError(
					"already-exists",
					`workflow already exists: ${input.changeId}`,
				);
			db.query(
				"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
			).run(
				workflowId,
				input.changeId,
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
				this.enqueue(
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
			else this.enterStep(db, snapshot, definition);
			this.writeSnapshot(db, snapshot);
			db.exec("COMMIT");
		} catch (error) {
			rollback(db);
			throw error;
		} finally {
			db.close();
		}
		this.telemetry(snapshot, "workflow.started");
		this.onCommitted(storeTarget);
		return { snapshot, view: this.viewById(storeTarget, workflowId) };
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
			const runs = this.runs(db, snapshot.workflowId);
			if (!repin) this.validateSnapshot(snapshot, definition, runs);
			const event = this.reduce(db, snapshot, definition, command);
			snapshot.revision += 1;
			snapshot.metadata.updatedAt = nowIso(this.now);
			this.validateSnapshot(
				snapshot,
				definition,
				this.runs(db, snapshot.workflowId),
			);
			this.writeSnapshot(db, snapshot);
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
			return { snapshot, view: this.viewById(repo, snapshot.workflowId) };
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
	status(repo: string, changeId: string): WorkflowView {
		const db = openStore(repo);
		try {
			let row = db
				.query("SELECT id FROM workflow_instances WHERE change_id=?")
				.get(changeId) as { id: string } | null;
			if (!row) {
				if (!isWikiWorkflowTarget(repo))
					this.migrateLegacy(db, canonicalRepository(repo), changeId);
				row = db
					.query("SELECT id FROM workflow_instances WHERE change_id=?")
					.get(changeId) as { id: string } | null;
			}
			if (!row) {
				const diagnostic = db
					.query(
						"SELECT diagnostic FROM workflow_migration_diagnostics WHERE change_id=?",
					)
					.get(changeId) as { diagnostic: string } | null;
				if (diagnostic) return diagnosticView(changeId, diagnostic.diagnostic);
				throw new WorkflowRuntimeError(
					"not-found",
					`workflow not found: ${changeId}`,
				);
			}
			this.expireDueQuestions(db, row.id);
			return this.view(db, row.id);
		} finally {
			db.close();
		}
	}
	previewRepair(repo: string, changeId: string): RepairPreview[] {
		const db = openStore(repo);
		try {
			const row = this.instanceByChange(db, changeId);
			const snapshot = parseSnapshot(JSON.parse(row.snapshot_json));
			const definition = this.registry.definition(
				snapshot.definition.id,
				snapshot.definition.version,
				snapshot.definition.digest,
			);
			const runs = this.runs(db, snapshot.workflowId).filter((run) =>
				ACTIVE_RUN.has(run.status),
			);
			return definition.steps
				.filter(
					(stepId) =>
						!definition.terminal.includes(stepId) &&
						this.registry.step(stepId).actor !== "system",
				)
				.map((stepId) => ({
					targetStep: stepId,
					label: this.registry.step(stepId).label,
					expiresRuns: runs.map((run) => run.id),
					retainedEvidence: snapshot.evidence.map((item) => item.digest),
				}));
		} finally {
			db.close();
		}
	}
	effectIsLive(repo: string, effectId: string, lease: string): boolean {
		const db = openStore(repo);
		try {
			return Boolean(
				db
					.query(
						"SELECT 1 FROM workflow_outbox WHERE id=? AND status='running' AND lease=?",
					)
					.get(effectId, lease),
			);
		} finally {
			db.close();
		}
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
				const owner = this.instance(db, row.workflow_id);
				const snapshot = parseSnapshot(JSON.parse(owner.snapshot_json));
				const definition = this.registry.definition(
					snapshot.definition.id,
					snapshot.definition.version,
					snapshot.definition.digest,
				);
				const runs = this.runs(db, snapshot.workflowId);
				this.validateSnapshot(snapshot, definition, runs);
				this.validateEffect(row, snapshot, runs);
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
					const run = runs.find((item) => item.id === runId);
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
		const db = openStore(repo);
		try {
			db.exec("BEGIN IMMEDIATE");
			const row = db
				.query("SELECT * FROM workflow_runs WHERE id=?")
				.get(runId) as RunRow | null;
			if (!row || !ACTIVE_RUN.has(row.status))
				throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
			const token = randomBytes(32).toString("base64url");
			db.query("UPDATE workflow_runs SET capability_hash=? WHERE id=?").run(
				hashToken(token),
				runId,
			);
			db.exec("COMMIT");
			return token;
		} catch (error) {
			rollback(db);
			throw error;
		} finally {
			db.close();
		}
	}
	list(repo: string): WorkflowView[] {
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
							this.migrateLegacy(db, canonicalRepository(repo), row.change_id);
			const views = (
				db
					.query("SELECT id FROM workflow_instances ORDER BY updated_at DESC")
					.all() as Array<{ id: string }>
			).map((row) => this.view(db, row.id));
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
	getRun(repo: string, runId: string): WorkflowRun {
		const db = openStore(repo);
		try {
			const row = db
				.query("SELECT * FROM workflow_runs WHERE id=?")
				.get(runId) as RunRow | null;
			if (!row)
				throw new WorkflowRuntimeError("not-found", `run not found: ${runId}`);
			return runFromRow(row);
		} finally {
			db.close();
		}
	}
	// Resolves the run currently assigned to an agent process by the same
	// (workflowId, stepId, role) identity triple that process was launched
	// with — which stays valid across a persistent role's reused generations,
	// unlike the run-scoped id/generation/token — instead of trusting a
	// client-supplied runId/token that may reflect a prior, already-completed
	// generation. At most one run per (workflowId, stepId, role) is ever
	// pending/working at a time by construction, so this uniquely identifies
	// "the run this process should be handing off right now". Status must be
	// `working`, not merely `pending`: a run only reaches `working` when its
	// `agent.launch` effect actually completes (runtime.ts effectResult sets
	// handle_json and status='working' atomically), which for a persistent
	// role only happens once the reuse `observe` path has confirmed the pane
	// is live and delivered the new prompt to it. `operator.repair` can expire
	// a stale run and synchronously create a fresh `pending` run for the same
	// role before that new run's `agent.launch` effect has been drained; a
	// still-alive stale process (unaware of the new run, never re-prompted
	// yet) must not be able to hand off that not-yet-launched run merely by
	// sharing its (workflowId, stepId, role) — excluding `pending` closes that
	// window and preserves the same `stale-run` rejection the old run-scoped
	// env check used to provide.
	activeRunForRole(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
	): WorkflowRun {
		const db = openStore(repo);
		try {
			const row = db
				.query(
					"SELECT * FROM workflow_runs WHERE workflow_id=? AND step_id=? AND role=? AND status='working' ORDER BY rowid DESC LIMIT 1",
				)
				.get(workflowId, stepId, role) as RunRow | null;
			if (!row)
				throw new WorkflowRuntimeError(
					"not-found",
					`no active run for ${stepId}/${role}`,
				);
			return runFromRow(row);
		} finally {
			db.close();
		}
	}
	/** Validate the launch-bound capability for a role-scoped CLI operation. */
	authorizeAgentCapability(
		repo: string,
		workflowId: string,
		stepId: string,
		role: string,
		token: string,
	): WorkflowRun {
		if (!token)
			throw new WorkflowRuntimeError(
				"unauthorized",
				"authenticated run capability is required",
			);
		const run = this.activeRunForRole(repo, workflowId, stepId, role);
		const snapshot = this.getSnapshot(repo, workflowId);
		if (
			snapshot.currentStep !== stepId ||
			!snapshot.step.activeRunIds.includes(run.id) ||
			!run.capabilityHash ||
			Date.parse(run.capabilityExpiresAt) <= this.now().getTime() ||
			!tokenMatches(token, run.capabilityHash)
		)
			throw new WorkflowRuntimeError(
				"unauthorized",
				"invalid or inactive run capability",
			);
		return run;
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
		if (!token)
			throw new WorkflowRuntimeError(
				"unauthorized",
				"authenticated run capability is required",
			);
		const run = this.getRun(repo, runId);
		const snapshot = this.getSnapshot(repo, workflowId);
		if (
			run.workflowId !== workflowId ||
			run.stepId !== stepId ||
			run.role !== role ||
			snapshot.currentStep !== stepId ||
			!snapshot.step.activeRunIds.includes(run.id) ||
			!ACTIVE_RUN.has(run.status) ||
			!run.capabilityHash ||
			Date.parse(run.capabilityExpiresAt) <= this.now().getTime() ||
			!tokenMatches(token, run.capabilityHash)
		)
			throw new WorkflowRuntimeError(
				"unauthorized",
				"invalid or inactive run capability",
			);
		return run;
	}
	getSnapshot(repo: string, workflowId: string): WorkflowSnapshot {
		const db = openStore(repo);
		try {
			this.expireDueQuestions(db, workflowId);
			return parseSnapshot(
				JSON.parse(this.instance(db, workflowId).snapshot_json),
			);
		} finally {
			db.close();
		}
	}
	private expireDueQuestions(db: Database, workflowId: string): void {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.instance(db, workflowId);
			const snapshot = parseSnapshot(JSON.parse(row.snapshot_json));
			const due = snapshot.developerDialogue.filter(
				(item) =>
					item.status === "pending" &&
					Date.parse(item.expiresAt) <= this.now().getTime(),
			);
			if (!due.length) {
				db.exec("COMMIT");
				return;
			}
			const groups = new Set(due.map((item) => item.groupId).filter(Boolean));
			const dueIds = new Set(due.map((item) => item.id));
			const expiredIds = new Set(dueIds);
			const at = nowIso(this.now);
			for (const item of snapshot.developerDialogue) {
				if (
					item.status === "pending" &&
					(dueIds.has(item.id) ||
						(item.groupId !== undefined && groups.has(item.groupId)))
				) {
					item.status = "expired";
					item.answeredAt = at;
					item.answer = { kind: "cancel" };
					expiredIds.add(item.id);
				}
			}
			const definition = this.registry.definition(
				snapshot.definition.id,
				snapshot.definition.version,
				snapshot.definition.digest,
			);
			this.validateSnapshot(snapshot, definition, this.runs(db, workflowId));
			snapshot.revision += 1;
			snapshot.metadata.updatedAt = at;
			this.writeSnapshot(db, snapshot);
			db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
				snapshot.workflowId,
				snapshot.revision,
				"developer.question.expired",
				json({ kind: "system" }),
				json({ questionIds: [...expiredIds], outcome: "expired" }),
				at,
			);
			db.exec("COMMIT");
		} catch (error) {
			rollback(db);
			throw error;
		}
	}

	private migrateLegacy(
		db: Database,
		repository: string,
		changeId: string,
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
			this.migrationDiagnostic(
				db,
				repository,
				changeId,
				`malformed legacy state: ${boundedError(error)}`,
				source.state,
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
							this.migrationDiagnostic(
								db,
								repository,
								changeId,
								"conflicting repository and worktree legacy mirrors",
								source.state,
							);
							return;
						}
					}
				} finally {
					mirrorDb.close();
				}
			} catch (error) {
				this.migrationDiagnostic(
					db,
					repository,
					changeId,
					`legacy mirror unavailable: ${boundedError(error)}`,
					source.state,
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
			definition = this.registry.definition(workflowType, 1);
			if (!currentStep || !definition.steps.includes(currentStep))
				throw new Error(`phase ${phase} cannot map to ${workflowType}`);
		} catch (error) {
			this.migrationDiagnostic(
				db,
				repository,
				changeId,
				`legacy mapping failed: ${boundedError(error)}`,
				source.state,
			);
			return;
		}
		const at = nowIso(this.now);
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
				.filter((id) => this.registry.step(id).actor === "agent")
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
			this.migrationDiagnostic(
				db,
				repository,
				changeId,
				`legacy evidence invalid: ${boundedError(error)}`,
				source.state,
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
			this.validateSnapshot(snapshot, definition, []);
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
				this.enterStep(db, snapshot, definition);
			this.writeSnapshot(db, snapshot);
			db.query(
				"DELETE FROM workflow_migration_diagnostics WHERE change_id=?",
			).run(changeId);
			db.exec("COMMIT");
		} catch (error) {
			rollback(db);
			this.migrationDiagnostic(
				db,
				repository,
				changeId,
				`legacy migration failed: ${boundedError(error)}`,
				source.state,
			);
		}
	}
	private migrationDiagnostic(
		db: Database,
		repository: string,
		changeId: string,
		diagnostic: string,
		source: string,
	): void {
		db.query(
			"INSERT OR REPLACE INTO workflow_migration_diagnostics VALUES (?,?,?,?,?)",
		).run(
			changeId,
			repository,
			diagnostic.slice(0, 2048),
			source.slice(0, 65536),
			nowIso(this.now),
		);
	}

	private telemetry(
		snapshot: WorkflowSnapshot,
		event: string,
		identity?: { runId?: string; effectId?: string },
	): void {
		const context = childTrace(parseTraceparent(process.env.TRACEPARENT));
		new TelemetrySink(
			snapshot.definition.id === "wiki-comments"
				? path.join(wikiWorkflowDataRoot(), snapshot.metadata.changeId)
				: path.join(
						snapshot.metadata.worktree,
						".herdr-workflow",
						snapshot.metadata.changeId,
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

	private validateStartEvidence(
		repository: string,
		input: StartWorkflowInput,
		proposal = false,
	): void {
		const status = Bun.spawnSync(
			["git", "-C", repository, "status", "--porcelain"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (status.exitCode !== 0)
			throw new WorkflowRuntimeError(
				"start-guard",
				"unable to inspect Git worktree",
			);
		if (
			status.stdout.toString().trim() &&
			!proposal &&
			input.definitionId !== "wiki"
		)
			throw new WorkflowRuntimeError(
				"start-guard",
				"working tree must be clean before workflow start",
			);
		if (input.definitionId === "wiki") {
			if (!input.metadata.task?.trim())
				throw new WorkflowRuntimeError(
					"start-guard",
					"wiki requires non-empty task",
				);
			return;
		}
		if (input.definitionId === "no-openspec") {
			if (!input.metadata.task?.trim())
				throw new WorkflowRuntimeError(
					"start-guard",
					"no-openspec requires non-empty task",
				);
			return;
		}
		if (!fs.existsSync(path.join(repository, "openspec", "config.yaml")))
			throw new WorkflowRuntimeError(
				"start-guard",
				"OpenSpec project required",
			);
		if (input.definitionId === "openspec-apply") {
			const root = path.join(repository, "openspec", "changes", input.changeId);
			for (const file of ["proposal.md", "design.md", "tasks.md"])
				if (
					!fs.existsSync(path.join(root, file)) ||
					!fs.readFileSync(path.join(root, file), "utf8").trim()
				)
					throw new WorkflowRuntimeError(
						"start-guard",
						`invalid openspec-apply artifact: ${file}`,
					);
			if (
				!fs.existsSync(path.join(root, "specs")) ||
				!walkFiles(path.join(root, "specs")).some((file) =>
					/#### Scenario:/.test(fs.readFileSync(file, "utf8")),
				)
			)
				throw new WorkflowRuntimeError(
					"start-guard",
					"openspec-apply requires OpenSpec scenario",
				);
			if (
				!/^\s*[-*]\s+\[ \]/m.test(
					fs.readFileSync(path.join(root, "tasks.md"), "utf8"),
				)
			)
				throw new WorkflowRuntimeError(
					"start-guard",
					"openspec-apply requires actionable unchecked task",
				);
		}
	}

	private reduce(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: WorkflowCommand,
	): { type: string; actor: unknown; data: unknown } {
		if (command.type === "developer.action")
			return this.developerAction(db, snapshot, definition, command);
		if (command.type === "agent.question")
			return this.agentQuestion(db, snapshot, command);
		if (command.type === "agent.question-expire")
			return this.expireQuestion(db, snapshot, command);
		if (command.type === "agent.handoff")
			return this.agentHandoff(db, snapshot, definition, command);
		if (command.type === "agent.research-handoff")
			return this.recordResearchHandoff(db, snapshot, definition, command);
		if (command.type === "effect.result")
			return this.effectResult(db, snapshot, definition, command);
		if (command.type === "operator.repair")
			return this.repair(db, snapshot, definition, command);
		if (command.type === "operator.repin")
			return this.repin(db, snapshot, definition, command);
		if (command.type === "operator.resume") {
			this.requireRevision(snapshot, command.revision);
			if (snapshot.status !== "paused")
				throw new WorkflowRuntimeError(
					"unavailable",
					"resume requires paused workflow",
					snapshot.revision,
				);
			snapshot.status = "active";
			snapshot.attention = [];
			this.enterStep(db, snapshot, definition);
			return {
				type: "workflow.resumed",
				actor: { kind: "operator" },
				data: { step: snapshot.currentStep },
			};
		}
		throw new WorkflowRuntimeError("invalid-command", "unsupported command");
	}
	private questionRun(
		db: Database,
		snapshot: WorkflowSnapshot,
		command: {
			workflowId: string;
			runId: string;
			stepId: string;
			role: string;
			token: string;
		},
	): WorkflowRun {
		const row = db
			.query("SELECT * FROM workflow_runs WHERE id=?")
			.get(command.runId) as RunRow | null;
		if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
		const run = runFromRow(row);
		if (
			run.workflowId !== snapshot.workflowId ||
			command.workflowId !== snapshot.workflowId ||
			run.stepId !== command.stepId ||
			run.role !== command.role ||
			run.stepId !== snapshot.currentStep ||
			!snapshot.step.activeRunIds.includes(run.id) ||
			!ACTIVE_RUN.has(run.status) ||
			!run.capabilityHash ||
			!tokenMatches(command.token, run.capabilityHash) ||
			Date.parse(run.capabilityExpiresAt) <= this.now().getTime()
		)
			throw new WorkflowRuntimeError(
				"unauthorized",
				"invalid or inactive run capability",
			);
		return run;
	}
	private agentQuestion(
		db: Database,
		snapshot: WorkflowSnapshot,
		command: Extract<WorkflowCommand, { type: "agent.question" }>,
	) {
		const run = this.questionRun(db, snapshot, command);
		const items: readonly DeveloperQuestionItem[] = command.questions ?? [
			{
				description: command.description ?? "",
				...(command.context === undefined ? {} : { context: command.context }),
				options: command.options ?? [],
			},
		];
		if (
			snapshot.developerDialogue.length + items.length >
			MAX_DEVELOPER_DIALOGUE_RECORDS
		)
			throw new WorkflowRuntimeError(
				"dialogue-bounds",
				"developer dialogue limit reached; resolve the existing questions before asking again",
			);
		const grouped = command.questions !== undefined;
		const groupId = grouped ? randomUUID() : undefined;
		const createdAt = nowIso(this.now);
		const expiresAt = new Date(
			this.now().getTime() + QUESTION_WAIT_MS,
		).toISOString();
		const questions = items.map(
			(item, itemIndex): DeveloperDialogueRecord => ({
				id: randomUUID(),
				workflowId: snapshot.workflowId,
				runId: run.id,
				stepId: run.stepId,
				role: run.role,
				description: item.description,
				...(item.context === undefined ? {} : { context: item.context }),
				options: item.options,
				...(groupId === undefined ? {} : { groupId, itemIndex }),
				status: "pending",
				createdAt,
				expiresAt,
			}),
		);
		const nextDialogue = [...snapshot.developerDialogue, ...questions];
		if (Buffer.byteLength(JSON.stringify(nextDialogue)) > 128 * 1024)
			throw new WorkflowRuntimeError(
				"dialogue-bounds",
				"developer dialogue content limit reached; shorten the question or options",
			);
		snapshot.developerDialogue.push(...questions);
		return {
			type: "developer.question.created",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: {
				...(groupId === undefined
					? { questionId: questions[0]?.id }
					: { groupId, questionIds: questions.map((question) => question.id) }),
				role: run.role,
			},
		};
	}
	/** Record the active researcher run's structured handoff and, in the same
	 * authenticated step, request the transition into wiki drafting. Reuses
	 * the same source-isolation and workspace-readiness checks a developer
	 * dashboard action previously performed before that transition: an
	 * invalid handoff or a failed check throws, leaves the researcher run
	 * active, and performs no expiry or transition. Only a valid handoff that
	 * passes every check expires the researcher run, stops its session, and
	 * enters `core.wiki`. */
	private recordResearchHandoff(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: Extract<WorkflowCommand, { type: "agent.research-handoff" }>,
	) {
		if (
			snapshot.definition.id !== "research" ||
			command.stepId !== "core.research" ||
			command.role !== "researcher"
		)
			throw new WorkflowRuntimeError(
				"unavailable",
				"research handoff recording is only available to the active core.research researcher run",
			);
		const run = this.questionRun(db, snapshot, command);
		let handoff: ReturnType<typeof researchHandoffContract.parse>;
		try {
			handoff = researchHandoffContract.parse(command.handoff);
		} catch (error) {
			throw new WorkflowRuntimeError(
				"invalid-command",
				error instanceof Error ? error.message : String(error),
			);
		}
		this.validateSourceBaseline(snapshot);
		if (!snapshot.metadata.workspace)
			throw new WorkflowRuntimeError(
				"unavailable",
				"research handoff requires a ready workspace",
			);
		const active = this.runs(db, snapshot.workflowId).filter((item) =>
			snapshot.step.activeRunIds.includes(item.id),
		);
		const researchContext = {
			task: snapshot.metadata.task ?? "",
			handoff: handoff as unknown as JsonValue,
		};
		this.expireRuns(db, snapshot);
		for (const item of active)
			if (item.handle)
				this.enqueue(
					db,
					snapshot,
					"agent.stop",
					`run:${item.id}:stop:${item.generation}`,
					{ runId: item.id },
				);
		this.transition(db, snapshot, definition, "request-wiki", researchContext);
		return {
			type: "research.handoff.recorded",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: { runId: run.id },
		};
	}
	private expireQuestion(
		db: Database,
		snapshot: WorkflowSnapshot,
		command: Extract<WorkflowCommand, { type: "agent.question-expire" }>,
	) {
		const run = this.questionRun(db, snapshot, command);
		const question = snapshot.developerDialogue.find(
			(item) => item.id === command.questionId && item.runId === run.id,
		);
		if (question?.status !== "pending")
			throw new WorkflowRuntimeError(
				"stale-question",
				"question is no longer pending",
			);
		const group = question.groupId
			? snapshot.developerDialogue.filter(
					(item) =>
						item.groupId === question.groupId && item.status === "pending",
				)
			: [question];
		const at = nowIso(this.now);
		for (const item of group) {
			item.status = "expired";
			item.answeredAt = at;
			item.answer = { kind: "cancel" };
		}
		return {
			type: "developer.question.expired",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: {
				...(question.groupId
					? { groupId: question.groupId }
					: { questionId: question.id }),
				outcome: "expired",
			},
		};
	}
	private answerQuestion(snapshot: WorkflowSnapshot, raw: unknown) {
		let answer: DeveloperQuestionAnswer;
		try {
			answer = parseDeveloperQuestionAnswer(raw);
		} catch (error) {
			throw new WorkflowRuntimeError(
				"invalid-command",
				error instanceof Error ? error.message : String(error),
			);
		}
		if ("groupId" in answer) {
			const group = snapshot.developerDialogue
				.filter((item) => item.groupId === answer.groupId)
				.sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
			if (!group.length || group.some((item) => item.status !== "pending"))
				throw new WorkflowRuntimeError(
					"stale-question",
					"questionnaire is no longer pending",
				);
			if (
				group.some((item) => Date.parse(item.expiresAt) <= this.now().getTime())
			) {
				const at = nowIso(this.now);
				for (const item of group) {
					item.status = "expired";
					item.answeredAt = at;
					item.answer = { kind: "cancel" };
				}
				return {
					type: "developer.question.expired",
					actor: { kind: "system" },
					data: { groupId: answer.groupId, outcome: "expired" },
				};
			}
			if (!("responses" in answer)) {
				const at = nowIso(this.now);
				for (const item of group) {
					item.status = "cancelled";
					item.answeredAt = at;
					item.answer = { kind: "cancel" };
				}
				return {
					type: "developer.question.answered",
					actor: { kind: "developer" },
					data: { groupId: answer.groupId, outcome: "cancelled" },
				};
			}
			if (answer.responses.length !== group.length)
				throw new WorkflowRuntimeError(
					"invalid-command",
					"questionnaire responses must include every item exactly once",
				);
			const byId = new Map(group.map((item) => [item.id, item]));
			for (const response of answer.responses) {
				const item = byId.get(response.questionId);
				if (!item)
					throw new WorkflowRuntimeError(
						"invalid-command",
						"questionnaire response does not match its items",
					);
				if (
					response.kind === "option" &&
					!item.options.some((option) => option.value === response.value)
				)
					throw new WorkflowRuntimeError(
						"invalid-command",
						"answer is not a recommended option",
					);
				if (response.kind === "custom" && !response.value.trim())
					throw new WorkflowRuntimeError(
						"invalid-command",
						"custom answer must not be empty",
					);
			}
			const at = nowIso(this.now);
			for (const response of answer.responses) {
				const item = byId.get(response.questionId);
				if (!item) continue;
				item.status = "answered";
				item.answeredAt = at;
				item.answer = { kind: response.kind, value: response.value };
			}
			return {
				type: "developer.question.answered",
				actor: { kind: "developer" },
				data: { groupId: answer.groupId, outcome: "answered" },
			};
		}
		const question = snapshot.developerDialogue.find(
			(item) => item.id === answer.questionId,
		);
		if (question?.groupId) {
			const groupSize = snapshot.developerDialogue.filter(
				(item) => item.groupId === question.groupId,
			).length;
			if (groupSize > 1)
				throw new WorkflowRuntimeError(
					"invalid-command",
					"questionnaire requires a complete grouped response set",
				);
		}
		if (question?.status !== "pending")
			throw new WorkflowRuntimeError(
				"stale-question",
				"question is no longer pending",
			);
		if (Date.parse(question.expiresAt) <= this.now().getTime()) {
			question.status = "expired";
			question.answeredAt = nowIso(this.now);
			question.answer = { kind: "cancel" };
			return {
				type: "developer.question.expired",
				actor: { kind: "system" },
				data: { questionId: question.id, outcome: "expired" },
			};
		}
		if (answer.kind === "option") {
			if (!question.options.some((option) => option.value === answer.value))
				throw new WorkflowRuntimeError(
					"invalid-command",
					"answer is not a recommended option",
				);
		} else if (answer.kind === "custom" && !answer.value?.trim()) {
			throw new WorkflowRuntimeError(
				"invalid-command",
				"custom answer must not be empty",
			);
		}
		question.status = answer.kind === "cancel" ? "cancelled" : "answered";
		question.answeredAt = nowIso(this.now);
		question.answer = {
			kind: answer.kind,
			...(answer.value === undefined ? {} : { value: answer.value }),
		};
		return {
			type: "developer.question.answered",
			actor: { kind: "developer" },
			data: { questionId: question.id, outcome: question.status },
		};
	}
	private developerAction(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: Extract<WorkflowCommand, { type: "developer.action" }>,
	) {
		this.requireRevision(snapshot, command.revision);
		if (command.actionId === "answer-question")
			return this.answerQuestion(snapshot, command.input);
		if (command.actionId.startsWith("retry-effect:")) {
			const id = command.actionId.slice(13);
			const row = db
				.query(
					"SELECT status FROM workflow_outbox WHERE id=? AND workflow_id=?",
				)
				.get(id, snapshot.workflowId) as { status: string } | null;
			if (row?.status !== "failed")
				throw new WorkflowRuntimeError(
					"unavailable",
					`retry unavailable: ${command.actionId}`,
					snapshot.revision,
				);
			db.query(
				"UPDATE workflow_outbox SET status='retry', next_attempt_at=NULL, last_error=NULL WHERE id=? AND workflow_id=? AND status='failed'",
			).run(id, snapshot.workflowId);
			snapshot.status = "active";
			snapshot.attention = [];
			return {
				type: "developer.action",
				actor: { kind: "developer" },
				data: { actionId: command.actionId },
			};
		}
		if (command.actionId === "re-pin") {
			this.requireRevision(snapshot, command.revision);
			const runs = this.runs(db, snapshot.workflowId);
			this.validateStructure(snapshot, definition, runs);
			const previous = snapshot.definition.digest;
			snapshot.definition = {
				...snapshot.definition,
				digest: definition.digest,
			};
			snapshot.repinned = { fromDigest: previous, at: nowIso(this.now) };
			return {
				type: "developer.action",
				actor: { kind: "developer" },
				data: { actionId: "re-pin" },
			};
		}
		const action = this.actions(snapshot).find(
			(item) => item.id === command.actionId,
		);
		if (!action)
			throw new WorkflowRuntimeError(
				"unavailable",
				`action unavailable: ${command.actionId}`,
				snapshot.revision,
			);
		if (command.actionId === "close-research") {
			if (
				snapshot.definition.id !== "research" ||
				snapshot.currentStep !== "core.research"
			)
				throw new WorkflowRuntimeError(
					"unavailable",
					"close-research is only available while research is purely conversational (core.research)",
				);
			this.validateSourceBaseline(snapshot);
			const active = this.runs(db, snapshot.workflowId).filter((run) =>
				snapshot.step.activeRunIds.includes(run.id),
			);
			this.expireRuns(db, snapshot);
			for (const run of active)
				if (run.handle)
					this.enqueue(
						db,
						snapshot,
						"agent.stop",
						`run:${run.id}:stop:${run.generation}`,
						{ runId: run.id },
					);
			snapshot.currentStep = "core.closed";
			snapshot.metadata.stepEnteredAt = nowIso(this.now);
			snapshot.status = "closed";
			snapshot.step = freshStep(1);
			this.enterStep(db, snapshot, definition);
			return {
				type: "developer.action",
				actor: { kind: "developer" },
				data: { actionId: command.actionId },
			};
		}
		if (command.actionId === "research-follow-up") {
			if (
				snapshot.definition.id !== "research" ||
				snapshot.currentStep !== "core.research"
			)
				throw new WorkflowRuntimeError(
					"unavailable",
					"research follow-up is only available while research is active",
				);
			const message =
				typeof command.input === "string"
					? command.input
					: command.input &&
							typeof command.input === "object" &&
							"message" in command.input
						? String((command.input as { message: unknown }).message)
						: "";
			if (!message.trim() || message.length > 8192)
				throw new WorkflowRuntimeError(
					"invalid-command",
					"research-follow-up requires a bounded message",
				);
			const run = this.runs(db, snapshot.workflowId).find(
				(item) =>
					snapshot.step.activeRunIds.includes(item.id) &&
					ACTIVE_RUN.has(item.status),
			);
			if (!run)
				throw new WorkflowRuntimeError(
					"unavailable",
					"researcher run is not available",
				);
			const context =
				snapshot.step.context &&
				typeof snapshot.step.context === "object" &&
				!Array.isArray(snapshot.step.context)
					? snapshot.step.context
					: {};
			const followUps =
				"followUps" in context && Array.isArray(context.followUps)
					? context.followUps.filter(
							(item): item is string => typeof item === "string",
						)
					: [];
			snapshot.step.context = {
				...context,
				followUps: [...followUps, message.trim()].slice(-50),
			};
			this.enqueue(
				db,
				snapshot,
				"agent.prompt",
				`run:${run.id}:prompt:${snapshot.revision + 1}`,
				{ runId: run.id, message: message.trim() },
			);
			return {
				type: "developer.action",
				actor: { kind: "developer" },
				data: { actionId: command.actionId },
			};
		}
		if (command.actionId === "resume") {
			if (snapshot.status !== "paused")
				throw new WorkflowRuntimeError("unavailable", "workflow is not paused");
			snapshot.status = "active";
			snapshot.attention = [];
			this.enterStep(db, snapshot, definition);
			return {
				type: "developer.action",
				actor: { kind: "developer" },
				data: { actionId: command.actionId },
			};
		}
		if (command.actionId === "create-pr") {
			if (
				["openspec-propose", "openspec-fusion-propose"].includes(definition.id)
			)
				throw new WorkflowRuntimeError(
					"unavailable",
					"proposal workflows do not support pull-request creation",
					snapshot.revision,
				);
			this.registry
				.step(snapshot.currentStep)
				.reduce(snapshot, { outcome: "create-pr" });
			this.enqueue(
				db,
				snapshot,
				"pull-request.create",
				`pr:${snapshot.workflowId}:create`,
				{ workflowId: snapshot.workflowId },
			);
			return {
				type: "developer.action",
				actor: { kind: "developer" },
				data: { actionId: command.actionId },
			};
		}
		if (
			(command.actionId === "approve-wiki" || command.actionId === "close") &&
			(snapshot.definition.id === "wiki" ||
				snapshot.definition.id === "research")
		)
			this.validateSourceBaseline(snapshot);
		if (command.actionId === "review-comments") {
			const comments =
				command.input &&
				typeof command.input === "object" &&
				"comments" in command.input
					? (command.input as { comments: unknown }).comments
					: undefined;
			if (!Array.isArray(comments) || !comments.length || comments.length > 100)
				throw new WorkflowRuntimeError(
					"invalid-command",
					"review-comments requires bounded comments",
				);
			for (const [index, value] of comments.entries()) {
				if (
					!value ||
					typeof value !== "object" ||
					typeof (value as { comment?: unknown }).comment !== "string" ||
					!(value as { comment: string }).comment.trim() ||
					(value as { comment: string }).comment.length > 4096
				)
					throw new WorkflowRuntimeError(
						"invalid-command",
						`invalid review comment ${index}`,
					);
			}
		}
		if (command.actionId === "reject-plan") {
			const reason =
				typeof command.input === "string"
					? command.input
					: command.input &&
							typeof command.input === "object" &&
							"reason" in command.input
						? String((command.input as { reason: unknown }).reason)
						: "";
			if (!reason.trim() || reason.length > 2048)
				throw new WorkflowRuntimeError(
					"invalid-command",
					"reject-plan requires bounded reason",
				);
			command.input = { reason: reason.trim() };
		}
		const outcome =
			command.actionId === "approve-plan" ||
			command.actionId === "approve-review" ||
			command.actionId === "approve-wiki"
				? "approve"
				: command.actionId === "reject-plan"
					? "reject"
					: command.actionId === "review-comments"
						? "comments"
						: command.actionId === "close"
							? "close"
							: command.actionId === "create-pr"
								? "create-pr"
								: command.actionId;
		this.transition(db, snapshot, definition, outcome, command.input);
		return {
			type: "developer.action",
			actor: { kind: "developer" },
			data: { actionId: command.actionId },
		};
	}
	private agentHandoff(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: Extract<WorkflowCommand, { type: "agent.handoff" }>,
	) {
		const row = db
			.query("SELECT * FROM workflow_runs WHERE id=?")
			.get(command.runId) as RunRow | null;
		if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
		const run = runFromRow(row);
		if (
			run.workflowId !== snapshot.workflowId ||
			run.generation !== command.generation ||
			!ACTIVE_RUN.has(run.status) ||
			run.stepId !== snapshot.currentStep ||
			!snapshot.step.activeRunIds.includes(run.id)
		)
			throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
		if (
			!run.allowedOutcomes.includes(command.outcome) ||
			!run.capabilityHash ||
			!tokenMatches(command.token, run.capabilityHash) ||
			Date.parse(run.capabilityExpiresAt) <= this.now().getTime()
		)
			throw new WorkflowRuntimeError(
				"unauthorized",
				"invalid or expired run capability",
			);
		let output: unknown;
		let outputDigest: string | undefined;
		if (command.outcome === "complete" && run.outputPath) {
			const validated = this.artifact(run, command.artifact);
			output = validated.output;
			outputDigest = validated.digest;
		}
		const step = this.registry.step(run.stepId);
		if (output !== undefined) output = step.output.parse(output);
		if (snapshot.definition.id === "research")
			this.validateSourceBaseline(snapshot);
		if (command.outcome === "complete") {
			this.validateStepEvidence(snapshot, run.stepId);
			if (run.stepId === "core.wiki") this.validateSourceBaseline(snapshot);
			if (run.stepId === "core.triage")
				this.validateTriageScope(
					snapshot,
					output as { assignments: Array<{ role: string; files: string[] }> },
				);
		}
		const completedAt = nowIso(this.now);
		db.query(
			"UPDATE workflow_runs SET status=?, capability_hash='', output_digest=?, completed_at=? WHERE id=? AND status IN ('pending','working')",
		).run(
			command.outcome === "complete" ? "completed" : command.outcome,
			outputDigest ?? null,
			completedAt,
			run.id,
		);
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind IN ('artifact.write','agent.launch','agent.prompt') AND json_extract(payload_json,'$.runId')=?",
		).run(snapshot.workflowId, run.id);
		if (outputDigest && run.outputPath)
			snapshot.evidence.push({
				kind: `${run.stepId}:${run.role}`,
				path: run.outputPath,
				digest: outputDigest,
			});
		snapshot.step.activeRunIds = snapshot.step.activeRunIds.filter(
			(id) => id !== run.id,
		);
		snapshot.step.completedRunIds.push(run.id);
		if (
			snapshot.currentStep === "core.triage" &&
			command.outcome === "complete"
		)
			snapshot.step.selectedRoles = (output as { roles: string[] }).roles;
		if (
			snapshot.currentStep === "core.verification" &&
			command.outcome === "complete"
		) {
			const critical = Number((output as { critical?: number })?.critical ?? 0);
			snapshot.step.results.push({
				runId: run.id,
				role: run.role,
				critical,
				...(outputDigest ? { outputDigest } : {}),
			});
			if (!snapshot.step.activeRunIds.length) {
				if (snapshot.step.results.some((result) => result.critical > 0)) {
					this.stopRoundAgents(db, snapshot, snapshot.step.attempt);
					this.transition(
						db,
						snapshot,
						definition,
						(snapshot.loopCounts["core.verification:fix"] ?? 0) + 1 >=
							(definition.edges.find(
								(edge) =>
									edge.from === "core.verification" && edge.outcome === "fix",
							)?.loop?.maxAttempts ?? 1)
							? "limit"
							: "fix",
						{
							findings: snapshot.evidence.filter((item) =>
								item.kind.startsWith("core.verification:"),
							),
						},
					);
				} else if (
					!snapshot.step.testRunStarted &&
					run.role !== "test-verifier"
				) {
					snapshot.step.testRunStarted = true;
					this.createRun(db, snapshot, step, "test-verifier");
				} else {
					this.stopRoundAgents(db, snapshot, snapshot.step.attempt);
					this.transition(db, snapshot, definition, "pass");
				}
			}
		} else if (
			command.outcome === "complete" &&
			snapshot.currentStep === "fusion.plan"
		) {
			// Fan-out completion counting: each validated draft is recorded as it
			// arrives; the step only transitions when every planner role holds one.
			snapshot.step.results.push({
				runId: run.id,
				role: run.role,
				critical: 0,
				...(outputDigest ? { outputDigest } : {}),
			});
			const expected = fusionPlannerRoles(snapshot.routing);
			if (
				!snapshot.step.activeRunIds.length &&
				expected.every((role) =>
					snapshot.step.results.some(
						(result) => result.role === role && result.outputDigest,
					),
				)
			)
				this.transition(db, snapshot, definition, "complete", {
					drafts: fusionDraftInputs(snapshot),
				});
		} else if (
			command.outcome === "complete" &&
			snapshot.currentStep === "core.plan"
		)
			this.enqueue(
				db,
				snapshot,
				"openspec.validate",
				`openspec:${snapshot.workflowId}:plan:${snapshot.step.attempt}`,
				{ changeId: snapshot.metadata.changeId },
			);
		else if (
			command.outcome === "complete" &&
			snapshot.currentStep === "fusion.consolidate"
		)
			this.enqueue(
				db,
				snapshot,
				"openspec.validate",
				`openspec:${snapshot.workflowId}:consolidate:${snapshot.step.attempt}`,
				{ changeId: snapshot.metadata.changeId },
			);
		else if (command.outcome === "complete")
			this.transition(db, snapshot, definition, "complete", output);
		else if (command.outcome === "blocked") {
			if (
				snapshot.definition.id === "wiki" ||
				snapshot.definition.id === "wiki-comments" ||
				snapshot.definition.id === "research"
			)
				this.transition(db, snapshot, definition, "blocked", command.message);
			else {
				snapshot.status = "attention-required";
				snapshot.attention = [command.message ?? `${run.role} blocked`];
			}
		} else {
			this.expireSiblingRuns(db, snapshot);
			this.transition(db, snapshot, definition, "failed", command.message);
		}
		if (
			(run.stepId === "core.wiki" || run.stepId === "core.research") &&
			run.handle
		)
			this.enqueue(
				db,
				snapshot,
				"agent.stop",
				`run:${run.id}:stop:${run.generation}`,
				{ runId: run.id },
			);
		return {
			type: "agent.handoff",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: { outcome: command.outcome, outputDigest },
		};
	}
	private effectResult(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: Extract<WorkflowCommand, { type: "effect.result" }>,
	) {
		const row = db
			.query("SELECT * FROM workflow_outbox WHERE id=?")
			.get(command.effectId) as EffectRow | null;
		if (
			!row ||
			row.workflow_id !== snapshot.workflowId ||
			row.status !== "running" ||
			row.lease !== command.lease ||
			Date.parse(row.lease_expires_at ?? "") <= this.now().getTime()
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
		} else if (command.outcome === "retry" && row.attempts < row.max_attempts) {
			const next = new Date(
				this.now().getTime() + Math.min(60_000, 1000 * 2 ** row.attempts),
			).toISOString();
			db.query(
				"UPDATE workflow_outbox SET status='retry', lease=NULL, lease_expires_at=NULL, next_attempt_at=?, last_error=? WHERE id=?",
			).run(next, boundedError(command.data), row.id);
		} else {
			db.query(
				"UPDATE workflow_outbox SET status='failed', lease=NULL, lease_expires_at=NULL, last_error=? WHERE id=?",
			).run(boundedError(command.data), row.id);
			snapshot.status = "attention-required";
			snapshot.attention = [
				`effect ${row.kind} failed: ${boundedError(command.data)}`,
			];
		}
		if (command.outcome === "complete" && row.kind === "workspace.setup") {
			const data =
				command.data && typeof command.data === "object"
					? (command.data as Record<string, unknown>)
					: {};
			if (typeof data.worktree === "string")
				snapshot.metadata.worktree = path.resolve(data.worktree);
			if (typeof data.workspace === "string")
				snapshot.metadata.workspace = data.workspace;
			if (typeof data.branch === "string")
				snapshot.metadata.branch = data.branch;
			this.enterStep(db, snapshot, definition);
		}
		if (
			command.outcome === "complete" &&
			row.kind === "openspec.validate" &&
			(snapshot.currentStep === "core.plan" ||
				snapshot.currentStep === "fusion.consolidate")
		)
			this.transition(db, snapshot, definition, "complete");
		if (
			command.outcome === "complete" &&
			snapshot.currentStep === "core.delivery"
		) {
			if (row.kind === "delivery.commit")
				this.enqueue(
					db,
					snapshot,
					"delivery.push",
					`delivery:${snapshot.workflowId}:push`,
					{ workflowId: snapshot.workflowId },
				);
			if (row.kind === "delivery.push")
				this.transition(db, snapshot, definition, "complete");
		}
		if (command.outcome === "complete" && row.kind === "workspace.close")
			this.enqueue(
				db,
				snapshot,
				"workspace.cleanup",
				`workspace:${snapshot.workflowId}:cleanup`,
				{ workflowId: snapshot.workflowId },
			);
		return {
			type: "effect.result",
			actor: { kind: "system", effectId: row.id },
			data: { outcome: command.outcome },
		};
	}
	private repin(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: Extract<WorkflowCommand, { type: "operator.repin" }>,
	): { type: string; actor: unknown; data: unknown } {
		this.requireRevision(snapshot, command.revision);
		const runs = this.runs(db, snapshot.workflowId);
		this.validateStructure(snapshot, definition, runs);
		const previous = snapshot.definition.digest;
		snapshot.definition = { ...snapshot.definition, digest: definition.digest };
		snapshot.repinned = { fromDigest: previous, at: nowIso(this.now) };
		return {
			type: "operator.repin",
			actor: { kind: "operator" },
			data: { from: previous, to: definition.digest },
		};
	}
	private repair(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		command: Extract<WorkflowCommand, { type: "operator.repair" }>,
	) {
		this.requireRevision(snapshot, command.revision);
		if (
			!definition.steps.includes(command.targetStep) ||
			definition.terminal.includes(command.targetStep) ||
			this.registry.step(command.targetStep).actor === "system"
		)
			throw new WorkflowRuntimeError(
				"invalid-repair",
				`incompatible repair target: ${command.targetStep}`,
			);
		const staleRuns = this.runs(db, snapshot.workflowId).filter(
			(run) => snapshot.step.activeRunIds.includes(run.id) && run.handle,
		);
		this.expireRuns(db, snapshot);
		db.query(
			"UPDATE workflow_outbox SET status='expired', lease=NULL WHERE workflow_id=? AND status IN ('pending','retry','running')",
		).run(snapshot.workflowId);
		for (const run of staleRuns)
			this.enqueue(
				db,
				snapshot,
				"agent.stop",
				`run:${run.id}:stop:${run.generation}`,
				{ runId: run.id },
			);
		const source = snapshot.currentStep;
		snapshot.currentStep = command.targetStep;
		snapshot.metadata.stepEnteredAt = nowIso(this.now);
		snapshot.status = "active";
		snapshot.step = freshStep(snapshot.step.attempt + 1);
		snapshot.repaired = {
			reason: command.reason,
			fromStep: source,
			at: nowIso(this.now),
		};
		snapshot.attention = [];
		this.enterStep(db, snapshot, definition);
		return {
			type: "operator.repair",
			actor: { kind: "operator" },
			data: { source, target: command.targetStep, reason: command.reason },
		};
	}
	private transition(
		db: Database,
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		outcome: string,
		output?: unknown,
	): void {
		const step = this.registry.step(snapshot.currentStep);
		this.applyReduction(
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
		const priorAttempt = snapshot.step.attempt;
		const priorResults = snapshot.step.results;
		const priorContext = snapshot.step.context;
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
		snapshot.metadata.stepEnteredAt = nowIso(this.now);
		snapshot.step = freshStep(edge.loop ? priorAttempt + 1 : 1);
		if (edge.from === "fusion.plan" && edge.to === "fusion.plan")
			// Retry of a failed role resumes collection: surviving validated
			// drafts are preserved instead of re-fanning every planner.
			snapshot.step.results = priorResults.filter(
				(result) => result.role.startsWith("planner-") && result.outputDigest,
			);
		if (edge.to === "core.triage")
			snapshot.step.attempt =
				(snapshot.loopCounts["core.verification:round"] ?? 0) + 1;
		if (edge.to === "core.verification") {
			const round = (snapshot.loopCounts["core.verification:round"] ?? 0) + 1;
			snapshot.loopCounts["core.verification:round"] = round;
			snapshot.step.attempt = round;
		}
		if (
			(snapshot.definition.id === "wiki-comments" &&
				priorContext !== undefined) ||
			(edge.loop && priorContext !== undefined && edge.to === edge.from) ||
			(output !== undefined &&
				[
					"core.plan",
					"core.implementation",
					"core.verification",
					"core.wiki",
					"fusion.consolidate",
				].includes(edge.to)) ||
			((edge.to === "core.wiki" || edge.to === "core.archive") &&
				outcome === "comments") ||
			(edge.to === "core.wiki-approval" && outcome === "complete")
		)
			snapshot.step.context =
				snapshot.definition.id === "wiki-comments" && priorContext !== undefined
					? priorContext
					: edge.to === "core.wiki-approval" && outcome === "complete"
						? wikiVerificationPayload(snapshot)
						: output === undefined
							? priorContext
							: (JSON.parse(JSON.stringify(output)) as JsonValue);
		if (
			edge.to === "core.verification" &&
			output &&
			typeof output === "object" &&
			"roles" in output &&
			Array.isArray((output as { roles: unknown }).roles)
		) {
			snapshot.step.selectedRoles = [...(output as { roles: string[] }).roles];
			if (!snapshot.step.selectedRoles.length)
				snapshot.step.testRunStarted = true;
		}
		if (edge.to === "core.plan" && outcome === "comments")
			snapshot.step.mode = "review-fix";
		if (edge.to === "core.implementation")
			snapshot.step.mode =
				outcome === "comments"
					? "review-fix"
					: outcome === "fix" || outcome === "failed"
						? "fix"
						: "apply";
		if (edge.to === "core.completed") snapshot.status = "completed";
		else if (edge.to === "core.closed") snapshot.status = "closed";
		else snapshot.status = "active";
		for (const effect of edge.effects ?? [])
			this.enqueue(
				db,
				snapshot,
				effect.kind,
				`${snapshot.workflowId}:${effect.idempotencyKey}:${snapshot.revision}`,
				effect.kind === "wiki.verify"
					? snapshot.definition.id === "wiki-comments"
						? wikiVerificationPayload(snapshot)
						: (priorContext ?? wikiVerificationPayload(snapshot))
					: effect.payload,
			);
		this.enterStep(db, snapshot, definition);
	}
	private enterStep(
		db: Database,
		snapshot: WorkflowSnapshot,
		_definition: CompiledWorkflowDefinition,
	): void {
		const step = this.registry.step(snapshot.currentStep);
		this.applyReduction(db, snapshot, step, step.enter(snapshot));
		if (step.actor === "agent") {
			if (!step.behavior) throw new Error(`missing step behavior: ${step.id}`);
			if (!step.behavior.roles)
				throw new Error(`missing role behavior for agent step ${step.id}`);
			const roles = step.behavior.roles({ snapshot });
			for (const role of roles) {
				if (snapshot.currentStep === "fusion.plan") {
					// Resume collection: never relaunch a role whose validated draft
					// already survived, nor one whose run is still pending/working.
					if (
						snapshot.step.results.some(
							(result) => result.role === role && result.outputDigest,
						)
					)
						continue;
					const active = snapshot.step.activeRunIds.find((id) => {
						const row = db
							.query("SELECT role FROM workflow_runs WHERE id=?")
							.get(id) as { role?: string } | undefined;
						return row?.role === role;
					});
					if (active) continue;
				}
				this.createRun(db, snapshot, step, role);
			}
			return;
		}
		if (snapshot.currentStep === "core.delivery")
			this.enqueue(
				db,
				snapshot,
				"delivery.commit",
				`delivery:${snapshot.workflowId}:commit`,
				{ workflowId: snapshot.workflowId },
			);
		if (snapshot.currentStep === "core.closed")
			this.enqueue(
				db,
				snapshot,
				"workspace.close",
				`workspace:${snapshot.workflowId}:close`,
				{ workflowId: snapshot.workflowId },
			);
	}
	private applyReduction(
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
			this.enqueue(
				db,
				snapshot,
				effect.kind,
				effect.idempotencyKey,
				JSON.parse(JSON.stringify(effect.payload)) as JsonValue,
			);
		}
	}
	private createRun(
		db: Database,
		snapshot: WorkflowSnapshot,
		step: Readonly<StepDefinition>,
		role: string,
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
				? path.join(wikiWorkflowDataRoot(), snapshot.metadata.changeId, "runs")
				: path.join(
						snapshot.metadata.worktree,
						".herdr-workflow",
						snapshot.metadata.changeId,
						"runs",
					);
		const assignmentPath = path.join(directory, `${id}.assignment.md`);
		const outputPath = path.join(directory, `${id}.output.json`);
		const expires = new Date(
			this.now().getTime() + 24 * 3600_000,
		).toISOString();
		const created = nowIso(this.now);
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
		this.enqueue(db, snapshot, "artifact.write", `run:${id}:assignment`, {
			runId: id,
		});
		this.enqueue(db, snapshot, "agent.launch", `run:${id}:launch`, {
			runId: id,
		});
		return run;
	}
	private enqueue(
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
	private artifact(
		run: WorkflowRun,
		submitted?: string,
	): { output: unknown; digest: string } {
		if (!submitted || !run.outputPath)
			throw new WorkflowRuntimeError("artifact", "required artifact missing");
		const expected = path.resolve(run.outputPath);
		const actual = path.resolve(submitted);
		if (actual !== expected)
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact path does not match assignment",
			);
		const root = path.resolve(path.dirname(run.assignmentPath));
		if (!actual.startsWith(`${root}${path.sep}`))
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact escapes run directory",
			);
		const stat = fs.lstatSync(actual);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.size > MAX_ARTIFACT_BYTES
		)
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact must be bounded regular non-symlink file",
			);
		const bytes = fs.readFileSync(actual);
		let envelope: unknown;
		try {
			envelope = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new WorkflowRuntimeError("artifact", "artifact is invalid JSON");
		}
		if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact envelope must be object",
			);
		const item = envelope as Record<string, unknown>;
		const schema = run.outputSchema;
		if (
			!schema ||
			item.runId !== run.id ||
			item.schemaId !== schema.id ||
			item.schemaVersion !== schema.version
		)
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact run/schema identity mismatch",
			);
		return {
			output: item.payload,
			digest: createHash("sha256").update(bytes).digest("hex"),
		};
	}
	private validateEffect(
		row: EffectRow,
		snapshot: WorkflowSnapshot,
		runs: WorkflowRun[],
	): void {
		if (!EFFECT_KINDS.has(row.kind as EffectKind))
			throw new WorkflowRuntimeError(
				"invalid-state",
				`unknown effect kind: ${row.kind}`,
			);
		const payload = JSON.parse(row.payload_json) as { runId?: unknown };
		const allowed = this.registry
			.step(snapshot.currentStep)
			.allowedEffects.includes(row.kind);
		// Edge effects are enqueued while advancing into delivery. Keep the
		// approval promotion legal without broadening delivery's effect contract.
		const wikiPromotionAtDelivery =
			row.kind === "wiki.verify" && snapshot.currentStep === "core.delivery";
		const wikiPromotionAtCompletion =
			row.kind === "wiki.verify" &&
			snapshot.definition.id === "wiki-comments" &&
			snapshot.currentStep === "core.completed";
		const researchWikiPromotion =
			row.kind === "wiki.verify" &&
			snapshot.definition.id === "research" &&
			snapshot.currentStep === "core.completed";
		const setupBeforeEntry =
			row.kind === "workspace.setup" &&
			!snapshot.step.activeRunIds.length &&
			snapshot.revision === 0;
		// Research deliberately starts its agent only after the repository-neutral
		// workspace setup effect completes. The workflow can receive other
		// revisions while that effect is pending, so keep that setup effect legal
		// for the active research step instead of incorrectly treating it as stale.
		const researchSetup =
			row.kind === "workspace.setup" &&
			snapshot.definition.id === "research" &&
			snapshot.currentStep === "core.research";
		if (
			!allowed &&
			!wikiPromotionAtDelivery &&
			!wikiPromotionAtCompletion &&
			!researchWikiPromotion &&
			!setupBeforeEntry &&
			!researchSetup &&
			row.kind !== "agent.stop"
		)
			throw new WorkflowRuntimeError(
				"invalid-state",
				`effect ${row.kind} is illegal at ${snapshot.currentStep}`,
			);
		if (["artifact.write", "agent.launch", "agent.prompt"].includes(row.kind)) {
			const run = runs.find((item) => item.id === payload.runId);
			if (
				!run ||
				!ACTIVE_RUN.has(run.status) ||
				!snapshot.step.activeRunIds.includes(run.id) ||
				run.stepId !== snapshot.currentStep
			)
				throw new WorkflowRuntimeError(
					"invalid-state",
					`effect run invariant failed: ${row.id}`,
				);
		}
		if (
			row.kind === "agent.stop" &&
			(typeof payload.runId !== "string" ||
				!runs.some((run) => run.id === payload.runId))
		)
			throw new WorkflowRuntimeError(
				"invalid-state",
				`stop effect run missing: ${row.id}`,
			);
	}
	private validateTriageScope(
		snapshot: WorkflowSnapshot,
		output: { assignments: Array<{ role: string; files: string[] }> },
	): void {
		const allowed = new Set([
			"quality-verifier",
			"security-verifier",
			"performance-verifier",
			"openspec-verifier",
			"usability-verifier",
		]);
		const changed = new Set(changedFilesIn(snapshot));
		for (const assignment of output.assignments) {
			if (
				!allowed.has(assignment.role) ||
				(snapshot.definition.id === "no-openspec" &&
					assignment.role === "openspec-verifier")
			)
				throw new WorkflowRuntimeError(
					"triage",
					`unsupported verifier role: ${assignment.role}`,
				);
			for (const file of assignment.files)
				if (!changed.has(file))
					throw new WorkflowRuntimeError(
						"triage",
						`triage file is outside changed scope: ${file}`,
					);
		}
	}
	private validateSourceBaseline(snapshot: WorkflowSnapshot): void {
		if (
			snapshot.definition.id !== "wiki" &&
			snapshot.definition.id !== "research"
		)
			return;
		if (snapshot.definition.id === "research" && !snapshot.metadata.repository)
			return;
		const baseline = snapshot.sourceBaseline?.fingerprint;
		if (!baseline)
			throw new WorkflowRuntimeError(
				"source-isolation",
				`${snapshot.definition.id} source baseline is missing`,
			);
		if (
			sourceContentFingerprint(
				snapshot.metadata.repository,
				snapshot.metadata.wikiRoot,
			) !== baseline
		)
			throw new WorkflowRuntimeError(
				"source-isolation",
				"source repository changed during documentation or research run",
			);
	}
	private validateStepEvidence(
		snapshot: WorkflowSnapshot,
		stepId: string,
	): void {
		if (stepId === "core.plan" || stepId === "fusion.consolidate")
			this.validatePlanningArtifacts(snapshot);
		if (
			stepId === "core.implementation" &&
			snapshot.definition.id !== "no-openspec"
		) {
			const tasks = path.join(
				snapshot.metadata.worktree,
				"openspec",
				"changes",
				snapshot.metadata.changeId,
				"tasks.md",
			);
			if (
				!fs.existsSync(tasks) ||
				/^\s*[-*]\s+\[ \]/m.test(fs.readFileSync(tasks, "utf8"))
			)
				throw new WorkflowRuntimeError(
					"entry-guard",
					"implementation requires completed OpenSpec tasks",
				);
		}
		if (stepId === "core.archive") {
			const active = path.join(
				snapshot.metadata.worktree,
				"openspec",
				"changes",
				snapshot.metadata.changeId,
			);
			const archive = path.join(
				snapshot.metadata.worktree,
				"openspec",
				"changes",
				"archive",
			);
			if (
				fs.existsSync(active) ||
				!fs.existsSync(archive) ||
				!fs
					.readdirSync(archive)
					.some(
						(name) =>
							name === snapshot.metadata.changeId ||
							name.endsWith(`-${snapshot.metadata.changeId}`),
					)
			)
				throw new WorkflowRuntimeError("entry-guard", "archive move not found");
		}
	}
	/** Planning and consolidation both must leave a complete OpenSpec change
	 * directory behind before their completion counts. */
	private validatePlanningArtifacts(snapshot: WorkflowSnapshot): void {
		const root = path.join(
			snapshot.metadata.worktree,
			"openspec",
			"changes",
			snapshot.metadata.changeId,
		);
		for (const file of ["proposal.md", "design.md", "tasks.md"])
			if (
				!fs.existsSync(path.join(root, file)) ||
				!fs.readFileSync(path.join(root, file), "utf8").trim()
			)
				throw new WorkflowRuntimeError(
					"entry-guard",
					`planning artifact invalid: ${file}`,
				);
		const specs = path.join(root, "specs");
		if (
			!fs.existsSync(specs) ||
			!walkFiles(specs).some((file) =>
				/#### Scenario:/.test(fs.readFileSync(file, "utf8")),
			)
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				"planning requires at least one OpenSpec scenario",
			);
	}
	private validateSnapshot(
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		runs: WorkflowRun[],
	): void {
		parseSnapshot(JSON.parse(json(snapshot)));
		if (snapshot.definition.digest !== definition.digest)
			throw new WorkflowRuntimeError(
				"pin-mismatch",
				"pinned definition digest unavailable",
			);
		this.validateStructure(snapshot, definition, runs);
	}
	private validateStructure(
		snapshot: WorkflowSnapshot,
		definition: CompiledWorkflowDefinition,
		runs: WorkflowRun[],
	): void {
		if (!definition.steps.includes(snapshot.currentStep))
			throw new WorkflowRuntimeError(
				"invalid-state",
				`step not in pinned definition: ${snapshot.currentStep}`,
			);
		const byId = new Map(runs.map((run) => [run.id, run]));
		for (const run of runs) {
			const route = snapshot.routing.routes.find(
				(item) =>
					item.stepId === run.stepId &&
					(item.role === undefined || item.role === run.role),
			);
			if (!route || route.profile.digest !== run.profile.digest)
				throw new WorkflowRuntimeError(
					"invalid-state",
					`run routing invariant failed: ${run.id}`,
				);
		}
		for (const id of snapshot.step.activeRunIds) {
			const run = byId.get(id);
			if (
				!run ||
				run.workflowId !== snapshot.workflowId ||
				run.stepId !== snapshot.currentStep ||
				!ACTIVE_RUN.has(run.status)
			)
				throw new WorkflowRuntimeError(
					"invalid-state",
					`active run invariant failed: ${id}`,
				);
		}
		if (
			this.registry.step(snapshot.currentStep).actor !== "agent" &&
			snapshot.step.activeRunIds.length
		)
			throw new WorkflowRuntimeError(
				"invalid-state",
				"non-agent step has active runs",
			);
	}
	private actions(snapshot: WorkflowSnapshot): WorkflowActionView[] {
		if (snapshot.status === "paused")
			return [{ id: "resume", label: "Resume", confirmation: "confirm" }];
		const actions: WorkflowActionView[] =
			snapshot.definition.id === "research" &&
			snapshot.currentStep !== "core.closed" &&
			snapshot.currentStep !== "core.completed"
				? snapshot.currentStep === "core.research"
					? [
							{
								id: "research-follow-up",
								label: "Ask researcher follow-up",
								confirmation: "reason" as const,
								input: {
									schemaId: "core.research-follow-up",
									schemaVersion: 1,
								},
							},
							{
								id: "close-research",
								label: "Close research",
								confirmation: "confirm",
							},
						]
					: snapshot.currentStep === "core.wiki-approval"
						? [
								{
									id: "approve-wiki",
									label: "Approve wiki",
									confirmation: "confirm" as const,
								},
								{
									id: "review-comments",
									label: "Request wiki changes",
									confirmation: "confirm" as const,
									input: {
										schemaId: "core.review-comments",
										schemaVersion: 1,
									},
								},
							]
						: []
				: snapshot.currentStep === "core.plan-approval"
					? [
							{
								id: "approve-plan",
								label: "Approve plan",
								confirmation: "confirm",
							},
							{
								id: "review-comments",
								label: "Request plan changes",
								confirmation: "confirm",
								input: { schemaId: "core.review-comments", schemaVersion: 1 },
							},
							{
								id: "reject-plan",
								label: "Reject plan",
								confirmation: "reason",
								input: { schemaId: "core.plan-rejection", schemaVersion: 1 },
							},
						]
					: snapshot.currentStep === "core.developer-review"
						? [
								{
									id: "approve-review",
									label: "Approve change",
									confirmation: "confirm",
								},
								{
									id: "review-comments",
									label: "Request changes",
									confirmation: "confirm",
									input: { schemaId: "core.review-comments", schemaVersion: 1 },
								},
							]
						: snapshot.currentStep === "core.wiki-approval"
							? [
									{
										id: "approve-wiki",
										label: "Approve wiki",
										confirmation: "confirm",
									},
									{
										id: "review-comments",
										label: "Request wiki changes",
										confirmation: "confirm",
										input: {
											schemaId: "core.review-comments",
											schemaVersion: 1,
										},
									},
								]
							: snapshot.currentStep === "core.completed"
								? [
										...([
											"openspec-propose",
											"openspec-fusion-propose",
											"wiki",
											"wiki-comments",
											"research",
										].includes(snapshot.definition.id)
											? []
											: [
													{
														id: "create-pr",
														label: "Create pull request",
														confirmation: "confirm" as const,
													},
												]),
										{
											id: "close",
											label: "Close workflow",
											confirmation: "confirm",
										},
									]
								: [];
		return actions;
	}
	private viewById(repo: string, id: string): WorkflowView {
		const db = openStore(repo);
		try {
			return this.view(db, id);
		} finally {
			db.close();
		}
	}
	private view(db: Database, id: string): WorkflowView {
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
			const row = this.instance(db, id);
			const snapshot = parseSnapshot(JSON.parse(row.snapshot_json));
			const definition = this.registry.definition(
				snapshot.definition.id,
				snapshot.definition.version,
				snapshot.definition.digest,
			);
			const runs = this.runs(db, id);
			this.validateSnapshot(snapshot, definition, runs);
			const effects = this.effects(db, id);
			const failedActions = effects
				.filter((effect) => effect.status === "failed")
				.map((effect) => ({
					id: `retry-effect:${effect.id}`,
					label: `Retry ${effect.kind}`,
					confirmation: "confirm" as const,
				}));
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
					label: this.registry.step(snapshot.currentStep).label,
					attempt: snapshot.step.attempt,
					enteredAt: snapshot.metadata.stepEnteredAt,
					...(snapshot.step.context !== undefined
						? { context: snapshot.step.context }
						: {}),
				},
				runs: runs.map((run) => ({
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
				effects: effects.map((effect) => ({
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
						Date.parse(item.expiresAt) > this.now().getTime(),
				),
				availableActions: [
					...this.actions(snapshot).filter(
						(action) =>
							action.id !== "create-pr" ||
							!effects.some((effect) => effect.kind === "pull-request.create"),
					),
					...failedActions,
				],
			};
		} catch (error) {
			const diagnostic = boundedError(error);
			if (/pin mismatch/.test(diagnostic)) {
				try {
					const row = this.instance(db, id);
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
						effects: [],
						observations: [],
						health: { valid: false, attention: [diagnostic], diagnostic },
						developerDialogue: snapshot.developerDialogue,
						pendingQuestions: snapshot.developerDialogue.filter(
							(item) =>
								item.status === "pending" &&
								Date.parse(item.expiresAt) > this.now().getTime(),
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
	private locate(db: Database, command: WorkflowCommand): InstanceRow {
		if (command.type === "agent.handoff") {
			const row = db
				.query("SELECT workflow_id FROM workflow_runs WHERE id=?")
				.get(command.runId) as { workflow_id: string } | null;
			if (!row) throw new WorkflowRuntimeError("not-found", "run not found");
			return this.instance(db, row.workflow_id);
		}
		if (command.type === "effect.result") {
			const row = db
				.query("SELECT workflow_id FROM workflow_outbox WHERE id=?")
				.get(command.effectId) as { workflow_id: string } | null;
			if (!row) throw new WorkflowRuntimeError("not-found", "effect not found");
			return this.instance(db, row.workflow_id);
		}
		return this.instance(db, command.workflowId);
	}
	private instance(db: Database, id: string): InstanceRow {
		const row = db
			.query("SELECT * FROM workflow_instances WHERE id=?")
			.get(id) as InstanceRow | null;
		if (!row)
			throw new WorkflowRuntimeError("not-found", `workflow not found: ${id}`);
		return row;
	}
	private instanceByChange(db: Database, change: string): InstanceRow {
		const row = db
			.query("SELECT * FROM workflow_instances WHERE change_id=?")
			.get(change) as InstanceRow | null;
		if (!row)
			throw new WorkflowRuntimeError(
				"not-found",
				`workflow not found: ${change}`,
			);
		return row;
	}
	private runs(db: Database, id: string): WorkflowRun[] {
		return (
			db
				.query("SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY rowid")
				.all(id) as RunRow[]
		).map(runFromRow);
	}
	private effects(db: Database, id: string): WorkflowEffect[] {
		return (
			db
				.query(
					"SELECT * FROM workflow_outbox WHERE workflow_id=? ORDER BY rowid",
				)
				.all(id) as EffectRow[]
		).map(effectFromRow);
	}
	private writeSnapshot(db: Database, snapshot: WorkflowSnapshot): void {
		db.query(
			"UPDATE workflow_instances SET revision=?,status=?,current_step=?,snapshot_json=?,updated_at=? WHERE id=?",
		).run(
			snapshot.revision,
			snapshot.status,
			snapshot.currentStep,
			json(snapshot),
			snapshot.metadata.updatedAt,
			snapshot.workflowId,
		);
	}
	private requireRevision(snapshot: WorkflowSnapshot, revision: number): void {
		if (snapshot.revision !== revision)
			throw new WorkflowRuntimeError(
				"revision-conflict",
				`stale revision ${revision}; current ${snapshot.revision}`,
				snapshot.revision,
			);
	}
	/**
	 * Stops the agents for every core.triage/core.verification run that
	 * belongs to the round transitioning away (pass/fix/limit). Runs within a
	 * round complete individually as they finish, so by the time the round is
	 * over their handles no longer live in activeRunIds; find them by shared
	 * round attempt instead, mirroring the failed-path cleanup in
	 * expireSiblingRuns so verifier/triage panes never outlive their round.
	 */
	private stopRoundAgents(
		db: Database,
		snapshot: WorkflowSnapshot,
		attempt: number,
	): void {
		const roundRuns = this.runs(db, snapshot.workflowId).filter(
			(run) =>
				(run.stepId === "core.triage" || run.stepId === "core.verification") &&
				run.attempt === attempt &&
				run.handle,
		);
		for (const run of roundRuns)
			this.enqueue(
				db,
				snapshot,
				"agent.stop",
				`run:${run.id}:stop:${run.generation}`,
				{ runId: run.id },
			);
	}
	private expireSiblingRuns(db: Database, snapshot: WorkflowSnapshot): void {
		const siblings = this.runs(db, snapshot.workflowId).filter((run) =>
			snapshot.step.activeRunIds.includes(run.id),
		);
		for (const run of siblings) {
			db.query(
				"UPDATE workflow_runs SET status='expired',capability_hash='',completed_at=? WHERE id=? AND status IN ('pending','working')",
			).run(nowIso(this.now), run.id);
			db.query(
				"UPDATE workflow_outbox SET status='expired',lease=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND json_extract(payload_json,'$.runId')=?",
			).run(snapshot.workflowId, run.id);
			if (run.handle)
				this.enqueue(
					db,
					snapshot,
					"agent.stop",
					`run:${run.id}:stop:${run.generation}`,
					{ runId: run.id },
				);
		}
		this.expireQuestions(
			snapshot,
			siblings.map((run) => run.id),
		);
		snapshot.step.activeRunIds = [];
	}
	private expireRuns(db: Database, snapshot: WorkflowSnapshot): void {
		const runIds = [...snapshot.step.activeRunIds];
		for (const id of runIds) {
			db.query(
				"UPDATE workflow_runs SET status='expired',capability_hash='',completed_at=? WHERE id=? AND status IN ('pending','working')",
			).run(nowIso(this.now), id);
			db.query(
				"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind IN ('artifact.write','agent.launch','agent.prompt') AND json_extract(payload_json,'$.runId')=?",
			).run(snapshot.workflowId, id);
		}
		if (snapshot.definition.id === "research")
			db.query(
				"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind='workspace.setup'",
			).run(snapshot.workflowId);
		this.expireQuestions(snapshot, runIds);
		snapshot.step.activeRunIds = [];
	}
	private expireQuestions(snapshot: WorkflowSnapshot, runIds: string[]): void {
		const expired = new Set(runIds);
		const at = nowIso(this.now);
		for (const question of snapshot.developerDialogue)
			if (question.status === "pending" && expired.has(question.runId)) {
				question.status = "expired";
				question.answeredAt = at;
				question.answer = { kind: "cancel" };
			}
	}
}
function validateFusionRouting(
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
function fusionDraftInputs(snapshot: WorkflowSnapshot): JsonValue {
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
function currentBranch(repo: string): string | undefined {
	const result = Bun.spawnSync(
		["git", "-C", repo, "branch", "--show-current"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return result.exitCode === 0
		? result.stdout.toString().trim() || undefined
		: undefined;
}
function freshStep(attempt: number): WorkflowSnapshot["step"] {
	return {
		attempt,
		activeRunIds: [],
		completedRunIds: [],
		selectedRoles: [],
		testRunStarted: false,
		results: [],
	};
}
function gitNullSeparated(repository: string, args: string[]): string[] {
	const result = Bun.spawnSync(["git", "-C", repository, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new WorkflowRuntimeError(
			"source-isolation",
			`unable to fingerprint Git content: ${result.stderr.toString().trim()}`,
		);
	return result.stdout.toString().split("\0").filter(Boolean);
}
function sourcePathExcluded(
	repository: string,
	relative: string,
	configuredWikiPath = wikiRoot(),
): boolean {
	const absolute = path.resolve(repository, relative);
	const workflowRoot = path.resolve(repository, ".herdr-workflow");
	if (
		absolute === workflowRoot ||
		absolute.startsWith(`${workflowRoot}${path.sep}`)
	)
		return true;
	const repositoryRoot = path.resolve(repository);
	const configuredWiki = path.resolve(configuredWikiPath);
	const wikiIsInsideRepository =
		configuredWiki !== repositoryRoot &&
		configuredWiki.startsWith(`${repositoryRoot}${path.sep}`);
	return (
		wikiIsInsideRepository &&
		(absolute === configuredWiki ||
			absolute.startsWith(`${configuredWiki}${path.sep}`))
	);
}
/** Fingerprint source content and index state while excluding engine bookkeeping
 * and a centralized wiki bundle if it happens to live under the repository. */
export function sourceContentFingerprint(
	repository: string,
	configuredWikiPath = wikiRoot(),
): string {
	const tracked = [
		...gitNullSeparated(repository, ["ls-files", "-z", "--cached"]),
		...gitNullSeparated(repository, [
			"ls-files",
			"-z",
			"--others",
			"--exclude-standard",
		]),
		...gitNullSeparated(repository, [
			"ls-files",
			"-z",
			"--others",
			"--ignored",
			"--exclude-standard",
		]),
	].filter(
		(relative) =>
			sourcePathExcluded(repository, relative, configuredWikiPath) === false,
	);
	const staged = gitNullSeparated(repository, ["ls-files", "--stage", "-z"])
		.filter((entry) => {
			const separator = entry.indexOf("\t");
			return (
				separator >= 0 &&
				sourcePathExcluded(
					repository,
					entry.slice(separator + 1),
					configuredWikiPath,
				) === false
			);
		})
		.sort();
	const hash = createHash("sha256");
	for (const entry of staged) hash.update(`index:${entry.length}:${entry}\0`);
	for (const relative of [...new Set(tracked)].sort()) {
		hash.update(`path:${relative.length}:${relative}\0`);
		const file = path.join(repository, relative);
		try {
			const stat = fs.lstatSync(file);
			if (stat.isSymbolicLink()) {
				const target = fs.readlinkSync(file);
				hash.update(`symlink:${target.length}:${target}\0`);
			} else if (stat.isFile()) {
				const content = fs.readFileSync(file);
				hash.update(`file:${content.length}:`);
				hash.update(content);
				hash.update("\0");
			} else hash.update(`mode:${stat.mode}\0`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			hash.update("missing\0");
		}
	}
	return hash.digest("hex");
}
export function changedFilesIn(snapshot: WorkflowSnapshot): string[] {
	const root = snapshot.metadata.worktree;
	const changed = new Set<string>();
	const addTree = (relative: string): void => {
		const entries = fs.readdirSync(path.join(root, relative), {
			withFileTypes: true,
		});
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) addTree(child);
			else changed.add(child);
		}
	};
	const result = Bun.spawnSync(["git", "-C", root, "status", "--porcelain"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	for (const line of result.stdout.toString().split("\n").filter(Boolean)) {
		const relative = line.slice(3).replace(/\/$/, "");
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(path.join(root, relative));
		} catch {
			/* missing on disk (e.g. deleted); keep the entry as-is */
		}
		if (stat?.isDirectory()) addTree(relative);
		else changed.add(relative);
	}
	const committed = Bun.spawnSync(
		[
			"git",
			"-C",
			root,
			"diff",
			"--name-only",
			`${snapshot.metadata.baseCommit}..HEAD`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	for (const file of committed.stdout.toString().split("\n").filter(Boolean))
		changed.add(file);
	return [...changed].sort();
}
function samePath(left: string, right: string): boolean {
	try {
		return fs.realpathSync(left) === fs.realpathSync(right);
	} catch {
		return path.resolve(left) === path.resolve(right);
	}
}
function withWikiRoot<T>(root: string, operation: () => T): T {
	const previous = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = root;
	try {
		return operation();
	} finally {
		if (previous === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previous;
	}
}
function wikiBaselineFor(
	root: string,
	context: JsonValue | undefined,
): WorkflowSnapshot["wikiBaseline"] {
	const comments =
		context && typeof context === "object" && !Array.isArray(context)
			? (context as { comments?: unknown }).comments
			: undefined;
	const allowed = new Set(
		Array.isArray(comments)
			? comments.flatMap((comment) =>
					comment && typeof comment === "object" && "conceptId" in comment
						? [String((comment as { conceptId: unknown }).conceptId)]
						: [],
				)
			: [],
	);
	return {
		fingerprint: wikiBundleFingerprint(root, allowed),
		concepts: listConcepts().map((concept) => ({
			id: concept.id,
			digest: wikiConceptFingerprint(concept.id, root) ?? "",
		})),
	};
}
function wikiReviewConceptIds(
	snapshot: WorkflowSnapshot,
): Set<string> | undefined {
	if (snapshot.definition.id !== "wiki-comments") return undefined;
	const context = snapshot.step.context;
	const comments =
		context && typeof context === "object" && !Array.isArray(context)
			? (context as { comments?: unknown }).comments
			: undefined;
	return new Set(
		Array.isArray(comments)
			? comments.flatMap((comment) =>
					comment && typeof comment === "object" && "conceptId" in comment
						? [String((comment as { conceptId: unknown }).conceptId)]
						: [],
				)
			: [],
	);
}
function wikiVerificationPayload(snapshot: WorkflowSnapshot): {
	concepts: Array<{ id: string; digest: string }>;
} {
	const pinnedRoot = path.resolve(snapshot.metadata.wikiRoot ?? wikiRoot(true));
	if (!samePath(wikiRoot(), pinnedRoot))
		throw new WorkflowRuntimeError(
			"wiki-root",
			"wiki root does not match the pinned workflow wiki root",
		);
	return withWikiRoot(pinnedRoot, () => {
		const all = snapshotList(
			snapshot.metadata.changeId,
			snapshot.definition.id === "wiki-comments" ||
				snapshot.definition.id === "research"
				? wikiWorkflowDataRoot()
				: snapshot.metadata.worktree,
		);
		const requested = wikiReviewConceptIds(snapshot);
		if (requested && all.some((id) => !requested.has(id)))
			throw new WorkflowRuntimeError(
				"wiki-scope",
				"wiki agent touched a concept outside submitted comments",
			);
		return {
			concepts: all
				.filter((id) => !requested || requested.has(id))
				.map((id) => ({
					id,
					digest: createHash("sha256")
						.update(fs.readFileSync(conceptPath(id)))
						.digest("hex"),
				})),
		};
	});
}
function walkFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(file));
		else files.push(file);
	}
	return files;
}
function tableExists(db: Database, name: string): boolean {
	return Boolean(
		db
			.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(name),
	);
}
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
function diagnosticView(changeId: string, diagnostic: string): WorkflowView {
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
function boundedError(value: unknown): string {
	const text =
		value instanceof Error
			? value.message
			: typeof value === "string"
				? value
				: JSON.stringify(value);
	return (text || "unknown error").slice(0, 2048);
}
function rollback(db: Database): void {
	try {
		db.exec("ROLLBACK");
	} catch {
		/* no transaction */
	}
}
export const runtimeTest = { hashToken, tokenMatches, MAX_ARTIFACT_BYTES };
