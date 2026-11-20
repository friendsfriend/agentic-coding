import { environmentDocument } from "../persistence.ts";

export type ControllerPrincipal = { id: string; role: "agent" | "operator" };
export type WorkspaceIdentity = {
	repository: string;
	directory: string;
	repositoryDevice: string;
	repositoryInode: string;
	device: string;
	inode: string;
};
export type ControllerScope = {
	id: string;
	owner: number;
	principal: ControllerPrincipal;
	host: string;
	workspace: WorkspaceIdentity;
	mode: "job" | "interactive" | "operator";
	idleMs: number | null;
	state: "active" | "closing" | "closed" | "interrupted";
	revision: number;
	createdAt: number;
};
export const ScopeState = environmentDocument<{
	nextOwner: number;
	scopes: Record<string, string>;
	requests: Record<string, string>;
	closures?: Record<string, string>;
}>({
	kind: "environment-controller.scopes",
	version: 1,
	initial: () => ({ nextOwner: 1, scopes: {}, requests: {} }),
});

export type ScopeClosure = {
	scope: string;
	owner: number;
	host: string;
	identity: string;
	state: "issued" | "completed" | "interrupted";
	inspectionRequired: boolean;
};

export class ControllerRefusal extends Error {
	constructor(
		readonly code:
			| "scope-unavailable"
			| "invalid-scope-request"
			| "scope-request-conflict"
			| "workspace-unavailable"
			| "operation-unavailable"
			| "operation-request-conflict"
			| "operation-plan-unavailable"
			| "controller-store-unavailable",
	) {
		super(code);
	}
}

export type ControllerOperation = {
	id: string;
	kind?: "environment" | "http" | "sql";
	scope: string;
	owner: number;
	host: string;
	identity: string;
	plan: string;
	digest: string;
	state:
		| "awaiting-approval"
		| "approved"
		| "rejected"
		| "issued"
		| "completed"
		| "interrupted";
	revision: number;
	createdAt: number;
	inspectionRequired: boolean;
	approval?: { requestId: string; identity: string };
	result?: string;
};
export const OperationState = environmentDocument<{
	operations: Record<string, string>;
	requests: Record<string, string>;
}>({
	kind: "environment-controller.operations",
	version: 1,
	initial: () => ({ operations: {}, requests: {} }),
});
