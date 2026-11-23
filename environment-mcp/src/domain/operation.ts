import * as z from "zod/v4";

const boundedIdentity = z.string().trim().min(1).max(256);
export const operationIntentSchema = z.strictObject({
	app: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	target: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	repository: z.string().min(1).max(4096).optional(),
});
export const operatorDecisionSchema = z.strictObject({
	requestId: boundedIdentity,
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	revision: z.number().int().min(1),
	decision: z.enum(["approved", "rejected"]),
});
export const operatorAcknowledgementSchema = z.strictObject({
	requestId: boundedIdentity,
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	revision: z.number().int().min(1),
});
const workspaceSchema = z.strictObject({
	directory: z.string(),
	device: z.string(),
	inode: z.string(),
});
export const scopeRecordSchema = z.strictObject({
	id: z.uuid(),
	principal: boundedIdentity,
	host: z.uuid(),
	workspace: workspaceSchema,
	state: z.enum(["active", "closing", "closed", "interrupted"]),
	revision: z.number().int().positive(),
});
export const operationRecordSchema = z.strictObject({
	id: z.uuid(),
	scope: z.uuid(),
	host: z.uuid(),
	kind: z.enum(["dependency-bindings", "executable"]),
	identity: z.string(),
	plan: z.string(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	state: z.enum([
		"awaiting-approval",
		"approved",
		"rejected",
		"issued",
		"completed",
		"interrupted",
	]),
	revision: z.number().int().positive(),
	createdAt: z.number().int(),
	inspectionRequired: z.boolean(),
	result: z.string().optional(),
});
export type OperationIntent = z.output<typeof operationIntentSchema>;
export type OperatorDecision = z.output<typeof operatorDecisionSchema>;
export type OperatorAcknowledgement = z.output<
	typeof operatorAcknowledgementSchema
>;
export type ScopeRecord = z.output<typeof scopeRecordSchema>;
export type OperationRecord = z.output<typeof operationRecordSchema>;

export class OperationRefusal extends Error {
	constructor(
		readonly code:
			| "journal-unavailable"
			| "scope-unavailable"
			| "operation-unavailable"
			| "request-conflict"
			| "decision-conflict"
			| "journal-capacity"
			| "cleanup-unavailable"
			| "repository-ambiguous"
			| "repository-unauthorized"
			| "network-prerequisite-unavailable"
			| "secret-reference-unavailable",
	) {
		super(code);
	}
}

export function operationView(record: OperationRecord, currentHost: string) {
	const { plan: _plan, identity: _identity, host, ...view } = record;
	return { ...view, historical: host !== currentHost };
}
