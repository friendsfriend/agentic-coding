// TUI server-stack lifecycle state — module-level Solid signals so the shell
// (index.tsx) drives the store and components (Home, otel App, LifecycleModal)
// only read it. One store covers both the startup and shutdown progress flows,
// and it also owns the process-lifetime resource handles: every component of
// the stack (the unified server, workflow application, telemetry
// receivers/collectors, renderer) is acquired through `acquireResource` and
// released in reverse order by `releaseResources`. Nothing infers ownership
// from a listening port, so a partially started stack can only ever stop what
// this process actually acquired.
import { createSignal } from "solid-js";

export type LifecyclePhase = "idle" | "starting" | "running" | "stopping";
export type StepStatus = "pending" | "active" | "done" | "error";

/** One owner, four kinds of owned handle. */
export type OwnedResourceKind =
	| "workflow-server"
	| "workflow-application"
	| "telemetry"
	| "renderer";

export interface OwnedResource {
	kind: OwnedResourceKind;
	/** Human label used in progress/error output. */
	label: string;
	/** Shutdown progress step this handle is released under. */
	step: string;
	/** Release this handle. Bounded by `releaseResources`; must be safe to call
	 * once and never touch a resource this process did not acquire. */
	stop: (timeoutMs?: number) => Promise<void> | void;
}

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

/** Interactive quit with active owned work asks first; the shell renders the
 * prompt while this holds the description of what is still running. */
export const [quitConfirmation, setQuitConfirmation] = createSignal<
	string | undefined
>();

let activeWorkDescription: (() => string | undefined) | undefined;
let activeWorkCancel: (() => void) | undefined;

export function isShutdownRequested(): boolean {
	return shutdownRequested;
}

/** index.tsx registers the real stop sequence (stopServerStack + exit) here. */
export function registerStopSequence(fn: () => Promise<void>): void {
	stopSequence = fn;
}

/**
 * Domain cancellation boundary: the shell asks whether owned work (workflow
 * drains/actions) is still running before quitting, and cancels it through the
 * workflow layer rather than by destroying the process.
 */
export function registerActiveWork(options: {
	describe: () => string | undefined;
	cancel: () => void;
}): void {
	activeWorkDescription = options.describe;
	activeWorkCancel = options.cancel;
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

/** Return the store to its initial idle state without running any stop
 * sequence. Exists for test isolation: bun runs all files in one process, so a
 * shutdown begun by an earlier file would leave phase() === "stopping" and make
 * later files' components swallow every key except 'q'. */
export function resetLifecycle(): void {
	setPhase("idle");
	setSteps([]);
	setMessage("");
	setQuitConfirmation(undefined);
	shutdownRequested = false;
	activeWorkDescription = undefined;
	activeWorkCancel = undefined;
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

// ---- Owned resource handles (startup acquisition, shutdown release) ----

const acquired: OwnedResource[] = [];
let releasing: Promise<void> | undefined;

/** Record an acquired handle. Order is acquisition order; release reverses it. */
export function acquireResource(resource: OwnedResource): void {
	acquired.push(resource);
}

export function resetResources(): void {
	acquired.length = 0;
	releasing = undefined;
}

export function acquiredResources(): readonly OwnedResource[] {
	return acquired;
}

/**
 * Stop every acquired handle, most recent first, exactly once. Idempotent: a
 * repeated call (second `q`, a signal during an interactive quit) returns the
 * same promise instead of stopping anything twice. Handles are grouped by the
 * shutdown step they belong to and each gets its own bounded wait, so one
 * unresponsive child cannot block the rest of teardown.
 */
export function releaseResources(timeoutMs = 2000): Promise<void> {
	if (releasing) return releasing;
	const pending = [...acquired].reverse();
	acquired.length = 0;
	releasing = (async () => {
		let activeStep: string | undefined;
		for (const resource of pending) {
			if (resource.step !== activeStep) {
				if (activeStep) setStepDone(activeStep);
				activeStep = resource.step;
				setStepActive(resource.step);
			}
			try {
				await Promise.race([
					Promise.resolve(resource.stop(timeoutMs)),
					new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
				]);
			} catch {
				/* a failed release must not skip the remaining handles */
			}
		}
		if (activeStep) setStepDone(activeStep);
	})();
	return releasing;
}

/**
 * Single quit entry for the shell (keys + OS signals). Repeated calls are
 * no-ops. An interactive quit with owned workflow work asks for confirmation
 * first; `signal` (SIGINT/SIGTERM/SIGHUP) instead cancels that work through the
 * domain cancellation boundary and proceeds, because a noninteractive shutdown
 * must never wait for an unanswered dialog.
 */
export function requestShutdown(options: { signal?: boolean } = {}): void {
	if (shutdownRequested || quitConfirmation()) return;
	const description = activeWorkDescription?.();
	if (description && !options.signal) {
		setQuitConfirmation(description);
		return;
	}
	if (description) activeWorkCancel?.();
	proceedShutdown();
}

/** Confirmed/cancelled interactive quit prompt. */
export function resolveQuitConfirmation(confirmed: boolean): void {
	if (!quitConfirmation()) return;
	setQuitConfirmation(undefined);
	if (confirmed) {
		activeWorkCancel?.();
		proceedShutdown();
	}
}

function proceedShutdown(): void {
	if (shutdownRequested) return;
	shutdownRequested = true;
	if (phase() !== "stopping") setPhase("stopping");
	const seq = stopSequence;
	if (seq) void seq().catch(() => process.exit(1));
	else process.exit(0);
}
