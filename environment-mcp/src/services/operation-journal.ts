import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import {
	type OperationRecord,
	OperationRefusal,
	operationView,
	type ScopeRecord,
} from "../domain/operation.ts";
import type { SharedService } from "../domain/shared-service.ts";
import {
	type JournalDocument,
	openJournalStore,
} from "../persistence/journal-store.ts";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const key = (values: string[]) => digest(JSON.stringify(values));
const validRequest = (value: string) =>
	typeof value === "string" && value.trim().length > 0 && value.length <= 256;
type DispatchPermit = Readonly<{ id: string; plan: string }>;

function latestOperationTime(document: JournalDocument, scopeId: string) {
	let latest = 0;
	for (const operation of Object.values(document.operations))
		if (operation.scope === scopeId)
			latest = Math.max(latest, operation.createdAt);
	return latest;
}

function removeScope(document: JournalDocument, scopeId: string) {
	const operationIds = new Set(
		Object.values(document.operations)
			.filter((operation) => operation.scope === scopeId)
			.map((operation) => operation.id),
	);
	for (const [id, operation] of Object.entries(document.operations))
		if (operation.scope === scopeId) delete document.operations[id];
	for (const [request, entry] of Object.entries(document.scopeRequests))
		if (entry.scope === scopeId) delete document.scopeRequests[request];
	for (const [request, id] of Object.entries(document.operationRequests))
		if (operationIds.has(id)) delete document.operationRequests[request];
	for (const [request, entry] of Object.entries(document.decisions))
		if (entry.operation.scope === scopeId) delete document.decisions[request];
	for (const [request, entry] of Object.entries(document.acknowledgements))
		if (entry.operation.scope === scopeId)
			delete document.acknowledgements[request];
	delete document.scopes[scopeId];
}

/** Capacity pressure may discard only the oldest inactive scope with no owned
 * resources, no live review/issuance and no inspection-required uncertainty.
 * Active history is never silently deleted. */
function pruneForCapacity(document: JournalDocument) {
	const candidates = Object.keys(document.scopes)
		.filter((scopeId) => {
			const scope = document.scopes[scopeId];
			if (!scope || scope.state === "active" || scope.state === "closing")
				return false;
			if (
				Object.values(document.owned).some((owned) => owned.scope === scopeId)
			)
				return false;
			return !Object.values(document.operations).some(
				(operation) =>
					operation.scope === scopeId &&
					(operation.inspectionRequired ||
						["awaiting-approval", "approved", "issued"].includes(
							operation.state,
						)),
			);
		})
		.sort(
			(a, b) =>
				latestOperationTime(document, a) - latestOperationTime(document, b),
		);
	const victim = candidates[0];
	if (!victim) throw new OperationRefusal("journal-capacity");
	removeScope(document, victim);
}

function workspaceMatches(scope: ScopeRecord) {
	try {
		const current = fs.lstatSync(scope.workspace.directory);
		return (
			current.isDirectory() &&
			fs.realpathSync(scope.workspace.directory) ===
				scope.workspace.directory &&
			String(current.dev) === scope.workspace.device &&
			String(current.ino) === scope.workspace.inode
		);
	} catch {
		return false;
	}
}

