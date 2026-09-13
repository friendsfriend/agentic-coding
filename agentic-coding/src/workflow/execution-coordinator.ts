// Root-owned repository execution coordination (compose-unified-feature-shell,
// task 1.2). The dashboard shell owns one application runtime and one
// execution coordinator per repository for the whole process lifetime; a
// feature view mounting or hiding must not create or dispose them. This module
// is deliberately free of TUI imports: the credential prompt (the only
// presentation concern the in-process drain needs) is injected by the shell
// through `setCredentialPromptProvider`, so the backend-facing coordinator
// never reaches presentation code.
import { WorkflowApplication } from "./application.ts";
import type { CredentialPrompt } from "./credentials.ts";
import {
	CONTINUATION_WAIT_MS,
	drainEffects,
	engine as workflowEngineFactory,
} from "./operations.ts";
import type { WorkflowEngine } from "./runtime.ts";

/** A credential prompt supplied by the owning shell. The default fails open
 * with an empty answer so a headless/CLI caller that never registers a
 * presenter still degrades instead of hanging. */
export type CredentialPromptProvider = () => CredentialPrompt;

const emptyCredentialPrompt: CredentialPrompt = async () => "";
interface CredentialPromptRegistration {
	provider: CredentialPromptProvider;
	disposed: boolean;
}
const emptyCredentialPromptRegistration: CredentialPromptRegistration = {
	provider: () => emptyCredentialPrompt,
	disposed: false,
};
let credentialPromptRegistration = emptyCredentialPromptRegistration;

/**
 * Register the presentation owner of credential prompts. Returns a disposer
 * that restores the previous provider, so a feature can install the modal
 * bridge on mount and release it on unmount without leaking the handler.
 *
 * Disposal is non-LIFO safe: a provider that was superseded before its own
 * disposer ran is marked disposed and never restored later.
 */
export function setCredentialPromptProvider(
	provider: CredentialPromptProvider,
): () => void {
	const previous = credentialPromptRegistration;
	const registration: CredentialPromptRegistration = {
		provider,
		disposed: false,
	};
	credentialPromptRegistration = registration;
	return () => {
		if (registration.disposed) return;
		registration.disposed = true;
		if (credentialPromptRegistration !== registration) return;
		credentialPromptRegistration = previous.disposed
			? emptyCredentialPromptRegistration
			: previous;
	};
}

/** Diagnostics/test accessor for the currently installed provider. */
export function activeCredentialPromptProvider(): CredentialPromptProvider {
	return credentialPromptRegistration.provider;
}

/**
 * Serialize credential prompts across concurrent repository drains: the shell
 * presents through one modal slot, so a second prompt must wait for the first
 * to be answered instead of superseding it with an empty answer
 * (CONCURRENCY-003).
 */
let credentialChain: Promise<unknown> = Promise.resolve();
export function createQueuedCredentialPrompt(): CredentialPrompt {
	return (prompt: string, signal?: AbortSignal) => {
		const run = async (): Promise<string> => {
			// The waiting command may have died before this queued prompt ran; skip
			// it rather than opening a modal for a dead process (CONCURRENCY-102).
			if (signal?.aborted) return "";
			const presenter = credentialPromptRegistration.provider();
			if (!signal) return presenter(prompt);
			return await new Promise<string>((resolve) => {
				let settled = false;
				const finish = (value: string) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				};
				const onAbort = () => finish("");
				signal.addEventListener("abort", onAbort, { once: true });
				void Promise.resolve(presenter(prompt, signal)).then(finish, () =>
					finish(""),
				);
			});
		};
		const result = credentialChain.then(run, run);
		credentialChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
}

/**
 * The shell's one application runtime: all repositories' execution
 * coordinators share this layer, so refresh/action/start/repair never create a
 * fresh runtime per operation. Release it once when the owning shell is
 * disposed via `disposeDashboardApplication`.
 */
export const dashboardApplication = new WorkflowApplication();

export function disposeDashboardApplication(): void {
	dashboardApplication.dispose();
}

/**
 * Serializes workflow execution per repository for the owning application:
 * a request while a drain is in flight is queued rather than dropped, so a
 * second user action is honored after the active pass settles.
 */
