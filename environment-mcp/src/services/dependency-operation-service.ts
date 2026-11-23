import {
	type ServerManifest,
	serverManifestSchema,
} from "../configuration/server-manifest.ts";
import type { ContainerInspectionPort } from "../domain/dependency-binding.ts";
import {
	OperationRefusal,
	operationIntentSchema,
	operationView,
} from "../domain/operation.ts";
import {
	createDependencyBindingService,
	type PreparedDependencyBindings,
} from "./dependency-binding-service.ts";
import type {
	DependencyUsePermit,
	OperationJournal,
} from "./operation-journal.ts";

/** Host composition only. Agents receive the bound methods through an
 * authenticated transport, never an operator object or caller-authored plan. */
export function createDependencyOperationService(
	configuration: ServerManifest,
	journal: OperationJournal,
	containers: ContainerInspectionPort,
) {
	const manifest = serverManifestSchema.parse(configuration);
	const preparations = new Map<
		string,
		{
			scope: string;
			bindings: ReturnType<typeof createDependencyBindingService>;
			prepared: PreparedDependencyBindings;
		}
	>();
	return {
		bind(principal: string, scopeId: string) {
			const session = journal.bind(principal, scopeId);
			const requireRepository = (repository?: string) => {
				if (repository && repository !== session.scope().workspace.directory)
					throw new OperationRefusal("repository-unauthorized");
			};
			return {
				async admit(
					requestId: string,
					rawIntent: unknown,
					signal: AbortSignal,
				) {
					const intent = operationIntentSchema.parse(rawIntent);
					requireRepository(intent.repository);
					const identity = JSON.stringify(intent);
					const previous = session.find(requestId, identity);
					if (previous) return operationView(previous, journal.host);
					const scope = session.scope(true);
					const bindings = createDependencyBindingService(
						manifest,
						scope.workspace.directory,
						containers,
					);
					const prepared = await bindings.prepare(
						intent.app,
						intent.target,
						signal,
					);
					signal.throwIfAborted();
					const plan = JSON.stringify({
						kind: "dependency-bindings",
						scope: scope.id,
						principal,
						workspace: scope.workspace,
						intent,
						dependencyBindings: JSON.parse(prepared.plan),
						authority:
							"Exact review of declared dependency observations only. This is not permission to build, start, stop, attach, query or reconfigure any application/service. Borrowed resources and volumes grant no cleanup ownership. Runtime execution requires a separately reviewed executable plan.",
					});
					const operation = session.admit(requestId, identity, plan);
					if (operation.plan === plan && !preparations.has(operation.id))
						preparations.set(operation.id, {
							scope: scopeId,
							bindings,
							prepared,
						});
					return operationView(operation, journal.host);
				},
				read(id: string) {
					return operationView(session.read(id), journal.host);
				},
				history(offset = 0, limit = 20, repository?: string) {
					requireRepository(repository);
					return session.history(offset, limit);
				},
				sharedServices() {
					return session.sharedServices();
				},
				sharedService(service: string) {
					return session.sharedService(service);
				},
				async issue(id: string, signal: AbortSignal) {
					const operation = session.read(id);
					if (operation.state !== "approved" || operation.host !== journal.host)
						return {
							operation: operationView(operation, journal.host),
							permit: null,
						};
					session.scope(true);
					const original = preparations.get(id);
					if (!original || original.scope !== scopeId)
						throw new OperationRefusal("operation-unavailable");
					await original.bindings.revalidate(original.prepared, signal);
					signal.throwIfAborted();
					const current = session.read(id);
					if (
						current.state !== "approved" ||
						current.revision !== operation.revision
					)
						return {
							operation: operationView(current, journal.host),
							permit: null,
						};
					const issued = session.issue(id, operation);
					return {
						operation: operationView(issued.operation, journal.host),
						permit: issued.permit,
					};
				},
				async complete(
					permit: DependencyUsePermit,
					result: Record<string, unknown>,
					signal: AbortSignal,
				) {
					const operation = session.read(permit.id);
					if (operation.host !== journal.host || operation.state !== "issued")
						throw new OperationRefusal("operation-unavailable");
					const original = preparations.get(permit.id);
					if (!original || original.scope !== scopeId)
						throw new OperationRefusal("operation-unavailable");
					// Validate receipt size before treating any later publication error as
					// uncertain. This records trusted observations, not arbitrary tools.
					const receipt = JSON.stringify(result);
					if (Buffer.byteLength(receipt) > 32768)
						throw new OperationRefusal("operation-unavailable");
					try {
						await original.bindings.revalidate(original.prepared, signal);
						signal.throwIfAborted();
					} catch {
						return operationView(
							session.complete(
								permit,
								JSON.stringify({
									error:
										"Dependency observation changed or became unavailable after issuance; inspect the original operation. No automatic resend or borrowed-resource cleanup is authorized.",
								}),
								true,
							),
							journal.host,
						);
					}
					return operationView(session.complete(permit, receipt), journal.host);
				},
				closeScope(revision: number) {
					const begun = session.beginClose(revision);
					if (begun.scope.state === "closed") return begun;
					// Dependency reviews never create owned resources. A nonempty
					// ledger is a runtime-cleanup responsibility, not a borrowed one.
					if (begun.owned.length) return begun;
					return {
						scope: session.finishClose(begun.scope.revision, true),
						owned: [],
					};
				},
				owned: () => session.owned(),
			};
		},
	};
}

export type DependencyOperationSession = ReturnType<
	ReturnType<typeof createDependencyOperationService>["bind"]
>;
