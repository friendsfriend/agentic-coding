import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { environmentApproval } from "../approval.ts";
import { belongsToOwner } from "../dependency-workspaces.ts";
import type { Plan } from "../model.ts";
import type { DiagnosticSnapshot } from "./diagnostic-input.ts";
import type { ControllerScopes } from "./scopes.ts";
import type { ControllerPersistence } from "./sqlite-persistence.ts";
import {
	type ControllerOperation,
	type ControllerPrincipal,
	ControllerRefusal,
	type ControllerScope,
	OperationState,
} from "./state.ts";

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const intentSchema = z.strictObject({
	apps: z
		.array(identifier)
		.min(1)
		.max(16)
		.refine((apps) => new Set(apps).size === apps.length),
	action: z.enum(["run", "build", "test"]),
	target: z.string().min(1).max(200).optional(),
	profile: z.string().min(1).max(64).optional(),
	runtime: z
		.enum(["shell", "systemshell", "docker", "podman", "compose", "kubernetes"])
		.optional(),
	replicas: z.number().int().min(1).max(16).optional(),
	lifetime: z
		.enum([
			"independent-roots-v1",
			"referenced-roots-v1",
			"shared-prerequisites-v1",
			"operator-infrastructure-v1",
			"operator-infrastructure-v2",
			"operator-infrastructure-v3",
		])
		.optional(),
	timeoutSec: z.number().int().min(1).max(7200).default(30),
});
export type ControllerIntent = z.output<typeof intentSchema>;
type PlanResolver = (
	scope: ControllerScope,
	intent: ControllerIntent,
) => Promise<readonly Plan[]>;
type Binding = { revision: number; digest: string };
export type DispatchPermit = {
	readonly operation: Readonly<ControllerOperation>;
};
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function operationIntentSummary(identity: string) {
	const value = JSON.parse(identity) as Record<string, unknown>;
	if (value.kind === "http") {
		const input = value.input as {
			app: string;
			endpoint: string;
			http: { method: string };
		};
		return {
			kind: "http",
			app: input.app,
			endpoint: input.endpoint,
			method: input.http.method,
		};
	}
	if (value.kind === "sql") {
		const input = value.input as { infra: string; app?: string };
		return {
			kind: "sql",
			infra: input.infra,
			...(input.app ? { app: input.app } : {}),
		};
	}
	return value;
}

function parseOperation(raw: string | undefined): ControllerOperation {
	try {
		if (typeof raw !== "string")
			throw new ControllerRefusal("operation-unavailable");
		const operation = JSON.parse(raw) as ControllerOperation;
		const snapshot = JSON.parse(operation.plan) as {
			kind?: ControllerOperation["kind"];
			diagnostic?: { kind?: string };
			scope: { id: string; owner: number };
		};
		if (
			digest(operation.plan) !== operation.digest ||
			snapshot.scope.id !== operation.scope ||
			snapshot.scope.owner !== operation.owner ||
			(snapshot.kind ?? "environment") !== (operation.kind ?? "environment") ||
			(operation.kind !== undefined &&
				operation.kind !== "environment" &&
				snapshot.diagnostic?.kind !== operation.kind)
		)
			throw new ControllerRefusal("operation-unavailable");
		return operation;
	} catch {
		throw new ControllerRefusal("operation-unavailable");
	}
}
function matches(operation: ControllerOperation, binding: Binding) {
	if (
		operation.digest !== binding.digest ||
		operation.revision !== binding.revision
	)
		throw new ControllerRefusal("operation-unavailable");
}

