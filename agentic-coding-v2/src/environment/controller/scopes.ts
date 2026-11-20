import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { definitionProjectLimit } from "../definition-limits.ts";
import type { EnvironmentTransaction } from "../persistence.ts";
import type { ControllerPersistence } from "./sqlite-persistence.ts";
import {
	type ControllerPrincipal,
	ControllerRefusal,
	type ControllerScope,
	type ScopeClosure,
	ScopeState,
} from "./state.ts";
import { captureWorkspace } from "./workspace.ts";

export type ScopeRequest = {
	requestId: string;
	repository: string;
	workspace: string;
	mode: "job" | "interactive" | "operator";
	idleMs: number | null;
};
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const samePrincipal = (a: ControllerPrincipal, b: ControllerPrincipal) =>
	a.id === b.id && a.role === b.role;

function validate(request: ScopeRequest, principal: ControllerPrincipal) {
	if (
		Object.keys(request).some(
			(key) =>
				!["requestId", "repository", "workspace", "mode", "idleMs"].includes(
					key,
				),
		) ||
		typeof request.requestId !== "string" ||
		!request.requestId.trim() ||
		request.requestId.length > 256 ||
		typeof request.repository !== "string" ||
		typeof request.workspace !== "string" ||
		!["job", "interactive", "operator"].includes(request.mode) ||
		(request.mode === "operator"
			? principal.role !== "operator" || request.idleMs !== null
			: !Number.isSafeInteger(request.idleMs) ||
				Number(request.idleMs) <= 0 ||
				Number(request.idleMs) > 30 * 24 * 60 * 60_000)
	)
		throw new ControllerRefusal("invalid-scope-request");
}

/** Internal authority API. A transport must authenticate before binding a principal.
 * No caller-supplied principal/owner fields are accepted by individual operations. */
export class ControllerScopes {
	private constructor(
		private store: ControllerPersistence,
		private repositories: readonly string[],
	) {}
	static async open(
		store: ControllerPersistence,
		repositories: readonly string[],
	) {
		if (
			repositories.length === 0 ||
			repositories.length > definitionProjectLimit
		)
			throw new ControllerRefusal("workspace-unavailable");
		const roots = [
			...new Set(repositories.map((root) => fs.realpathSync(root))),
		];
		for (const root of roots) {
			captureWorkspace(roots, root, root);
			const relative = path.relative(root, store.directory);
			if (
				relative === "" ||
				(!relative.startsWith(`..${path.sep}`) &&
					relative !== ".." &&
					!path.isAbsolute(relative))
			)
				throw new ControllerRefusal("controller-store-unavailable");
		}
		await store.commit(async (tx) => {
			const data = await tx.doc(ScopeState);
			for (const [owner, raw] of Object.entries(data.scopes)) {
				const scope = JSON.parse(raw) as ControllerScope;
				if (
					scope.host !== store.host &&
					["active", "closing"].includes(scope.state)
				) {
					scope.state = "interrupted";
					scope.revision++;
					data.scopes[owner] = JSON.stringify(scope);
				}
			}
			for (const [key, raw] of Object.entries(data.closures ?? {})) {
				const closure = JSON.parse(raw) as ScopeClosure;
				if (
					closure.host !== store.host &&
					closure.state === "issued" &&
					data.closures
				)
					data.closures[key] = JSON.stringify({
						...closure,
						state: "interrupted",
						inspectionRequired: true,
					});
			}
		});
		return new ControllerScopes(store, roots);
	}
	bind(principal: ControllerPrincipal) {
		if (
			typeof principal.id !== "string" ||
			!principal.id.trim() ||
			principal.id.length > 256 ||
			!["agent", "operator"].includes(principal.role)
		)
			throw new ControllerRefusal("scope-unavailable");
		const bound = { id: principal.id, role: principal.role };
		const findIn = (data: Record<string, string> | undefined, id: string) => {
			const scope = Object.values(data ?? {})
				.map((raw) => JSON.parse(raw) as ControllerScope)
				.find((scope) => scope.id === id);
			if (!scope || !samePrincipal(scope.principal, bound))
				throw new ControllerRefusal("scope-unavailable");
			return scope;
		};
		const find = async (tx: EnvironmentTransaction, id: string) =>
			findIn((await tx.doc(ScopeState)).scopes, id);
		return {
			create: async (raw: ScopeRequest): Promise<ControllerScope> => {
				const request = structuredClone(raw);
				validate(request, bound);
				const identity = JSON.stringify({
					repository: request.repository,
					workspace: request.workspace,
					mode: request.mode,
					idleMs: request.idleMs,
				});
				const key = hash(
					JSON.stringify([bound.id, bound.role, request.requestId]),
				);
				return this.store.commit(async (tx) => {
					const data = await tx.doc(ScopeState);
					const old = data.requests[key];
					if (old) {
						const receipt = JSON.parse(old) as {
							identity: string;
							owner: number;
						};
						if (receipt.identity !== identity)
							throw new ControllerRefusal("scope-request-conflict");
						const raw = data.scopes[String(receipt.owner)];
						if (!raw) throw new ControllerRefusal("scope-unavailable");
						return find(tx, (JSON.parse(raw) as ControllerScope).id);
					}
					if (
						Object.keys(data.scopes).length >= 1024 ||
						!Number.isSafeInteger(data.nextOwner) ||
						data.nextOwner < 1 ||
						data.nextOwner >= Number.MAX_SAFE_INTEGER
					)
						throw new ControllerRefusal("scope-unavailable");
					const workspace = captureWorkspace(
						this.repositories,
						request.repository,
						request.workspace,
					);
					const scope: ControllerScope = {
						id: randomUUID(),
						owner: data.nextOwner++,
						principal: bound,
						host: this.store.host,
						workspace,
						mode: request.mode,
						idleMs: request.idleMs,
						state: "active",
						revision: 1,
						createdAt: Date.now(),
					};
					data.scopes[String(scope.owner)] = JSON.stringify(scope);
					data.requests[key] = JSON.stringify({ identity, owner: scope.owner });
					return structuredClone(scope);
				});
			},
			read: async (id: string) =>
				findIn((await this.store.snapshot(ScopeState))?.scopes, id),
			assertActive: (id: string) =>
				this.store.commit(async (tx) => {
					const scope = await find(tx, id);
					if (!(await tx.ownerActive(scope.owner)))
						throw new ControllerRefusal("scope-unavailable");
					return scope;
				}),
			beginClose: (id: string, revision: number) =>
				this.store.commit(async (tx) => {
					const scope = await find(tx, id);
					if (
						scope.state !== "active" ||
						scope.host !== this.store.host ||
						scope.revision !== revision
					)
						throw new ControllerRefusal("scope-unavailable");
					scope.state = "closing";
					scope.revision++;
					(await tx.doc(ScopeState)).scopes[String(scope.owner)] =
						JSON.stringify(scope);
					return scope;
				}),
		};
	}
}
