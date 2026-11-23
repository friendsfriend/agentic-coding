import { randomUUID } from "node:crypto";
import type {
	OperatorApi,
	OperatorOperation,
	OperatorOperationSummary,
} from "./client.ts";

export type OperatorUiView =
	| "loading"
	| "list"
	| "detail"
	| "confirm"
	| "running"
	| "result"
	| "error";
export type OperatorUiSnapshot = {
	view: OperatorUiView;
	operations: readonly OperatorOperationSummary[];
	selectedIndex: number;
	operation?: OperatorOperation;
	decision?: "approved" | "rejected" | "acknowledged";
	message?: string;
};
export type OperatorUiController = {
	getSnapshot(): OperatorUiSnapshot;
	subscribe(listener: () => void): () => void;
	load(): Promise<void>;
	moveSelection(delta: number): void;
	select(index: number): void;
	inspectSelected(): Promise<void>;
	requestDecision(decision: "approved" | "rejected"): void;
	cancelConfirmation(): void;
	confirmDecision(): Promise<void>;
	acknowledge(): Promise<void>;
	back(): void;
};

/** Human-only controller over the operator API. It is intentionally separate
 * from the agent capability controller and has no MCP registration path. */
export function createOperatorUiController(
	api: OperatorApi,
): OperatorUiController {
	let operations: readonly OperatorOperationSummary[] = [];
	let selectedIndex = 0;
	let operation: OperatorOperation | undefined;
	let decision: "approved" | "rejected" | "acknowledged" | undefined;
	let view: OperatorUiView = "loading";
	let message: string | undefined;
	let generation = 0;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const snapshot = (): OperatorUiSnapshot => ({
		view,
		operations,
		selectedIndex,
		operation,
		decision,
		message,
	});
	const fail = (code: string) => {
		view = "error";
		message = code;
	};
	const runDecision = async (next: "approved" | "rejected") => {
		if (!operation) return;
		const current = operation;
		view = "running";
		message = undefined;
		notify();
		try {
			operation = await api.decide(current.id, {
				requestId: randomUUID(),
				digest: current.digest,
				revision: current.revision,
				decision: next,
			});
			decision = next;
			view = "result";
		} catch (error) {
			fail(error instanceof Error ? error.message : "decision-failed");
		}
		notify();
	};
	return {
		getSnapshot: snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async load() {
			const currentGeneration = ++generation;
			view = "loading";
			message = undefined;
			notify();
			try {
				const result = await api.list(0, 20);
				if (currentGeneration !== generation) return;
				operations = result.operations;
				selectedIndex = Math.min(
					selectedIndex,
					Math.max(0, operations.length - 1),
				);
				view = "list";
				message = operations.length
					? undefined
					: "No operator operations available";
			} catch (error) {
				if (currentGeneration !== generation) return;
				fail(
					error instanceof Error && error.message
						? error.message
						: "operator-list-failed",
				);
			}
			notify();
		},
		moveSelection(delta) {
			if (view !== "list" || !operations.length) return;
			selectedIndex =
				(selectedIndex + delta + operations.length) % operations.length;
			notify();
		},
		select(index) {
			if (view !== "list" || !operations.length) return;
			if (!Number.isInteger(index) || index < 0 || index >= operations.length)
				return;
			selectedIndex = index;
		},
		async inspectSelected() {
			if (view !== "list") return;
			const selected = operations[selectedIndex];
			if (!selected) return;
			view = "running";
			message = "Loading exact plan…";
			notify();
			try {
				operation = await api.inspect(selected.id);
				view = "detail";
				message = undefined;
			} catch (error) {
				fail(
					error instanceof Error && error.message
						? error.message
						: "operator-inspect-failed",
				);
			}
			notify();
		},
		requestDecision(next) {
			if (view !== "detail" || !operation) return;
			if (operation.state !== "awaiting-approval") return;
			decision = next;
			view = "confirm";
			message =
				next === "approved"
					? "Approve this exact plan?"
					: "Reject this exact plan?";
			notify();
		},
		cancelConfirmation() {
			if (view !== "confirm" || !operation) return;
			decision = undefined;
			view = "detail";
			message = undefined;
			notify();
		},
		async confirmDecision() {
			if (view !== "confirm" || !decision) return;
			if (decision === "acknowledged") return;
			await runDecision(decision);
		},
		async acknowledge() {
			if (view !== "detail" || !operation) return;
			if (operation.state !== "interrupted" || !operation.inspectionRequired)
				return;
			const current = operation;
			view = "running";
			message = undefined;
			notify();
			try {
				operation = await api.acknowledge(current.id, {
					requestId: randomUUID(),
					digest: current.digest,
					revision: current.revision,
				});
				decision = "acknowledged";
				view = "result";
			} catch (error) {
				fail(error instanceof Error ? error.message : "acknowledgement-failed");
			}
			notify();
		},
		back() {
			if (view === "running") return;
			if (["detail", "confirm", "result", "error"].includes(view)) {
				view = "list";
				operation = undefined;
				decision = undefined;
				message = undefined;
				notify();
			}
		},
	};
}
