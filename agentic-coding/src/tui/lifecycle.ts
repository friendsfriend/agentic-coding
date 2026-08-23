// TUI server-stack lifecycle state — module-level Solid signals so the shell
// (index.tsx) drives the store and components (Home, otel App, LifecycleModal)
// only read it. One store covers both the startup and shutdown progress flows.
import { createSignal } from "solid-js";

export type LifecyclePhase = "idle" | "starting" | "running" | "stopping";
export type StepStatus = "pending" | "active" | "done" | "error";

export interface LifecycleStepDef {
	id: string;
	label: string;
}

export interface LifecycleStep extends LifecycleStepDef {
	status: StepStatus;
}

export const [phase, setPhase] = createSignal<LifecyclePhase>("idle");
export const [steps, setSteps] = createSignal<LifecycleStep[]>([]);
export const [message, setMessage] = createSignal("");

let shutdownRequested = false;
let stopSequence: (() => Promise<void>) | undefined;

export function isShutdownRequested(): boolean {
	return shutdownRequested;
}

/** index.tsx registers the real stop sequence (stopServerStack + exit) here. */
export function registerStopSequence(fn: () => Promise<void>): void {
	stopSequence = fn;
}

function inProgress(): boolean {
	return phase() === "starting" || phase() === "stopping";
}

export function beginStartup(defs: LifecycleStepDef[]): void {
	setPhase("starting");
	setSteps(defs.map((def) => ({ ...def, status: "pending" })));
	setMessage("");
}

export function beginShutdown(defs: LifecycleStepDef[]): void {
	setPhase("stopping");
	setSteps(defs.map((def) => ({ ...def, status: "pending" })));
	setMessage("");
}

export function setStepActive(id: string): void {
	if (!inProgress()) return;
	setSteps((list) =>
		list.map((step) => ({
			...step,
			status:
				step.id === id
					? "active"
					: step.status === "active"
						? "done"
						: step.status,
		})),
	);
}

export function setStepDone(id: string): void {
	if (!inProgress()) return;
	setSteps((list) =>
		list.map((step) => (step.id === id ? { ...step, status: "done" } : step)),
	);
}

export function setStepError(id: string, errMessage: string): void {
	if (!inProgress()) return;
	setSteps((list) =>
		list.map((step) => (step.id === id ? { ...step, status: "error" } : step)),
	);
	setMessage(errMessage);
}

export function finishStartup(): void {
	setPhase("running");
	setSteps([]);
	setMessage("");
}

/**
 * Single quit entry for home mode (keys + OS signals). Idempotent: a second
 * call during the stop sequence is a no-op. Runs the registered stop sequence,
 * which stops the server stack, destroys the renderer and exits the process.
 */
export function requestShutdown(): void {
	if (shutdownRequested) return;
	shutdownRequested = true;
	if (phase() !== "stopping") setPhase("stopping");
	const seq = stopSequence;
	if (seq) void seq().catch(() => process.exit(1));
	else process.exit(0);
}