/** Durable data/issuance only. No process dispatch, secret resolution or MCP mutation tool. */
export class ControllerOperations {
	private permits = new WeakMap<DispatchPermit, string>();
	private constructor(
		private store: ControllerPersistence,
		private scopes: ControllerScopes,
		private resolve: PlanResolver,
	) {}
	static async open(
		store: ControllerPersistence,
		scopes: ControllerScopes,
		resolve: PlanResolver,
	) {
		await store.commit(async (tx) => {
			const data = await tx.doc(OperationState);
			for (const [id, raw] of Object.entries(data.operations)) {
				const operation = parseOperation(raw);
				if (
					operation.host !== store.host &&
					["awaiting-approval", "approved", "issued"].includes(operation.state)
				) {
					operation.inspectionRequired = operation.state === "issued";
					operation.state = "interrupted";
					operation.revision++;
					data.operations[id] = JSON.stringify(operation);
				}
			}
		});
		return new ControllerOperations(store, scopes, resolve);
	}
	bind(principal: ControllerPrincipal) {
		const session = this.scopes.bind(principal);
		const bound = { id: principal.id, role: principal.role };
		const read = async (id: string) => {
			const operation = parseOperation(
				(await this.store.snapshot(OperationState))?.operations[id],
			);
			await session.read(operation.scope);
			return operation;
		};
		const settle = async (
			permit: DispatchPermit,
			result: string,
			interrupted: boolean,
		) => {
			const id = this.permits.get(permit);
			if (
				!id ||
				typeof result !== "string" ||
				Buffer.byteLength(result) > 64000
			)
				throw new ControllerRefusal("operation-unavailable");
			await read(id);
			const completed = await this.store.commit(async (tx) => {
				const data = await tx.doc(OperationState);
				const operation = parseOperation(data.operations[id]);
				if (operation.state !== "issued" || operation.host !== this.store.host)
					throw new ControllerRefusal("operation-unavailable");
				operation.state = interrupted ? "interrupted" : "completed";
				operation.inspectionRequired = interrupted;
				operation.result = result;
				operation.revision++;
				data.operations[id] = JSON.stringify(operation);
				return operation;
			});
			this.permits.delete(permit);
			return completed;
		};
		const admitPrepared = async (
			scopeId: string,
			requestId: string,
			kind: NonNullable<ControllerOperation["kind"]>,
			normalized: unknown,
			prepare: (
				scope: ControllerScope,
			) => Promise<{ disclosure?: unknown; diagnostic?: DiagnosticSnapshot }>,
		) => {
			if (
				typeof scopeId !== "string" ||
				scopeId.length > 128 ||
				typeof requestId !== "string" ||
				!requestId.trim() ||
				requestId.length > 256
			)
				throw new ControllerRefusal("operation-unavailable");
			const identity = JSON.stringify(
				kind === "environment" ? normalized : { kind, input: normalized },
			);
			const key = digest(
				JSON.stringify([bound.id, bound.role, scopeId, requestId]),
			);
			const old = (await this.store.snapshot(OperationState))?.requests[key];
			if (old) {
				const saved = await read(old);
				if (saved.identity !== identity)
					throw new ControllerRefusal("operation-request-conflict");
				return saved;
			}
			const scope = await session.assertActive(scopeId);
			let plan: string;
			try {
				const detail = await prepare(structuredClone(scope));
				if (kind !== "environment" && detail.diagnostic?.kind !== kind)
					throw new ControllerRefusal("operation-plan-unavailable");
				plan = JSON.stringify({
					kind,
					scope: {
						id: scope.id,
						owner: scope.owner,
						workspace: scope.workspace,
						mode: scope.mode,
						idleMs: scope.idleMs,
					},
					...(kind === "environment"
						? { disclosure: detail.disclosure }
						: { diagnostic: detail.diagnostic }),
				});
				if (Buffer.byteLength(plan) > 512 * 1024)
					throw new ControllerRefusal("operation-plan-unavailable");
			} catch {
				throw new ControllerRefusal("operation-plan-unavailable");
			}
			return this.store.commit(async (tx) => {
				const data = await tx.doc(OperationState);
				const previous = data.requests[key];
				if (previous) {
					const saved = parseOperation(data.operations[previous]);
					if (saved.identity !== identity)
						throw new ControllerRefusal("operation-request-conflict");
					return saved;
				}
				if (
					!(await tx.ownerActive(scope.owner)) ||
					Object.keys(data.operations).length >= 1024
				)
					throw new ControllerRefusal("operation-unavailable");
				const operation: ControllerOperation = {
					id: randomUUID(),
					kind,
					scope: scope.id,
					owner: scope.owner,
					host: this.store.host,
					identity,
					plan,
					digest: digest(plan),
					state: "awaiting-approval",
					revision: 1,
					createdAt: Date.now(),
					inspectionRequired: false,
				};
				data.operations[operation.id] = JSON.stringify(operation);
				data.requests[key] = operation.id;
				return operation;
			});
		};
		return {
			read,
			admitDiagnostic: (
				scopeId: string,
				requestId: string,
				kind: "http" | "sql",
				normalized: unknown,
				prepare: (scope: ControllerScope) => Promise<DiagnosticSnapshot>,
			) =>
				admitPrepared(scopeId, requestId, kind, normalized, async (scope) => ({
					diagnostic: await prepare(scope),
				})),
			admit: async (scopeId: string, requestId: string, rawIntent: unknown) => {
				const parsed = intentSchema.safeParse(rawIntent);
				if (!parsed.success)
					throw new ControllerRefusal("operation-unavailable");
				const intent = parsed.data;
				return admitPrepared(
					scopeId,
					requestId,
					"environment",
					intent,
					async (scope) => {
						const plans = await this.resolve(
							structuredClone(scope),
							structuredClone(intent),
						);
						if (
							!plans.length ||
							plans.length > 128 ||
							plans.some(
								(plan) =>
									!belongsToOwner(plan, {
										id: scope.owner,
										repository: scope.workspace.repository,
										workspace: scope.workspace.directory,
									}) || plan.action !== intent.action,
							) ||
							intent.apps.some((app) => !plans.some((plan) => plan.app === app))
						)
							throw new ControllerRefusal("operation-plan-unavailable");
						return {
							disclosure: JSON.parse(
								environmentApproval([...plans], intent.timeoutSec),
							),
						};
					},
				);
			},
			issue: async (id: string, binding: Binding): Promise<DispatchPermit> => {
				const expected = { ...binding };
				await read(id);
				const operation = await this.store.commit(async (tx) => {
					const data = await tx.doc(OperationState);
					const operation = parseOperation(data.operations[id]);
					matches(operation, expected);
					if (
						operation.state !== "approved" ||
						!operation.approval ||
						operation.host !== this.store.host ||
						!(await tx.ownerActive(operation.owner))
					)
						throw new ControllerRefusal("operation-unavailable");
					operation.state = "issued";
					operation.revision++;
					data.operations[id] = JSON.stringify(operation);
					return operation;
				});
				const permit = Object.freeze({ operation: Object.freeze(operation) });
				this.permits.set(permit, id);
				return permit;
			},
			complete: (permit: DispatchPermit, result: string) =>
				settle(permit, result, false),
			interrupt: (permit: DispatchPermit, result: string) =>
				settle(permit, result, true),
		};
	}
	/** Backend for a future authenticated operator interface, deliberately not an MCP tool. */
	operator(principal: ControllerPrincipal) {
		this.scopes.bind(principal);
		if (principal.role !== "operator")
			throw new ControllerRefusal("operation-unavailable");
		const operatorId = principal.id;
		return {
			list: async (offset = 0, limit = 20) => {
				if (
					!Number.isSafeInteger(offset) ||
					offset < 0 ||
					offset > 1024 ||
					!Number.isSafeInteger(limit) ||
					limit < 1 ||
					limit > 20
				)
					throw new ControllerRefusal("operation-unavailable");
				const data = await this.store.snapshot(OperationState);
				const operations = Object.values(data?.operations ?? {}).map(
					parseOperation,
				);
				return {
					operations: operations
						.slice(offset, offset + limit)
						.map(
							({
								id,
								scope,
								state,
								revision,
								digest,
								inspectionRequired,
								createdAt,
								identity,
							}) => ({
								id,
								scope,
								state,
								revision,
								digest,
								inspectionRequired,
								createdAt,
								intent: operationIntentSummary(identity),
							}),
						),
					total: operations.length,
					nextOffset:
						offset + limit < operations.length ? offset + limit : null,
				};
			},
			inspect: async (id: string) =>
				parseOperation(
					(await this.store.snapshot(OperationState))?.operations[id],
				),
			decide: async (
				id: string,
				input: Binding & {
					requestId: string;
					decision: "approved" | "rejected";
				},
			) => {
				const decision = structuredClone(input);
				if (
					!decision.requestId?.trim() ||
					decision.requestId.length > 256 ||
					!["approved", "rejected"].includes(decision.decision)
				)
					throw new ControllerRefusal("operation-unavailable");
				const identity = JSON.stringify([
					operatorId,
					decision.digest,
					decision.revision,
					decision.decision,
				]);
				return this.store.commit(async (tx) => {
					const data = await tx.doc(OperationState);
					const operation = parseOperation(data.operations[id]);
					if (operation.approval) {
						if (
							operation.approval.requestId !== decision.requestId ||
							operation.approval.identity !== identity
						)
							throw new ControllerRefusal("operation-request-conflict");
						return operation;
					}
					matches(operation, decision);
					if (
						operation.state !== "awaiting-approval" ||
						operation.host !== this.store.host ||
						!(await tx.ownerActive(operation.owner))
					)
						throw new ControllerRefusal("operation-unavailable");
					operation.state = decision.decision;
					operation.approval = { requestId: decision.requestId, identity };
					operation.revision++;
					data.operations[id] = JSON.stringify(operation);
					return operation;
				});
			},
		};
	}
}
