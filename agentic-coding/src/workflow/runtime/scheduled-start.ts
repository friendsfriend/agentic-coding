import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { decodeSnapshot, WorkflowRuntimeError } from "../contracts.ts";
import type { StartWorkflowInput } from "./engine-types.ts";
import { openReadStore } from "./store.ts";

export interface ScheduledWorkflowOwner {
	occurrenceId: string;
	contentDigest: string;
}
export interface ScheduledWorkflowAuthority extends ScheduledWorkflowOwner {
	admittedAt: number;
	fence: number;
}
export interface ScheduledWorkflowReservation extends ScheduledWorkflowOwner {
	workflowId: string;
	inputDigest: string;
	definitionDigest: string;
	input: StartWorkflowInput;
	createdAt: string;
	activatedAt?: string;
	activationFence?: number;
}
interface Row {
	occurrence_id: string;
	workflow_id: string;
	content_digest: string;
	input_digest: string;
	definition_digest: string;
	input_json: string;
	created_at: string;
	activated_at: string | null;
	activation_fence: number | null;
}
export function assertScheduledOwner(owner: ScheduledWorkflowOwner): void {
	if (
		!/^[a-zA-Z0-9_-]{1,120}$/.test(owner.occurrenceId) ||
		!/^[a-f0-9]{64}$/.test(owner.contentDigest)
	)
		throw new WorkflowRuntimeError(
			"start-guard",
			"Invalid scheduling occurrence ownership.",
		);
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}
export function scheduledInputDigest(input: StartWorkflowInput): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(input)))
		.digest("hex");
}
export function scheduledReservation(
	db: Database,
	owner: ScheduledWorkflowOwner,
): ScheduledWorkflowReservation | undefined {
	assertScheduledOwner(owner);
	const row = db
		.query<Row, [string]>(
			"SELECT * FROM workflow_scheduled_reservations WHERE occurrence_id=?",
		)
		.get(owner.occurrenceId);
	if (!row) return undefined;
	if (row.content_digest !== owner.contentDigest)
		throw new WorkflowRuntimeError(
			"start-guard",
			"Scheduled workflow ownership/content mismatch.",
		);
	const input = JSON.parse(row.input_json) as StartWorkflowInput;
	if (
		input.workflowId !== row.workflow_id ||
		scheduledInputDigest(input) !== row.input_digest
	)
		throw new WorkflowRuntimeError(
			"invalid-state",
			"Corrupt scheduled workflow reservation.",
		);
	return {
		occurrenceId: row.occurrence_id,
		contentDigest: row.content_digest,
		workflowId: row.workflow_id,
		inputDigest: row.input_digest,
		definitionDigest: row.definition_digest,
		input,
		createdAt: row.created_at,
		...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
		...(row.activation_fence === null
			? {}
			: { activationFence: row.activation_fence }),
	};
}
export function queryScheduledWorkflow(
	repo: string,
	owner: ScheduledWorkflowOwner,
) {
	const db = openReadStore(repo);
	try {
		const reservation = scheduledReservation(db, owner);
		if (!reservation)
			throw new WorkflowRuntimeError(
				"not-found",
				"Scheduled workflow reservation is absent.",
			);
		const row = db
			.query<{ snapshot_json: string }, [string]>(
				"SELECT snapshot_json FROM workflow_instances WHERE id=?",
			)
			.get(reservation.workflowId);
		if (!reservation.activatedAt) {
			if (row)
				throw new WorkflowRuntimeError(
					"invalid-state",
					"Reserved identity contains an unrelated workflow.",
				);
			return { reservation };
		}
		if (!row)
			throw new WorkflowRuntimeError(
				"not-found",
				"Activated workflow is unavailable; reservation ownership retained.",
			);
		const snapshot = decodeSnapshot(JSON.parse(row.snapshot_json));
		if (
			snapshot.metadata.schedulingOrigin?.occurrenceId !== owner.occurrenceId ||
			snapshot.metadata.schedulingOrigin.contentDigest !==
				owner.contentDigest ||
			snapshot.definition.digest !== reservation.definitionDigest
		)
			throw new WorkflowRuntimeError(
				"invalid-state",
				"Native workflow ownership mismatch.",
			);
		return { reservation, snapshot };
	} finally {
		db.close();
	}
}
export function reserveScheduledWorkflow(
	db: Database,
	owner: ScheduledWorkflowOwner,
	input: StartWorkflowInput,
	definitionDigest: string,
	now: string,
): ScheduledWorkflowReservation {
	assertScheduledOwner(owner);
	if (input.metadata.schedulingOrigin !== undefined)
		throw new WorkflowRuntimeError(
			"start-guard",
			"Scheduling provenance is native-engine owned.",
		);
	const old = scheduledReservation(db, owner),
		digest = scheduledInputDigest(input);
	if (old) {
		if (
			old.inputDigest !== digest ||
			old.workflowId !== input.workflowId ||
			old.definitionDigest !== definitionDigest
		)
			throw new WorkflowRuntimeError(
				"start-guard",
				"Scheduled workflow reservation input mismatch.",
			);
		return old;
	}
	if (
		db
			.query("SELECT 1 FROM workflow_instances WHERE id=?")
			.get(input.workflowId) ||
		db
			.query(
				"SELECT 1 FROM workflow_scheduled_reservations WHERE workflow_id=?",
			)
			.get(input.workflowId)
	)
		throw new WorkflowRuntimeError(
			"already-exists",
			"Workflow identity is already owned; refusing unrelated attachment.",
		);
	const encoded = JSON.stringify(input);
	if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
		throw new WorkflowRuntimeError(
			"start-guard",
			"Scheduled workflow input exceeds reservation bound.",
		);
	db.query(
		"INSERT INTO workflow_scheduled_reservations(occurrence_id,workflow_id,content_digest,input_digest,definition_digest,input_json,created_at) VALUES (?,?,?,?,?,?,?)",
	).run(
		owner.occurrenceId,
		input.workflowId,
		owner.contentDigest,
		digest,
		definitionDigest,
		encoded,
		now,
	);
	return {
		...owner,
		workflowId: input.workflowId,
		inputDigest: digest,
		definitionDigest,
		input: JSON.parse(encoded) as StartWorkflowInput,
		createdAt: now,
	};
}
