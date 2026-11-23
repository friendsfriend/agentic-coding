import type { ServerManifest } from "../configuration/server-manifest.ts";
import { OperationRefusal, type ScopeRecord } from "../domain/operation.ts";
import type { DependencyOperationSession } from "./dependency-operation-service.ts";
import type { ExecutionSession } from "./execution-service.ts";
import type { OperationJournal } from "./operation-journal.ts";

export type RepositoryBinding = {
	repository: string;
	scopeId: string;
	scope: ScopeRecord;
	execution: ExecutionSession;
	operations: DependencyOperationSession;
};

export type RepositoryRuntime = {
	repository: string;
	current: RepositoryBinding;
	retired: RepositoryBinding[];
	active(): RepositoryBinding;
	find(scopeId: string): RepositoryBinding | undefined;
	all(): RepositoryBinding[];
};

/** A repository runtime owns the current scope plus closed scopes retained for
 * operation/history reads. A closed scope is reopened only by an action that
 * needs execution authority, never by observation. */
export function createRepositoryRuntime(options: {
	repository: string;
	create: () => RepositoryBinding;
}): RepositoryRuntime {
	let current = options.create();
	const retired: RepositoryBinding[] = [];
	return {
		repository: options.repository,
		get current() {
			return current;
		},
		retired,
		active() {
			if (current.scope.state === "closed") {
				retired.push(current);
				if (retired.length > 32) retired.shift();
				current = options.create();
			} else if (current.scope.state !== "active")
				throw new OperationRefusal("scope-unavailable");
			return current;
		},
		find(scopeId: string) {
			if (current.scopeId === scopeId) return current;
			return retired.find((binding) => binding.scopeId === scopeId);
		},
		all() {
			return [current, ...retired];
		},
	};
}

/** Close one idle active scope only when it has no owned resources, no live
 * execution and no pending/inspection operation. The next execution action
 * reopens a fresh scope; historical operations remain readable. */
export async function closeIdleRepository(
	runtime: RepositoryRuntime,
	journal: OperationJournal,
) {
	const binding = runtime.current;
	if (binding.scope.state !== "active") return false;
	if (journal.scopeHasOpenWork(binding.scope.id)) return false;
	if (binding.execution.isBusy()) return false;
	if (binding.execution.status().owned.length) return false;
	const begun = binding.execution.closeScope(binding.scope.revision);
	if (begun.owned.length) return false;
	const closed = binding.execution.finishClose(begun.scope.revision, true);
	binding.scope = closed;
	return true;
}

type Intent = { app: string; target: string; repository?: string };

function resolver(
	manifest: ServerManifest,
	journal: OperationJournal,
	runtimes: readonly RepositoryRuntime[],
) {
	const byRepository = new Map(
		runtimes.map((runtime) => [runtime.repository, runtime]),
	);
	const repositoriesFor = (app: string) =>
		runtimes.filter((runtime) =>
			manifest.apps.some(
				(candidate) =>
					candidate.id === app && candidate.repository === runtime.repository,
			),
		);
	const select = (intent: Intent) => {
		if (intent.repository) {
			const runtime = byRepository.get(intent.repository);
			if (!runtime) throw new OperationRefusal("repository-unauthorized");
			return runtime;
		}
		const matches = repositoriesFor(intent.app);
		if (matches.length === 0)
			throw new OperationRefusal("operation-unavailable");
		if (matches.length > 1) throw new OperationRefusal("repository-ambiguous");
		const selected = matches[0];
		if (!selected) throw new OperationRefusal("operation-unavailable");
		return selected;
	};
	const operation = (id: string) => {
		const scope = journal.operationScope(id);
		const runtime = scope
			? runtimes.find((candidate) => candidate.find(scope))
			: undefined;
		const binding = scope ? runtime?.find(scope) : undefined;
		if (!binding) throw new OperationRefusal("operation-unavailable");
		return { runtime, binding };
	};
	return { select, operation };
}

