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
		onValue: (value: unknown) => void;
		stopped: boolean;
	}> = [];
	const watch: AgentActivityWatch = async (target, onValue) => {
		const call = {
			runId: target.runId,
			hostSocket: target.hostSocket,
			onValue,
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
	source.dispose();
});
