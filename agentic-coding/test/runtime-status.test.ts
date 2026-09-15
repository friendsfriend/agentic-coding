// Runtime status normalization (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/runstatus/status_test.go` and
// `server/pkg/status/manager_test.go`. State priority never follows runtime
// type, and a provider's detail survives normalization.
import { describe, expect, test } from "bun:test";
import {
	classify,
	normalize,
	rank,
	runtimeStatusString,
	STATUS_CLEAR_AFTER_MS,
	StatusManager,
	select,
	selectStatus,
	state,
} from "../src/server/runtime/status.ts";

describe("status selection", () => {
	test("uses state priority, not runtime priority", () => {
		expect(
			select([
				{ source: "docker", status: "stopped" },
				{ source: "kubernetes", status: "running (1/1 pods)" },
			]),
		).toBe("running (1/1 pods)");
		expect(
			select([
				{ source: "kubernetes", status: "failed (0/1 pods)" },
				{ source: "podman", status: "running" },
			]),
		).toBe("running");
		expect(
			select([
				{ source: "docker", status: "not found" },
				{ source: "kubernetes", status: "starting (0/1 pods)" },
			]),
		).toBe("starting (0/1 pods)");
	});

	test("aggregates equal highest states", () => {
		expect(
			select([
				{ source: "docker", status: "running" },
				{ source: "kubernetes", status: "running (1/1 pods)" },
			]),
		).toBe("running (2 targets)");
	});

	test("separates state and detail", () => {
		const selected = selectStatus([
			{ source: "kubernetes", status: "starting (1/2 pods)" },
		]);
		expect(selected).toEqual({ state: "starting", detail: "1/2 pods" });
		expect(runtimeStatusString(selected)).toBe("starting (1/2 pods)");
		expect(selectStatus([])).toEqual({ state: "stopped" });
	});

	test("rank orders the documented states", () => {
		expect(rank("running")).toBe(5);
		expect(rank("starting")).toBe(4);
		expect(rank("failed")).toBe(3);
		expect(rank("stopped")).toBe(2);
		expect(rank("something else")).toBe(1);
	});

	test("state normalizes provider text", () => {
		expect(state("running (1/1 pods)")).toBe("running");
		expect(state("Healthy")).toBe("running");
		expect(state("Up 2 minutes")).toBe("running");
		expect(state("pending")).toBe("starting");
		expect(state("restarting")).toBe("starting");
		expect(state("unhealthy")).toBe("failed");
		expect(state("CrashLoopBackOff")).toBe("failed");
		expect(state("")).toBe("stopped");
		expect(state("not found")).toBe("stopped");
		expect(state("weird")).toBe("unknown");
	});
});

describe("normalize", () => {
	test("preserves recognized provider detail", () => {
		expect(normalize("Up 2 minutes")).toEqual({
			state: "running",
			detail: "2 minutes",
		});
		expect(normalize("down (reason)")).toEqual({
			state: "stopped",
			detail: "reason",
		});
		expect(normalize("CrashLoopBackOff (restart)")).toEqual({
			state: "failed",
			detail: "LoopBackOff (restart)",
		});
	});
});

describe("operation status", () => {
	test("a stopped message is terminal", () => {
		const manager = new StatusManager();
		const update = manager.startOperation("infra", "stop");
		expect(manager.getStatus("infra")).toMatchObject({
			operation: "stop",
			status: "active",
			message: "Stopping...",
		});
		update("stopped");
		expect(manager.getStatus("infra")?.status).toBe("completed");
	});

	test("classification matches Go's callback rules", () => {
		expect(classify("completed")).toBe("completed");
		expect(classify("start successful")).toBe("completed");
		expect(classify("containers stopped")).toBe("completed");
		expect(classify("Error: boom")).toBe("failed");
		expect(classify("build failed")).toBe("failed");
		expect(classify("still working")).toBe("active");
	});

	test("a terminal status auto-clears after the Go delay", async () => {
		const manager = new StatusManager();
		const update = manager.startOperation("infra", "start");
		update("start successful");
		expect(manager.isActiveOperation("infra")).toBe(false);
		expect(manager.getFormattedStatus("infra")).toBe("start successful");
		await Bun.sleep(STATUS_CLEAR_AFTER_MS + 50);
		expect(manager.getStatus("infra")).toBeUndefined();
		manager.stop();
	});

	test("stop clears pending auto-clear timers", async () => {
		const manager = new StatusManager();
		manager.setStatus("infra", "start", "completed", "done");
		manager.stop();
		expect(manager.getStatus("infra")?.message).toBe("done");
		await Bun.sleep(STATUS_CLEAR_AFTER_MS + 20);
		// The timer was cancelled, so the status is still there for this process.
		expect(manager.getStatus("infra")?.message).toBe("done");
	});
});
