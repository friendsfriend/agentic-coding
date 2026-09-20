// Contextual workflow launch (launch-workflows-from-project-and-wiki-pages).
//
// The full application creates workflows from the resource page that owns the
// project identity (application/library) or from Wiki for repository-independent
// research. This module holds the two things every launch path shares: the
// immutable launch context that decides the target, and the classification of a
// start result into "rejected", "accepted" or "uncertain" so the UI can tell a
// refused start apart from a workflow that was durably accepted and then failed
// its Herdr handoff — without ever submitting a second workflow.
import { existsSync } from "node:fs";
import { BackendClientError } from "../../server/client.ts";
import { gatewayOrUndefined } from "../data/index.ts";
import { startWorkflow } from "../data/workflow.ts";
import {
	onWorkflowExecutionError,
	serverOwnsExecutionEvents,
	workflowExecutionError,
} from "./live.ts";

/**
 * Immutable launch context of the creation form. It replaces the former
 * repository/custom-path/standalone selectors: the target is decided by where
 * the user started, never by a second choice inside the form.
 */
export type WorkflowLaunchContext =
	/** Configured application/library: canonical identity already selected. */
	| {
			kind: "project";
			/** Stable configured project identity (environment `app.ident`). */
			ident: string;
			/** Display name shown in the form summary. */
			name: string;
			/** Canonical repository root the backend revalidates at submission. */
			repository: string;
	  }
	/** Wiki: repository-independent research/wiki work. */
	| { kind: "independent" };

export interface WorkflowLaunchInput {
	repo: string;
	ticket: string;
	workflowId: string;
	task?: string;
	mode: string;
	workflowType: string;
	preset: string;
}

export type LaunchOutcome =
	/** Durably accepted: `workflowId` exists and owns its Herdr workspace. */
	| { kind: "accepted"; workflowId: string; message: string }
	/** Refused before anything was created; safe to correct and resubmit. */
	| { kind: "rejected"; message: string }
	/** Transport failed; acceptance is unknown, so the user reconciles instead
	 * of resubmitting and risking a duplicate workflow. */
	| { kind: "uncertain"; message: string };

const STARTED = /^Workflow started:\s*(\S+)\s*$/;

/** Workflow types a launch context may offer. Repository-bound research and
 * wiki work belongs on the resource page; an independent Wiki launch offers
 * repository-independent research only. `wiki` itself is repository-backed
 * (it edits a checkout), so it is not an independent target. */
export function workflowTypesForContext(
	context: WorkflowLaunchContext,
): string[] | undefined {
	return context.kind === "independent" ? ["research"] : undefined;
}

/**
 * Why this context cannot start repository work at all, or `undefined` when it
 * can. A removed or unreadable project blocks new repository work with an
 * actionable error; there is no scan, clone or retarget fallback, and existing
 * workflows keep their pinned locations.
 */
export function launchContextError(
	context: WorkflowLaunchContext,
): string | undefined {
	if (context.kind === "independent") return undefined;
	if (!context.repository?.trim())
		return `Project ${context.name} has no repository path; configure the application or library before starting work`;
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Start a workflow through the existing typed start boundary and classify the
 * result. An in-process start throws only before durable acceptance, so every
 * thrown error there is a rejection; over the transport a 4xx is a rejection
 * while a 5xx, a network failure or an aborted request means acceptance is
 * unknown.
 */
export async function launchWorkflow(
	input: WorkflowLaunchInput,
): Promise<LaunchOutcome> {
	try {
		const message = await startWorkflow({
			repo: input.repo,
			workflowId: input.workflowId,
			mode: input.mode,
			...(input.ticket ? { ticket: input.ticket } : {}),
			...(input.task ? { task: input.task } : {}),
			...(input.workflowType ? { workflowType: input.workflowType } : {}),
			...(input.preset ? { preset: input.preset } : {}),
		});
		const workflowId = STARTED.exec(message)?.[1];
		if (workflowId) return { kind: "accepted", workflowId, message };
		// A start boundary that answered without naming the workflow cannot be
		// reconciled here, so treat it as unknown rather than as success.
		return { kind: "uncertain", message };
	} catch (error) {
		const message = errorMessage(error);
		// Over the transport a 4xx is the backend refusing the request; a 5xx or a
		// network failure leaves acceptance unknown. An in-process start throws
		// only before durable acceptance.
		if (error instanceof BackendClientError)
			return error.status < 500
				? { kind: "rejected", message }
				: { kind: "uncertain", message };
		return serverOwnsExecutionEvents()
			? { kind: "uncertain", message }
			: { kind: "rejected", message };
	}
}

/** Whether the repository this context names is still readable. */
export function launchRepositoryAvailable(
	context: WorkflowLaunchContext,
): boolean {
	if (context.kind === "independent") return true;
	try {
		return existsSync(context.repository);
	} catch {
		return false;
	}
}

/**
 * Bounded post-acceptance handoff watch. A workflow that was durably accepted
 * and then failed its Herdr handoff is reported once, by identity, so the user
 * sees "accepted, handoff failed" instead of a start error — and never a
 * second workflow. The watch reports the first terminal attention state and
 * then stops.
 *
 * ponytail: the remote-attach branch reports on the next `workflow.updated` for
 * the repository; a push-based handoff-failure event would remove that delay.
 */
export function watchAcceptedHandoff(
	repo: string,
	workflowId: string,
	onFailure: (message: string) => void,
): () => void {
	const gateway = gatewayOrUndefined();
	if (!gateway) {
		// Managed/test route: the execution coordinator lives in this process.
		return onWorkflowExecutionError(repo, (failedId) => {
			if (failedId !== workflowId) return;
			onFailure(
				workflowExecutionError(repo, workflowId) ??
					"the workflow handoff failed",
			);
		});
	}
	let done = false;
	const subscription = gateway.subscribe({
		onEvent: (event) => {
			if (done) return;
			if (event.resource !== repo || event.runId !== workflowId) return;
			void gateway
				.view(repo, workflowId)
				.then((view) => {
					if (done || view.status !== "attention-required") return;
					done = true;
					onFailure(
						view.currentStep?.label
							? `attention required at ${view.currentStep.label}`
							: "the workflow needs attention",
					);
				})
				.catch(() => {});
		},
		onResync: () => {},
	});
	return () => {
		done = true;
		subscription();
	};
}
