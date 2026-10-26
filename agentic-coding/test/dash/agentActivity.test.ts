import { expect, test } from "bun:test";
import {
	type AgentActivityWatch,
	agentActivityFromValue,
	createAgentActivitySource,
} from "../../src/tui/dash/agent-activity.ts";

/** A watch frame as the host sends it: the conversation view with the live
 * documents the dashboard reads. */
function frame(docs: Record<string, unknown>): unknown {
	return { entries: [], docs };
}

function liveFrame(live: Record<string, unknown>): unknown {
	return frame({ "pi.live": live });
}

test("a running tool is the reported activity", () => {
	expect(
		agentActivityFromValue(
			liveFrame({ run: {}, tools: [{ name: "bash", status: "running" }] }),
		),
	).toEqual({ label: "bash", active: true, tone: "working" });
	expect(
		agentActivityFromValue(
			liveFrame({ run: {}, tools: [{ name: "read", status: "running" }] }),
		),
	).toEqual({ label: "read", active: true, tone: "working" });
	// pi's grep/find both read as a search to the panel.
	expect(
		agentActivityFromValue(
			liveFrame({ run: {}, tools: [{ name: "grep", status: "running" }] }),
		)?.label,
	).toBe("search");
});

test("the newest running tool wins, and finished slots are ignored", () => {
	expect(
		agentActivityFromValue(
			liveFrame({
				run: {},
				tools: [
					{ name: "read", status: "running" },
					{ name: "bash", status: "running" },
					{ name: "write", status: "done" },
				],
			}),
		)?.label,
	).toBe("bash");
});

test("a blocking question is reported as blocked", () => {
	expect(
		agentActivityFromValue(
			liveFrame({
				run: {},
				tools: [{ name: "developer_question", status: "running" }],
			}),
		),
	).toEqual({ label: "asking", active: true, tone: "blocked" });
});

test("a generation with no text yet is thinking; streamed text is answering", () => {
	expect(
		agentActivityFromValue(liveFrame({ run: {}, generation: {} })),
	).toEqual({
		label: "thinking",
		active: true,
		tone: "working",
	});
	expect(
		agentActivityFromValue(
			liveFrame({
				run: {},
				generation: { message: { content: [{ type: "text", text: "hi" }] } },
			}),
		)?.label,
	).toBe("answering");
	// An empty streamed block is still a generation with nothing to show.
	expect(
		agentActivityFromValue(
			liveFrame({
				run: {},
				generation: { message: { content: [{ type: "text", text: "" }] } },
			}),
		)?.label,
	).toBe("thinking");
});

test("deferred and retrying generations are reported distinctly", () => {
	expect(
		agentActivityFromValue(
			liveFrame({ run: {}, generation: { deferred: true } }),
		)?.label,
	).toBe("waiting");
	expect(
		agentActivityFromValue(
			liveFrame({ run: {}, generation: { retry: { error: "429" } } }),
		)?.label,
	).toBe("retrying");
});

test("compaction and queued input are activities too", () => {
	// The badge carries the compaction's reason: a manual `/compact` and the
	// harness's own threshold compaction read differently on the panel.
	expect(
		agentActivityFromValue(
			liveFrame({ run: {}, compactions: [{ reason: "manual" }] }),
		)?.label,
	).toBe("compacting (manual)");
	expect(
		agentActivityFromValue(
			liveFrame({ run: {}, compactions: [{ reason: "threshold" }] }),
		)?.label,
	).toBe("compacting (threshold)");
	// A status without a reason still reads as compacting rather than vanishing.
	expect(
		agentActivityFromValue(liveFrame({ run: {}, compactions: [{}] }))?.label,
	).toBe("compacting");
	expect(
		agentActivityFromValue(
			frame({ "pi.live": { run: {} }, "pi.inbox": { items: [{}] } }),
		)?.label,
	).toBe("queued");
});

test("an active run with no finer step still reports working", () => {
	expect(agentActivityFromValue(liveFrame({ run: { startedAt: 1 } }))).toEqual({
		label: "working",
		active: true,
		tone: "working",
	});
});

