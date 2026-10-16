// The durable workflow store (`herdr.db`).
//
// This is the authoritative record of run identity: a run's id, step, role,
// attempt, generation and status live here, not in telemetry. The snapshot
// holds three of these stores (the current main store, a 2026-10-14 backup and
// the grid-allocation-backend store), so the reader is a plain function over a
// path and the caller decides which store it is.

import { Database } from "bun:sqlite";

export interface HerdrInstance {
	id: string;
	repository?: string;
	worktree?: string;
	definitionId?: string;
	definitionVersion?: number;
	status?: string;
	currentStep?: string;
	branch?: string;
	baseCommit?: string;
	createdAt?: string;
	updatedAt?: string;
	/** Length of the assignment text, never the text itself. */
	taskBytes?: number;
}

export interface HerdrRun {
	runId: string;
	workflowId: string;
	stepId?: string;
	role?: string;
	generation?: number;
	attempt?: number;
	status?: string;
	createdAt?: string;
	completedAt?: string;
	profile?: string;
	model?: string;
	runtime?: string;
	/** The agent-host handle: its `name` is how a pi-durable conversation
	 * announces itself, and `sessionId` is the run id again. */
	handleName?: string;
	handleConversationId?: string;
}

export interface HerdrEvent {
	workflowId: string;
	revision: number;
	type: string;
	at?: string;
	data?: Record<string, unknown>;
}

export interface HerdrReadResult {
	instances: HerdrInstance[];
	runs: HerdrRun[];
	events: HerdrEvent[];
	skipped: number;
	notes: string[];
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	return undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function readHerdr(filePath: string): HerdrReadResult {
	const result: HerdrReadResult = {
		instances: [],
		runs: [],
		events: [],
		skipped: 0,
		notes: [],
	};
	let db: Database | undefined;
	try {
		db = new Database(filePath, { readonly: true });
		const instanceRows = db
			.query<{ [key: string]: unknown }, []>(
				"select id, repository, worktree, definition_id, status, current_step, created_at, updated_at, snapshot_json from workflow_instances",
			)
			.all();
		for (const row of instanceRows) {
			const snapshot = parseJson(row.snapshot_json);
			const definition = parseJson(snapshot?.definition);
			const metadata = parseJson(snapshot?.metadata);
			const task = str(metadata?.task);
			result.instances.push({
				id: String(row.id),
				repository: str(row.repository) ?? str(metadata?.repository),
				worktree: str(row.worktree),
				definitionId: str(row.definition_id) ?? str(definition?.id),
				definitionVersion: num(definition?.version),
				status: str(row.status),
				currentStep: str(row.current_step),
				branch: str(metadata?.branch),
				baseCommit: str(metadata?.baseCommit),
				createdAt: str(row.created_at),
				updatedAt: str(row.updated_at),
				taskBytes:
					task === undefined ? undefined : Buffer.byteLength(task, "utf8"),
			});
		}
		const runRows = db
			.query<{ [key: string]: unknown }, []>(
				"select id, workflow_id, step_id, role, generation, attempt, status, created_at, completed_at, profile_json, handle_json from workflow_runs",
			)
			.all();
		for (const row of runRows) {
			const profile = parseJson(row.profile_json);
			const handle = parseJson(row.handle_json);
			result.runs.push({
				runId: String(row.id),
				workflowId: String(row.workflow_id),
				stepId: str(row.step_id),
				role: str(row.role),
				generation: num(row.generation),
				attempt: num(row.attempt),
				status: str(row.status),
				createdAt: str(row.created_at),
				completedAt: str(row.completed_at),
				profile: str(profile?.name),
				model:
					str(profile?.model) ??
					[str(profile?.provider), str(profile?.modelId)]
						.filter(Boolean)
						.join("/"),
				runtime: str(profile?.runtime),
				handleName: str(handle?.name),
				handleConversationId: str(handle?.conversationId),
			});
		}
		const eventRows = db
			.query<{ [key: string]: unknown }, []>(
				"select workflow_id, revision, type, data_json, at from workflow_events",
			)
			.all();
		for (const row of eventRows) {
			result.events.push({
				workflowId: String(row.workflow_id),
				revision: Number(row.revision),
				type: String(row.type),
				at: str(row.at),
				data: parseJson(row.data_json),
			});
		}
	} catch (error) {
		result.notes.push(`unreadable: ${(error as Error).message}`);
	} finally {
		db?.close();
	}
	return result;
}