function aggregateHistory(
	bindings: readonly RepositoryBinding[],
	offset: number,
	limit: number,
) {
	const collected: {
		operation: ReturnType<
			RepositoryBinding["operations"]["history"]
		>["operations"][number];
		createdAt: number;
	}[] = [];
	let total = 0;
	for (const binding of bindings) {
		let pageOffset = 0;
		for (;;) {
			const page = binding.operations.history(pageOffset, 20);
			total += pageOffset === 0 ? page.total : 0;
			for (const operation of page.operations)
				collected.push({ operation, createdAt: operation.createdAt });
			if (page.nextOffset === null || collected.length >= offset + limit) break;
			pageOffset = page.nextOffset;
		}
	}
	collected.sort((left, right) => right.createdAt - left.createdAt);
	const selected = collected.slice(offset, offset + limit);
	return {
		operations: selected.map((entry) => entry.operation),
		total,
		nextOffset:
			offset + selected.length < total ? offset + selected.length : null,
	};
}

export function createMultiRepositoryExecutionSession(
	manifest: ServerManifest,
	journal: OperationJournal,
	runtimes: readonly RepositoryRuntime[],
) {
	const { select, operation } = resolver(manifest, journal, runtimes);
	const primary = () => {
		const runtime = runtimes[0];
		if (!runtime) throw new OperationRefusal("operation-unavailable");
		return runtime;
	};
	const history = (offset: number, limit: number, repository?: string) => {
		const selected = repository
			? runtimes.find((runtime) => runtime.repository === repository)
			: undefined;
		if (repository && !selected)
			throw new OperationRefusal("repository-unauthorized");
		const bindings = selected
			? selected.all()
			: runtimes.flatMap((runtime) => runtime.all());
		return aggregateHistory(bindings, offset, limit);
	};
	const session = {
		async admit(requestId: string, rawIntent: unknown, signal: AbortSignal) {
			const intent = rawIntent as Intent;
			const selected = select(intent);
			try {
				return await selected
					.active()
					.execution.admit(requestId, rawIntent, signal);
			} catch (error) {
				console.error("DEBUG idle admit", error);
				throw error;
			}
		},
		read(id: string) {
			return operation(id).binding.execution.read(id);
		},
		history(offset = 0, limit = 20, repository?: string) {
			return history(offset, limit, repository);
		},
		sharedServices() {
			return primary().current.execution.sharedServices();
		},
		sharedService(service: string) {
			return primary().current.execution.sharedService(service);
		},
		isBusy() {
			return runtimes.some((runtime) => runtime.current.execution.isBusy());
		},
		status(repository?: string) {
			if (repository) {
				const runtime = runtimes.find((item) => item.repository === repository);
				if (!runtime) throw new OperationRefusal("repository-unauthorized");
				return runtime.current.execution.status(repository);
			}
			if (runtimes.length === 1) {
				const runtime = runtimes[0];
				if (!runtime) throw new OperationRefusal("operation-unavailable");
				return runtime.current.execution.status();
			}
			const statuses = runtimes.map((runtime) => ({
				repository: runtime.repository,
				...runtime.current.execution.status(),
			}));
			const first = statuses[0];
			if (!first) throw new OperationRefusal("operation-unavailable");
			return {
				scope: first.scope,
				scopes: statuses.map(({ repository, scope, owned }) => ({
					...scope,
					repository,
					owned: owned.length,
				})),
				owned: statuses.flatMap(({ owned }) => owned),
				authority:
					"Observation only; owned resources are partitioned by repository scope and borrowed dependencies are absent. Pass repository to select one scope.",
			};
		},
		async execute(id: string, signal: AbortSignal) {
			return operation(id).binding.execution.execute(id, signal);
		},
		async wait(id: string, waitSec: number, signal: AbortSignal) {
			return operation(id).binding.execution.wait(id, waitSec, signal);
		},
		async stop(app: string, signal: AbortSignal, repository?: string) {
			if (repository) {
				const runtime = runtimes.find((item) => item.repository === repository);
				if (!runtime) throw new OperationRefusal("repository-unauthorized");
				if (runtime.current.scope.state !== "active")
					return { stopped: [], remaining: 0, retainedLogsAvailable: false };
				return runtime.current.execution.stop(app, signal, repository);
			}
			const matches = runtimes.filter(
				(runtime) =>
					runtime.current.scope.state === "active" &&
					runtime.current.execution
						.status()
						.owned.some((item) => item.app === app),
			);
			if (matches.length > 1)
				throw new OperationRefusal("repository-ambiguous");
			const selected = matches[0];
			if (!selected)
				return { stopped: [], remaining: 0, retainedLogsAvailable: false };
			return selected.current.execution.stop(app, signal);
		},
		async logs(
			app: string,
			tail: number,
			signal: AbortSignal,
			grep?: string,
			repository?: string,
		) {
			const selected = repository
				? runtimes.find((runtime) => runtime.repository === repository)
				: undefined;
			if (repository && !selected)
				throw new OperationRefusal("repository-unauthorized");
			const candidates = selected
				? selected.all()
				: runtimes.flatMap((runtime) => runtime.all());
			const owned = candidates.filter((binding) =>
				binding.execution.status().owned.some((item) => item.app === app),
			);
			if (owned.length > 1) throw new OperationRefusal("repository-ambiguous");
			const ordered = owned.length ? owned : candidates;
			let failure: unknown;
			for (const binding of ordered)
				try {
					return await binding.execution.logs(app, tail, signal, grep);
				} catch (error) {
					failure = error;
				}
			throw failure ?? new OperationRefusal("operation-unavailable");
		},
		async telemetry(app: string, traceId?: string, repository?: string) {
			const selected = repository
				? runtimes.find((runtime) => runtime.repository === repository)
				: undefined;
			if (repository && !selected)
				throw new OperationRefusal("repository-unauthorized");
			const values: {
				repository: string;
				value: ReturnType<ExecutionSession["telemetry"]>;
			}[] = [];
			for (const runtime of selected ? [selected] : runtimes) {
				for (const binding of runtime.all())
					try {
						values.push({
							repository: runtime.repository,
							value: binding.execution.telemetry(app, traceId),
						});
						break;
					} catch {
						/* No capture in this scope. */
					}
			}
			if (values.length > 1) throw new OperationRefusal("repository-ambiguous");
			const first = values[0];
			if (!first) throw new OperationRefusal("operation-unavailable");
			return { repository: first.repository, ...first.value };
		},
		async shutdown() {
			const bindings = new Set(runtimes.flatMap((runtime) => runtime.all()));
			await Promise.allSettled(
				[...bindings].map((binding) => binding.execution.shutdown()),
			);
		},
		closeScope(revision: number) {
			return primary().current.execution.closeScope(revision);
		},
		finishClose(revision: number, cleaned: boolean) {
			return primary().current.execution.finishClose(revision, cleaned);
		},
	};
	return session as unknown as ExecutionSession;
}

