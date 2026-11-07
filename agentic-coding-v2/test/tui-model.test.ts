// Public boundary of the terminal client model: rendering and key handling
// without stdin/stdout or a live Runtime.
import { expect, test } from "bun:test";
import { initial, reduce, render, type Snapshot } from "../src/tui/model.ts";

const snapshot = (): Snapshot => ({
	messages: [
		{ id: "1:user", role: "user", content: "hello" },
		{ id: "1:assistant", role: "assistant", content: "hi there" },
	],
	tasks: [
		{
			id: 9,
			topicId: "alpha",
			skill: "code",
			activity: "idle",
			detail: "done",
		},
		{
			id: 10,
			topicId: "beta",
			skill: "code",
			activity: "working",
			detail: "awaiting review",
		},
	],
	reviews: [
		{
			id: "review-1",
			taskId: 10,
			title: "Hold plan",
			state: "pending",
			revision: 3,
			snapshot: "plan-bytes",
		},
	],
	runs: [{ id: "env-10:api", state: "running", owner: 10 }],
});

test("Home renders messages and sends chat with unique request IDs", () => {
	let state = initial(snapshot());
	expect(render(state, 80, 20).join("\n")).toContain("you: hello");
	for (const char of "go") state = reduce(state, char).state;
	const first = reduce(state, "enter");
	expect(first.effect).toMatchObject({ kind: "chat", content: "go" });
	expect(first.state.input).toBe("");
	for (const char of "go") first.state = reduce(first.state, char).state;
	const second = reduce(first.state, "enter");
	expect(second.effect).toMatchObject({ kind: "chat", content: "go" });
	expect(first.effect).not.toEqual(second.effect);
	const empty = reduce(second.state, "enter");
	expect(empty.effect).toBeUndefined();
	expect(empty.state.notice).toContain("Empty message");
});

test("Task detail decides reviews with exact revisions and cancels", () => {
	let state = { ...initial(snapshot()), panel: "tasks" as const };
	state = reduce(state, "down").state;
	expect(state.taskIndex).toBe(1);
	state = reduce(state, "down").state;
	expect(state.taskIndex).toBe(1);
	state = reduce(state, "enter").state;
	expect(state.detailTask).toBe(10);
	const approved = reduce(state, "a");
	expect(approved.effect).toEqual({
		kind: "decide",
		id: "review-1",
		revision: 3,
		decision: "approved",
	});
	expect(reduce(state, "r").effect).toMatchObject({ decision: "rejected" });
	expect(reduce(state, "c").effect).toMatchObject({
		decision: "changes-requested",
	});
	const cancelled = reduce(state, "x");
	expect(cancelled.effect).toEqual({ kind: "cancel", id: 10 });
	expect(cancelled.state.detailTask).toBeNull();
	expect(reduce(state, "escape").state.detailTask).toBeNull();
	expect(reduce(state, "q").state.panel).toBe("home");
});

test("List cancel, env panel and width clipping", () => {
	let state = { ...initial(snapshot()), panel: "tasks" as const };
	const cancelled = reduce(state, "x");
	expect(cancelled.effect).toEqual({ kind: "cancel", id: 9 });
	state = reduce(state, "3").state;
	const lines = render(state, 20, 10);
	expect(lines.join("\n")).toContain("env-10:api");
	const wide = render(
		{ ...initial(snapshot()), input: "y".repeat(100) },
		20,
		10,
	);
	expect(wide.every((line) => line.length <= 20)).toBe(true);
});