class RepositoryExecutionCoordinator {
	private running = false;
	private queued = false;
	private disposed = false;
	private error: string | undefined;
	private readonly workflowErrors = new Map<string, string>();
	private readonly listeners = new Set<(workflowId: string) => void>();
	private readonly settledListeners = new Set<(workflowId: string) => void>();
	/** Every workflow id coalesced into the next drain, in request order. */
	private queuedWorkflowIds: Array<string | undefined> = [];
	/** Ids coalesced while a drain was in flight; carried onto the drain that
	 * actually processes them so they settle after their effects commit. */
	private pendingSettleIds: Array<string | undefined> = [];
	private activeWorkflowId: string | undefined;
	private controller: AbortController | undefined;
	/** One engine per repository, built from the root-owned application layer:
	 * refresh/action/start reuse the same runtime instead of creating a fresh
	 * engine per drain. */
	private readonly workflowEngine: WorkflowEngine;

	constructor(
		private readonly repo: string,
		application: WorkflowApplication,
	) {
		this.workflowEngine = workflowEngineFactory(application);
	}

	request(workflowId?: string): void {
		if (this.disposed) return;
		if (this.running) {
			this.queued = true;
			this.queuedWorkflowIds.push(workflowId);
			return;
		}
		this.running = true;
		// This drain settles the active request plus any ids coalesced while the
		// previous drain was in flight; they must settle after this drain commits
		// their effects, not before it starts (QUAL-001/CONCURRENCY-101).
		const settleIds =
			this.pendingSettleIds.length > 0
				? [...this.pendingSettleIds, workflowId]
				: [workflowId];
		this.pendingSettleIds = [];
		this.activeWorkflowId = workflowId;
		this.workflowErrors.clear();
		this.controller = new AbortController();
		void drainEffects(
			this.workflowEngine,
			this.repo,
			createQueuedCredentialPrompt(),
			20,
			CONTINUATION_WAIT_MS,
			this.controller.signal,
			(workflowId, message) => {
				this.workflowErrors.set(workflowId, message);
				for (const listener of this.listeners) listener(workflowId);
			},
		)
			.then(() => {
				if (!this.disposed) this.error = undefined;
			})
			.catch((error) => {
				this.error = error instanceof Error ? error.message : String(error);
				for (const listener of this.listeners)
					listener(this.activeWorkflowId ?? "");
			})
			.finally(() => {
				this.running = false;
				for (const id of settleIds)
					for (const listener of this.settledListeners) listener(id ?? "");
				if (this.queued && !this.disposed) {
					this.queued = false;
					this.pendingSettleIds = this.queuedWorkflowIds;
					this.queuedWorkflowIds = [];
					this.request(undefined);
				}
			});
	}

	onError(listener: (workflowId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onSettled(listener: (workflowId: string) => void): () => void {
		this.settledListeners.add(listener);
		return () => this.settledListeners.delete(listener);
	}

	lastError(workflowId?: string): string | undefined {
		return (workflowId && this.workflowErrors.get(workflowId)) || this.error;
	}

	dispose(): void {
		this.disposed = true;
		this.controller?.abort();
		this.queued = false;
		this.queuedWorkflowIds = [];
		this.pendingSettleIds = [];
	}
}

const coordinators = new Map<string, RepositoryExecutionCoordinator>();

export function executionCoordinator(
	repo: string,
	application: WorkflowApplication = dashboardApplication,
): RepositoryExecutionCoordinator {
	let coordinator = coordinators.get(repo);
	if (!coordinator) {
		coordinator = new RepositoryExecutionCoordinator(repo, application);
		coordinators.set(repo, coordinator);
	}
	return coordinator;
}

export function disposeExecutionCoordinator(repo: string): void {
	coordinators.get(repo)?.dispose();
	coordinators.delete(repo);
}

/**
 * Root teardown: release every repository coordinator exactly once. A feature
 * hide/show must never call this; only the owning shell's disposal does.
 */
export function disposeAllExecutionCoordinators(): void {
	for (const coordinator of coordinators.values()) coordinator.dispose();
	coordinators.clear();
}

export function requestWorkflowExecution(
	repo: string,
	workflowId?: string,
): void {
	executionCoordinator(repo).request(workflowId);
}

export function onWorkflowExecutionError(
	repo: string,
	listener: (workflowId: string) => void,
): () => void {
	return executionCoordinator(repo).onError(listener);
}

/** Fires after a dashboard-initiated drain settles so the view refreshes even
 * when the change produced no Herdr event (for example a developer-step
 * transition). */
export function onWorkflowExecutionSettled(
	repo: string,
	listener: (workflowId: string) => void,
): () => void {
	return executionCoordinator(repo).onSettled(listener);
}

export function workflowExecutionError(
	repo: string,
	workflowId?: string,
): string | undefined {
	return coordinators.get(repo)?.lastError(workflowId);
}