/** Internal journal boundary, not a credential authenticator or MCP tool. */
export function openOperationJournal(
	directory: string,
	configuredRepositories: readonly string[],
) {
	const repositories = configuredRepositories.map((repository) =>
		fs.realpathSync(repository),
	);
	const store = openJournalStore(directory, repositories);
	const host = randomUUID();
	const permits = new WeakMap<
		DispatchPermit,
		{ revision: number; digest: string }
	>();
	try {
		store.transaction((document) => {
			for (const scope of Object.values(document.scopes))
				if (scope.state === "active") {
					scope.state = "interrupted";
					scope.revision++;
				}
			for (const operation of Object.values(document.operations)) {
				if (
					["awaiting-approval", "approved", "issued"].includes(operation.state)
				) {
					operation.inspectionRequired = operation.state === "issued";
					operation.state = "interrupted";
					operation.revision++;
				}
			}
			for (const service of Object.values(document.sharedServices)) {
				service.state = "uncertain";
				service.leases = [];
			}
		});
	} catch (error) {
		store.close();
		throw error;
	}
	const readScope = (
		document: JournalDocument,
		id: string,
		principal: string,
		active = false,
	) => {
		const scope = document.scopes[id];
		if (
			!scope ||
			scope.principal !== principal ||
			(active &&
				(scope.state !== "active" ||
					scope.host !== host ||
					!workspaceMatches(scope)))
		)
			throw new OperationRefusal("scope-unavailable");
		return scope;
	};
	const readOperation = (
		document: JournalDocument,
		id: string,
		scope: string,
	) => {
		const operation = document.operations[id];
		if (
			!operation ||
			operation.scope !== scope ||
			digest(operation.plan) !== operation.digest
		)
			throw new OperationRefusal("operation-unavailable");
		return operation;
	};
	return {
		host,
		close: () => store.close(),
		operationScope(id: string) {
			if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
			return store.read().operations[id]?.scope;
		},
		scopeHasOpenWork(scopeId: string) {
			return Object.values(store.read().operations).some(
				(operation) =>
					operation.scope === scopeId &&
					(operation.inspectionRequired ||
						["awaiting-approval", "approved", "issued"].includes(
							operation.state,
						)),
			);
		},
		confirmSharedRelease(service: string, containers: readonly string[]) {
			return store.transaction((document) => {
				const record = document.sharedServices[service];
				if (record?.state !== "ready" || record.leases.length > 0)
					throw new OperationRefusal("cleanup-unavailable");
				const confirmed = new Set(containers);
				for (const [id, owned] of Object.entries(document.owned))
					if (
						owned.operation === record.operation &&
						confirmed.has(owned.runtimeId)
					)
						delete document.owned[id];
				record.containers = record.containers.filter(
					(id) => !confirmed.has(id),
				);
				record.state =
					record.containers.length === 0 ? "released" : "uncertain";
				return record;
			});
		},
		createScope(principal: string, repository: string, requestId: string) {
			if (
				!validRequest(principal) ||
				principal !== principal.trim() ||
				!validRequest(requestId) ||
				!repositories.includes(repository)
			)
				throw new OperationRefusal("scope-unavailable");
			const identity = JSON.stringify({ principal, repository }),
				request = key([principal, requestId]);
			return store.transaction((document) => {
				const previous = document.scopeRequests[request];
				if (previous) {
					if (previous.identity !== identity)
						throw new OperationRefusal("request-conflict");
					return readScope(document, previous.scope, principal);
				}
				if (Object.keys(document.scopes).length >= 64)
					pruneForCapacity(document);
				const stat = fs.lstatSync(repository);
				if (!stat.isDirectory() || fs.realpathSync(repository) !== repository)
					throw new OperationRefusal("scope-unavailable");
				const scope: ScopeRecord = {
					id: randomUUID(),
					principal,
					host,
					workspace: {
						directory: repository,
						device: String(stat.dev),
						inode: String(stat.ino),
					},
					state: "active",
					revision: 1,
				};
				document.scopes[scope.id] = scope;
				document.scopeRequests[request] = { identity, scope: scope.id };
				return scope;
			});
		},
		bind(principal: string, scopeId: string) {
			return {
				scope: (active = false) =>
					readScope(store.read(), scopeId, principal, active),
				read(id: string) {
					const document = store.read();
					readScope(document, scopeId, principal);
					return readOperation(document, id, scopeId);
				},
				history(offset = 0, limit = 20) {
					if (
						!Number.isSafeInteger(offset) ||
						offset < 0 ||
						!Number.isSafeInteger(limit) ||
						limit < 1 ||
						limit > 20
					)
						throw new OperationRefusal("operation-unavailable");
					const document = store.read();
					readScope(document, scopeId, principal);
					const operations = Object.values(document.operations)
						.filter((operation) => operation.scope === scopeId)
						.sort((a, b) => b.createdAt - a.createdAt);
					return {
						operations: operations
							.slice(offset, offset + limit)
							.map((operation) => {
								const { result, ...view } = operationView(operation, host);
								return { ...view, hasResult: result !== undefined };
							}),
						total: operations.length,
						nextOffset:
							offset + limit < operations.length ? offset + limit : null,
					};
				},
				find(requestId: string, identity: string) {
					if (!validRequest(requestId))
						throw new OperationRefusal("operation-unavailable");
					const document = store.read();
					readScope(document, scopeId, principal);
					const id =
						document.operationRequests[key([principal, scopeId, requestId])];
					if (!id) return undefined;
					const operation = readOperation(document, id, scopeId);
					if (operation.identity !== identity)
						throw new OperationRefusal("request-conflict");
					return operation;
				},
				admit(
					requestId: string,
					identity: string,
					plan: string,
					kind: OperationRecord["kind"] = "dependency-bindings",
				) {
					if (
						!validRequest(requestId) ||
						Buffer.byteLength(plan) > 128 * 1024 ||
						identity.length > 1024
					)
						throw new OperationRefusal("operation-unavailable");
					return store.transaction((document) => {
						const scope = readScope(document, scopeId, principal);
						const request = key([principal, scopeId, requestId]),
							previous = document.operationRequests[request];
						if (previous) {
							const operation = readOperation(document, previous, scopeId);
							if (operation.identity !== identity)
								throw new OperationRefusal("request-conflict");
							return operation;
						}
						readScope(document, scopeId, principal, true);
						const frozen = JSON.parse(plan) as {
							kind?: string;
							scope?: string;
							principal?: string;
							workspace?: unknown;
						};
						if (
							frozen.kind !== kind ||
							frozen.scope !== scope.id ||
							frozen.principal !== principal ||
							JSON.stringify(frozen.workspace) !==
								JSON.stringify(scope.workspace)
						)
							throw new OperationRefusal("operation-unavailable");
						if (Object.keys(document.operations).length >= 128)
							throw new OperationRefusal("journal-capacity");
						const operation: OperationRecord = {
							id: randomUUID(),
							scope: scopeId,
							host,
							kind,
							identity,
							plan,
							digest: digest(plan),
							state: "approved",
							revision: 1,
							createdAt: Date.now(),
							inspectionRequired: false,
						};
						document.operations[operation.id] = operation;
						document.operationRequests[request] = operation.id;
						return operation;
					});
				},
				issue(id: string, expected: { digest: string; revision: number }) {
					const issued = store.transaction((document) => {
						readScope(document, scopeId, principal, true);
						const operation = readOperation(document, id, scopeId);
						if (
							operation.host !== host ||
							operation.state !== "approved" ||
							operation.digest !== expected.digest ||
							operation.revision !== expected.revision
						)
							throw new OperationRefusal("operation-unavailable");
						operation.state = "issued";
						operation.revision++;
						return operation;
					});
					const permit = Object.freeze({ id, plan: issued.plan });
					permits.set(permit, {
						revision: issued.revision,
						digest: issued.digest,
					});
					return { operation: issued, permit };
				},
				complete(permit: DispatchPermit, result: string, interrupted = false) {
					const expected = permits.get(permit);
					if (!expected || Buffer.byteLength(result) > 32768)
						throw new OperationRefusal("operation-unavailable");
					const completed = store.transaction((document) => {
						readScope(document, scopeId, principal);
						const operation = readOperation(document, permit.id, scopeId);
						if (
							operation.host !== host ||
							operation.state !== "issued" ||
							operation.revision !== expected.revision ||
							operation.digest !== expected.digest ||
							operation.plan !== permit.plan
						)
							throw new OperationRefusal("operation-unavailable");
						operation.state = interrupted ? "interrupted" : "completed";
						operation.revision++;
						operation.result = result;
						operation.inspectionRequired = interrupted;
						return operation;
					});
					permits.delete(permit);
					return completed;
				},
				sharedServices() {
					return Object.values(store.read().sharedServices);
				},
				sharedService(service: string) {
					return store.read().sharedServices[service];
				},
				installSharedService(
					permit: DispatchPermit,
					service: string,
					containers: string[],
					socket: string,
					provider: "docker" | "podman",
				) {
					const expected = permits.get(permit);
					if (!expected || containers.length > 32 || !containers.length)
						throw new OperationRefusal("operation-unavailable");
					return store.transaction((document) => {
						readScope(document, scopeId, principal, true);
						const operation = readOperation(document, permit.id, scopeId);
						if (
							operation.host !== host ||
							operation.state !== "issued" ||
							operation.revision !== expected.revision ||
							operation.digest !== expected.digest ||
							operation.plan !== permit.plan
						)
							throw new OperationRefusal("operation-unavailable");
						const current = document.sharedServices[service];
						if (current && current.state !== "released") return current;
						const record: SharedService = {
							service,
							state: "ready",
							operation: permit.id,
							scope: scopeId,
							containers: [...new Set(containers)],
							socket,
							provider,
							startedAt: Date.now(),
							leases: [],
						};
						document.sharedServices[service] = record;
						return record;
					});
				},
				acquireSharedLeases(
					services: readonly string[],
					app: string,
					target: string,
				) {
					return store.transaction((document) => {
						readScope(document, scopeId, principal, true);
						const acquired: string[] = [];
						for (const service of [...new Set(services)]) {
							const record = document.sharedServices[service];
							if (!record) continue;
							if (record.state !== "ready")
								throw new OperationRefusal("operation-unavailable");
							if (
								record.leases.some(
									(lease) => lease.scope === scopeId && lease.app === app,
								)
							) {
								acquired.push(service);
								continue;
							}
							if (record.leases.length >= 256)
								throw new OperationRefusal("journal-capacity");
							record.leases.push({
								scope: scopeId,
								app,
								target,
								acquiredAt: Date.now(),
							});
							acquired.push(service);
						}
						return acquired;
					});
				},
				releaseSharedLeases(app: string, services?: readonly string[]) {
					return store.transaction((document) => {
						const selected = services ? new Set(services) : undefined;
						const released: SharedService[] = [];
						for (const record of Object.values(document.sharedServices)) {
							if (selected && !selected.has(record.service)) continue;
							const before = record.leases.length;
							record.leases = record.leases.filter(
								(lease) => !(lease.scope === scopeId && lease.app === app),
							);
							if (
								record.leases.length < before &&
								record.leases.length === 0 &&
								record.state === "ready"
							)
								released.push(structuredClone(record));
						}
						return released;
					});
				},
				confirmSharedRelease(service: string, containers: readonly string[]) {
					return store.transaction((document) => {
						const record = document.sharedServices[service];
						if (record?.state !== "ready" || record.leases.length > 0)
							throw new OperationRefusal("cleanup-unavailable");
						const confirmed = new Set(containers);
						for (const [id, owned] of Object.entries(document.owned))
							if (
								owned.operation === record.operation &&
								confirmed.has(owned.runtimeId)
							)
								delete document.owned[id];
						record.containers = record.containers.filter(
							(id) => !confirmed.has(id),
						);
						record.state =
							record.containers.length === 0 ? "released" : "uncertain";
						return record;
					});
				},
				sharedServiceOwners(operationIds: readonly string[]) {
					const ids = new Set(operationIds);
					return Object.values(store.read().sharedServices).filter((record) =>
						ids.has(record.operation),
					);
				},
				releaseSharedService(operation: string) {
					return store.transaction((document) => {
						for (const record of Object.values(document.sharedServices))
							if (record.operation === operation && record.leases.length === 0)
								record.state = "released";
					});
				},
				claimOwned(
					permit: DispatchPermit,
					app: string,
					resources: readonly {
						kind:
							| "container"
							| "image"
							| "process"
							| "helm-release"
							| "network";
						runtimeId: string;
					}[],
				) {
					const expected = permits.get(permit);
					if (!expected || resources.length > 32)
						throw new OperationRefusal("operation-unavailable");
					return store.transaction((document) => {
						readScope(document, scopeId, principal, true);
						const operation = readOperation(document, permit.id, scopeId);
						if (
							operation.host !== host ||
							operation.state !== "issued" ||
							operation.revision !== expected.revision ||
							operation.digest !== expected.digest ||
							operation.plan !== permit.plan
						)
							throw new OperationRefusal("operation-unavailable");
						const objects = resources.map((resource) => {
							const owned = {
								id: randomUUID(),
								scope: scopeId,
								operation: permit.id,
								app,
								kind: resource.kind,
								runtimeId: resource.runtimeId,
								createdAt: Date.now(),
							};
							document.owned[owned.id] = owned;
							return owned;
						});
						if (Object.keys(document.owned).length > 256)
							throw new OperationRefusal("journal-capacity");
						return objects;
					});
				},
				owned() {
					const document = store.read();
					readScope(document, scopeId, principal);
					return Object.values(document.owned).filter(
						(owned) => owned.scope === scopeId,
					);
				},
				/** Per-app stop is not a scope close; it reports only exact created
				 * handles and leaves borrowed observations untouched. */
				releaseOwned(app?: string) {
					const document = store.read();
					readScope(document, scopeId, principal, true);
					return Object.values(document.owned).filter(
						(owned) =>
							owned.scope === scopeId &&
							(app === undefined || owned.app === app),
					);
				},
				confirmReleased(ids: readonly string[]) {
					return store.transaction((document) => {
						readScope(document, scopeId, principal);
						for (const [key, owned] of Object.entries(document.owned))
							if (owned.scope === scopeId && ids.includes(owned.id))
								delete document.owned[key];
						return Object.values(document.owned).filter(
							(owned) => owned.scope === scopeId,
						);
					});
				},
				/** Fence the scope before any cleanup. Borrowed/shared resources are
				 * never part of this list because only created operations may claim. */
				beginClose(revision: number) {
					return store.transaction((document) => {
						const scope = readScope(document, scopeId, principal);
						if (scope.state === "closed" || scope.state === "closing")
							return {
								scope,
								owned: Object.values(document.owned).filter(
									(owned) => owned.scope === scopeId,
								),
							};
						if (
							scope.host !== host ||
							scope.state !== "active" ||
							scope.revision !== revision
						)
							throw new OperationRefusal("scope-unavailable");
						scope.state = "closing";
						scope.revision++;
						for (const operation of Object.values(document.operations))
							if (
								operation.scope === scopeId &&
								["awaiting-approval", "approved"].includes(operation.state)
							) {
								operation.state = "interrupted";
								operation.revision++;
							}
						return {
							scope,
							owned: Object.values(document.owned).filter(
								(owned) => owned.scope === scopeId,
							),
						};
					});
				},
				finishClose(revision: number, cleaned: boolean) {
					return store.transaction((document) => {
						const scope = readScope(document, scopeId, principal);
						if (scope.state === "closed" || scope.state === "interrupted")
							return scope;
						if (scope.state !== "closing" || scope.revision !== revision)
							throw new OperationRefusal("scope-unavailable");
						if (cleaned) {
							for (const owned of Object.values(document.owned))
								if (owned.scope === scopeId) delete document.owned[owned.id];
							for (const service of Object.values(document.sharedServices))
								service.leases = service.leases.filter(
									(lease) => lease.scope !== scopeId,
								);
						}
						scope.state = cleaned ? "closed" : "interrupted";
						scope.revision++;
						return scope;
					});
				},
			};
		},
	};
}

export type OperationJournal = ReturnType<typeof openOperationJournal>;
export type OperationSession = ReturnType<OperationJournal["bind"]>;
export type DependencyUsePermit = DispatchPermit;