export function createMultiRepositoryOperationSession(
	manifest: ServerManifest,
	journal: OperationJournal,
	runtimes: readonly RepositoryRuntime[],
) {
	const { select, operation } = resolver(manifest, journal, runtimes);
	const primary = () => {
		const runtime = runtimes[0];
		if (!runtime) throw new OperationRefusal("operation-unavailable");
		return runtime;
	};
	const history = (offset: number, limit: number, repository?: string) => {
		const selected = repository
			? runtimes.find((runtime) => runtime.repository === repository)
			: undefined;
		if (repository && !selected)
			throw new OperationRefusal("repository-unauthorized");
		const bindings = selected
			? selected.all()
			: runtimes.flatMap((runtime) => runtime.all());
		return aggregateHistory(bindings, offset, limit);
	};
	const session = {
		async admit(requestId: string, rawIntent: unknown, signal: AbortSignal) {
			const intent = rawIntent as Intent;
			const selected = select(intent);
			return selected.active().operations.admit(requestId, rawIntent, signal);
		},
		read(id: string) {
			return operation(id).binding.operations.read(id);
		},
		history(offset = 0, limit = 20, repository?: string) {
			return history(offset, limit, repository);
		},
		sharedServices() {
			return primary().current.operations.sharedServices();
		},
		sharedService(service: string) {
			return primary().current.operations.sharedService(service);
		},
		async issue(id: string, signal: AbortSignal) {
			return operation(id).binding.operations.issue(id, signal);
		},
		async complete(
			...args: Parameters<DependencyOperationSession["complete"]>
		) {
			const permit = args[0];
			return operation(permit.id).binding.operations.complete(...args);
		},
		closeScope(revision: number) {
			return primary().current.operations.closeScope(revision);
		},
		owned() {
			return primary().current.operations.owned();
		},
	};
	return session as unknown as DependencyOperationSession;
}
