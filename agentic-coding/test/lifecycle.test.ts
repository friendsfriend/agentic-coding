import { expect, test } from "bun:test";
import { stopOwnedStack } from "../src/tui/index";
import {
	acquiredResources,
	acquireResource,
	beginShutdown,
	beginStartup,
	finishStartup,
	isShutdownRequested,
	message,
	type OwnedResource,
	phase,
	quitConfirmation,
	registerActiveWork,
	registerStopSequence,
	releaseResources,
	requestShutdown,
	resetLifecycle,
	resetResources,
	resolveQuitConfirmation,
	setStepActive,
	setStepDone,
	setStepError,
	steps,
} from "../src/tui/lifecycle";

function resource(
	kind: OwnedResource["kind"],
	step: string,
	stop: OwnedResource["stop"],
): OwnedResource {
	return { kind, label: kind, step, stop };
}

test("lifecycle steps transition through statuses", () => {
	beginStartup([
		{ id: "a", label: "A" },
		{ id: "b", label: "B" },
	]);
	expect(phase()).toBe("starting");
	expect(steps().map((s) => s.status)).toEqual(["pending", "pending"]);

	setStepActive("a");
	expect(steps().map((s) => s.status)).toEqual(["active", "pending"]);
	setStepDone("a");
	setStepActive("b");
	expect(steps().map((s) => s.status)).toEqual(["done", "active"]);

	setStepError("b", "boom");
	expect(steps().map((s) => s.status)).toEqual(["done", "error"]);
	expect(message()).toBe("boom");

	finishStartup();
	expect(phase()).toBe("running");
	expect(steps()).toEqual([]);
	// Helpers are no-ops outside starting/stopping.
	setStepActive("a");
	setStepDone("a");
	expect(steps()).toEqual([]);

	beginShutdown([{ id: "s", label: "Stop" }]);
	expect(phase()).toBe("stopping");
	expect(steps().map((s) => s.status)).toEqual(["pending"]);
});

test("releaseResources stops acquired handles in reverse order, once", async () => {
	resetLifecycle();
	resetResources();
	const order: string[] = [];
	const push = (name: string) => () => {
		order.push(name);
	};
	acquireResource(resource("renderer", "renderer", push("renderer")));
	acquireResource(resource("telemetry", "db", push("db")));
	acquireResource(resource("go-backend", "go-backend", push("backend")));
	acquireResource(resource("telemetry", "telemetry", push("receiver")));
	beginShutdown([
		{ id: "go-backend", label: "backend" },
		{ id: "telemetry", label: "telemetry" },
		{ id: "db", label: "db" },
		{ id: "renderer", label: "renderer" },
	]);

	await releaseResources();
	await releaseResources();
	expect(order).toEqual(["receiver", "backend", "db", "renderer"]);
	expect(acquiredResources()).toHaveLength(0);
	expect(steps().every((step) => step.status === "done")).toBe(true);
});

test("a failing handle does not skip the remaining releases", async () => {
	resetLifecycle();
	resetResources();
	const stopped: string[] = [];
	acquireResource(
		resource("renderer", "renderer", () => {
			stopped.push("renderer");
		}),
	);
	acquireResource(
		resource("go-backend", "go-backend", () => {
			throw new Error("child already gone");
		}),
	);
	acquireResource(
		resource("telemetry", "telemetry", () => {
			stopped.push("receiver");
		}),
	);
	beginShutdown([{ id: "telemetry", label: "telemetry" }]);
	await releaseResources();
	expect(stopped).toEqual(["receiver", "renderer"]);
});

test("stopOwnedStack releases only acquired handles and exits once", async () => {
	resetLifecycle();
	resetResources();
	const stopped: string[] = [];
	// Attach/per-workflow shape: a client with no owned backend or receiver.
	acquireResource(
		resource("renderer", "renderer", () => {
			stopped.push("renderer");
		}),
	);
	let exitCode: number | undefined;
	await stopOwnedStack((code) => {
		exitCode = code;
	});
	expect(stopped).toEqual(["renderer"]);
	expect(exitCode).toBe(0);
	// Only the owned renderer gets a progress row: no go-backend/telemetry row
	// is claimed for a stack this process never acquired.
	expect(steps().map((step) => step.id)).toEqual(["renderer"]);
	resetLifecycle();
	resetResources();
});

test("requestShutdown asks before cancelling active work, signals do not wait", () => {
	resetLifecycle();
	resetResources();
	finishStartup();
	let cancelled = 0;
	registerActiveWork({
		describe: () => "A workflow action is still running.",
		cancel: () => {
			cancelled += 1;
		},
	});
	requestShutdown();
	expect(quitConfirmation()).toBe("A workflow action is still running.");
	expect(cancelled).toBe(0);

	// Declining returns to the shell with nothing stopped.
	resolveQuitConfirmation(false);
	expect(quitConfirmation()).toBeUndefined();
	expect(cancelled).toBe(0);

	// A signal never waits for the unanswered dialog: it cancels and proceeds.
	let stopCalls = 0;
	registerStopSequence(async () => {
		stopCalls += 1;
	});
	requestShutdown({ signal: true });
	expect(cancelled).toBe(1);
	expect(quitConfirmation()).toBeUndefined();
	expect(stopCalls).toBe(1);
	expect(isShutdownRequested()).toBe(true);
	resetLifecycle();
	resetResources();
});

test("requestShutdown is idempotent and runs the registered stop sequence", async () => {
	finishStartup();
	let calls = 0;
	registerStopSequence(async () => {
		calls += 1;
	});
	requestShutdown();
	requestShutdown();
	expect(calls).toBe(1);
	expect(phase()).toBe("stopping");
	expect(isShutdownRequested()).toBe(true);
	resetLifecycle();
	resetResources();
});