test("parked tasks and compaction failures remain visible while idle", () => {
	expect(
		agentActivityFromValue({
			docs: { "pi.live": {} },
			runtimeFailure: {
				kind: "task_parked",
				domain: "task",
				taskId: "task-7",
				reason: "restart_limit",
			},
		}),
	).toEqual({
		label: "parked",
		active: false,
		tone: "blocked",
		detail: "task task-7 · restart_limit",
	});
	expect(
		agentActivityFromValue(
			liveFrame({ compactionFailure: { error: "summary failed" } }),
		),
	).toEqual({
		label: "compaction failed",
		active: false,
		tone: "blocked",
		detail: "summary failed",
	});
	expect(agentActivityFromValue(liveFrame({}))).toBeUndefined();
});

test("failure details are redacted before they reach the panel", () => {
	const activity = agentActivityFromValue({
		docs: { "pi.live": {} },
		runtimeFailure: {
			kind: "task_faulted",
			domain: "task",
			taskId: "task-1",
			error: "Bearer sk-live-abcdefghijklmnop",
		},
	});
	expect(activity?.detail).toBe("Bearer [REDACTED]");
	expect(activity?.detail).not.toContain("sk-live");
});

test("no live work reports nothing, so the panel keeps the status badge", () => {
	expect(agentActivityFromValue(liveFrame({}))).toBeUndefined();
	expect(agentActivityFromValue(frame({}))).toBeUndefined();
	expect(agentActivityFromValue(undefined)).toBeUndefined();
});

test("an unknown tool keeps its own name", () => {
	expect(
		agentActivityFromValue(
			liveFrame({
				run: {},
				tools: [{ name: "apply_patch", status: "running" }],
			}),
		)?.label,
	).toBe("edit");
	expect(
		agentActivityFromValue(
			liveFrame({
				run: {},
				tools: [{ name: "custom_tool", status: "running" }],
			}),
		)?.label,
	).toBe("custom tool");
});

/** A fake host watch that records its targets and hands back test-controlled
 * frames without opening a socket. */
function fakeWatch() {
	const calls: Array<{
		runId: string;
		hostSocket: string;
		view: "docs";
		onValue: (value: unknown) => void;
		onState?: (state: "connecting" | "open" | "closed") => void;
		stopped: boolean;
	}> = [];
	const watch: AgentActivityWatch = async (target, onValue, onState) => {
		const call = {
			runId: target.runId,
			hostSocket: target.hostSocket,
			view: target.view,
			onValue,
			...(onState ? { onState } : {}),
			stopped: false,
		};
		calls.push(call);
		return () => {
			call.stopped = true;
		};
	};
	return { calls, watch };
}

