import { expect, test } from "bun:test";
import { type ServerStack, stopServerStack } from "../src/tui/index";
import {
	beginShutdown,
	beginStartup,
	finishStartup,
	isShutdownRequested,
	message,
	phase,
	registerStopSequence,
	requestShutdown,
	setStepActive,
	setStepDone,
	setStepError,
	steps,
} from "../src/tui/lifecycle";

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

test("stopServerStack tolerates a partially-started stack (no sidecar, no collectors)", async () => {
	const stopped: string[] = [];
	const stack: ServerStack = {
		servers: [{ stop: () => stopped.push("server") }],
		grpcSidecar: undefined,
		stopPrometheus: undefined,
		stopStatsD: undefined,
	};
	let closed = false;
	let destroyed = false;
	let exitCode: number | undefined;
	await stopServerStack(
		stack,
		{
			close: () => {
				closed = true;
			},
		},
		{
			destroy: () => {
				destroyed = true;
			},
		},
		(code) => {
			exitCode = code;
		},
	);
	expect(stopped).toEqual(["server"]);
	expect(closed).toBe(true);
	expect(destroyed).toBe(true);
	expect(exitCode).toBe(0);
	expect(phase()).toBe("stopping");
});

test("stopServerStack waits for the gRPC sidecar exit event", async () => {
	const listeners: Record<string, Array<() => void>> = {};
	const sidecar = {
		kill: () =>
			setTimeout(() => {
				listeners.exit?.forEach((fn) => {
					fn();
				});
			}, 5),
		once: (event: string, fn: () => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(fn);
		},
	};
	let exitCode: number | undefined;
	await stopServerStack(
		{ servers: [], grpcSidecar: sidecar },
		{ close: () => {} },
		{ destroy: () => {} },
		(code) => {
			exitCode = code;
		},
	);
	expect(exitCode).toBe(0);
	expect(listeners.exit?.length).toBe(1);
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
});
