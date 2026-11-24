import * as z from "zod/v4";

const boundedIdentity = z.string().trim().min(1).max(256);
export const operationIntentSchema = z.strictObject({
	app: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	target: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	repository: z.string().min(1).max(4096).optional(),
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
	/** `awaiting-approval` and `rejected` remain readable for journals written
	 * before direct execution; new operations start approved and are issued
	 * immediately. */
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
export type ScopeRecord = z.output<typeof scopeRecordSchema>;
export type OperationRecord = z.output<typeof operationRecordSchema>;

export class OperationRefusal extends Error {
	constructor(
		readonly code:
			| "journal-unavailable"
			| "scope-unavailable"
			| "operation-unavailable"
			| "request-conflict"
			| "journal-capacity"
			| "cleanup-unavailable"
			| "configuration-busy"
			| "configuration-refresh-invalid"
			| "repository-ambiguous"
			| "repository-unauthorized"
			| "network-prerequisite-unavailable"
			| "secret-reference-unavailable",
	) {
		super(code);
	}
}

export type OperationSubject = {
	app: string;
	target: string;
	action?: string;
	repository?: string;
};

/** Safe UI attribution from the frozen plan. The plan itself never leaves the
 * private execution plan; the UI only receives the exact app/target/action
 * and repository directory. */
export function operationSubject(
	record: OperationRecord,
): OperationSubject | undefined {
	try {
		const plan = JSON.parse(record.plan) as unknown;
		if (!plan || typeof plan !== "object") return undefined;
		const value = plan as Record<string, unknown>;
		const intent =
			value.intent && typeof value.intent === "object"
				? (value.intent as Record<string, unknown>)
				: undefined;
		const descriptor =
			value.descriptor && typeof value.descriptor === "object"
				? (value.descriptor as Record<string, unknown>)
				: undefined;
		const workspace =
			value.workspace && typeof value.workspace === "object"
				? (value.workspace as Record<string, unknown>)
				: undefined;
		const app = typeof intent?.app === "string" ? intent.app : undefined;
		const target =
			typeof intent?.target === "string" ? intent.target : undefined;
		if (!app || !target) return undefined;
		const action =
			typeof descriptor?.action === "string" ? descriptor.action : undefined;
		const repository =
			typeof workspace?.directory === "string"
				? workspace.directory
				: undefined;
		return {
			app,
			target,
			...(action ? { action } : {}),
			...(repository ? { repository } : {}),
		};
	} catch {
		return undefined;
	}
}

export function operationView(record: OperationRecord, currentHost: string) {
	const { plan: _plan, identity: _identity, host, ...view } = record;
	const subject = operationSubject(record);
	return {
		...view,
		...(subject ? { subject } : {}),
		historical: host !== currentHost,
	};
}