/** Let the source's async watch start settle. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("the source watches each durable agent and reports its frames", async () => {
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
		{ role: "planner" },
	]);
	await settle();
	expect(calls).toHaveLength(1);
	expect(calls[0]?.runId).toBe("run-1");

	calls[0]?.onValue(
		liveFrame({ run: {}, tools: [{ name: "bash", status: "running" }] }),
	);
	expect(source.activity("worker")).toEqual({
		label: "bash",
		active: true,
		tone: "working",
	});
	// A later frame with no live work clears the activity again.
	calls[0]?.onValue(liveFrame({}));
	expect(source.activity("worker")).toBeUndefined();
	source.dispose();
});

test("a watched role is pending until its first real frame arrives", async () => {
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
		// No run identity: nothing to watch, so nothing to gather.
		{ role: "planner" },
	]);
	await settle();
	expect(source.pending("worker")).toBe(true);
	expect(source.pending("planner")).toBe(false);
	// The `undefined` replay `watchStream` sends on a drop is not a frame: the
	// row keeps gathering until the host actually reports the live documents.
	calls[0]?.onValue(undefined);
	expect(source.pending("worker")).toBe(true);
	calls[0]?.onValue(
		liveFrame({ run: {}, tools: [{ name: "bash", status: "running" }] }),
	);
	expect(source.pending("worker")).toBe(false);
	source.dispose();
});

test("a watch that never connects stops gathering and falls back to the status", async () => {
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	expect(source.pending("worker")).toBe(true);
	// A reconnect attempt keeps gathering; giving up hands the row back to the
	// workflow status instead of spinning forever.
	calls[0]?.onState?.("connecting");
	expect(source.pending("worker")).toBe(true);
	calls[0]?.onState?.("closed");
	expect(source.pending("worker")).toBe(false);
	source.dispose();
});

test("disconnect and reconnect clear an observed tool until a fresh frame arrives", async () => {
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	try {
		source.sync([
			{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
		]);
		await settle();
		const call = calls[0];
		if (!call) throw new Error("watch not acquired");
		for (const state of ["closed", "connecting"] as const) {
			call.onValue(
				liveFrame({ run: {}, tools: [{ name: "bash", status: "running" }] }),
			);
			expect(source.activity("worker")?.label).toBe("bash");
			call.onState?.(state);
			expect(source.activity("worker")).toBeUndefined();
			call.onState?.("open");
			expect(source.activity("worker")).toBeUndefined();
		}
		call.onValue(
			liveFrame({ run: {}, tools: [{ name: "write", status: "running" }] }),
		);
		expect(source.activity("worker")?.label).toBe("write");
		// A delayed disconnect from the old identity cannot clear a newer run.
		source.sync([
			{ role: "worker", runId: "run-2", hostSocket: "/tmp/host.sock" },
		]);
		await settle();
		calls[1]?.onValue(
			liveFrame({ run: {}, tools: [{ name: "read", status: "running" }] }),
		);
		call.onState?.("closed");
		expect(source.activity("worker")?.label).toBe("read");
	} finally {
		source.dispose();
	}
});

test("removing an agent and disposing the source clear the gathering state", async () => {
	const { watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	expect(source.pending("worker")).toBe(true);
	source.sync([]);
	expect(source.pending("worker")).toBe(false);
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	expect(source.pending("worker")).toBe(true);
	source.dispose();
	expect(source.pending("worker")).toBe(false);
});

test("every activity watch asks the host for the live documents alone", async () => {
	// The badge reads `pi.live`/`pi.inbox` and nothing else, so the watch must
	// not ask for the committed transcript: shipping it would put a run's whole
	// conversation on the socket again on every token-rate frame of every agent.
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	expect(calls.map((call) => call.view)).toEqual(["docs"]);
	source.dispose();
});

test("re-syncing the same run does not open a second watch", async () => {
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	const agents = [
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	];
	source.sync(agents);
	await settle();
	source.sync(agents);
	await settle();
	expect(calls).toHaveLength(1);
	source.dispose();
});

test("a changed run identity restarts the watch; a removed agent stops it", async () => {
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	source.sync([
		{ role: "worker", runId: "run-2", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	expect(calls).toHaveLength(2);
	expect(calls[0]?.stopped).toBe(true);
	expect(calls[1]?.runId).toBe("run-2");

	source.sync([]);
	await settle();
	expect(calls[1]?.stopped).toBe(true);
	source.dispose();
});

test("dispose stops every watch and clears the activities", async () => {
	const { calls, watch } = fakeWatch();
	const source = createAgentActivitySource({ watch });
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	calls[0]?.onValue(liveFrame({ run: {} }));
	expect(source.activity("worker")?.label).toBe("working");
	source.dispose();
	expect(calls[0]?.stopped).toBe(true);
	expect(source.activity("worker")).toBeUndefined();
	// A disposed source ignores later frames instead of resurrecting the badge.
	calls[0]?.onValue(liveFrame({ run: {} }));
	expect(source.activity("worker")).toBeUndefined();
});

test("an unreachable host is not reported as activity", async () => {
	const source = createAgentActivitySource({
		watch: async () => {
			throw new Error("no host");
		},
	});
	source.sync([
		{ role: "worker", runId: "run-1", hostSocket: "/tmp/host.sock" },
	]);
	await settle();
	expect(source.activity("worker")).toBeUndefined();
	// A host that cannot be reached must not leave the row gathering forever.
	expect(source.pending("worker")).toBe(false);
	source.dispose();
});
