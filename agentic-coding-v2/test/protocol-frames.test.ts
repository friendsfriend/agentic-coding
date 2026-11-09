import { describe, expect, test } from "bun:test";
import { frame, result } from "../src/protocol/frames.ts";

// Client trust boundary: shapes are validated before they become client state,
// so no renderer has to defend itself and no supplied byte string stands in for
// authority. These are protocol checks only; no renderable is mounted.

const context = () => ({
	id: 7,
	head: { id: 3, kind: "message" },
	entries: [{ id: 1 }, { id: 2 }],
	contributions: [[{ id: 1 }], []],
	messages: [{ role: "user" }],
	model: {
		provider: "fixture",
		modelId: "fixture-model",
		catalogued: true,
		contextWindow: 200000,
		maxOutput: 8192,
	},
	thinking: "off",
});

const transcript = () => ({
	id: 7,
	model: null,
	thinking: "off",
	entries: [],
	truncated: false,
	progress: {
		run: null,
		generation: null,
		tools: [],
		nestedTools: [],
		compactions: [],
		compactionFailure: null,
		inbox: [],
	},
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	},
});

describe("native context observation", () => {
	test("accepts an aligned bounded projection", () => {
		expect(result("session.context", context())).toEqual(context());
		// An unconfigured agent and an uncatalogued model stay valid observations.
		expect(
			result("session.context", { ...context(), model: null, head: null }),
		).toMatchObject({ model: null, head: null });
	});

	test("refuses entries that no longer pair with their contributions", () => {
		expect(() =>
			result("session.context", { ...context(), contributions: [[{ id: 1 }]] }),
		).toThrow("Invalid native context observation");
		expect(() =>
			result("session.context", {
				...context(),
				contributions: [[{}], [], []],
			}),
		).toThrow("Invalid native context observation");
	});

	test("refuses a projection beyond the server's own budget instead of trimming it", () => {
		const huge = {
			...context(),
			entries: [{ id: 1, text: "x".repeat(200000) }],
			contributions: [[{}]],
			messages: [{ text: "y".repeat(200000) }],
		};
		expect(() => result("session.context", huge)).toThrow(
			"Invalid native context observation",
		);
	});

	test("refuses a model record that cannot be reported honestly", () => {
		for (const model of [
			{ ...context().model, provider: 1 },
			{ ...context().model, catalogued: "yes" },
			{ ...context().model, contextWindow: 0 },
			{ ...context().model, maxOutput: 1.5 },
			{ ...context().model, provider: "f".repeat(300) },
		])
			expect(() => result("session.context", { ...context(), model })).toThrow(
				"Invalid native context model",
			);
		expect(() =>
			result("session.context", { ...context(), thinking: 1 }),
		).toThrow("Invalid native context observation");
	});
});

describe("native transcript frames", () => {
	test("accepts a transcript with no reported usage, but refuses a missing usage record", () => {
		expect(result("session.read", transcript())).toMatchObject({ id: 7 });
		const { usage: _usage, ...withoutUsage } = transcript();
		expect(() => result("session.read", withoutUsage)).toThrow();
	});

	test("refuses a nested slot that does not name its parent call", () => {
		const nested = {
			...transcript(),
			progress: {
				...transcript().progress,
				nestedTools: [
					{ callId: "a/b", name: "read", status: "running", parentTaskId: 1 },
				],
			},
		};
		expect(() => result("session.read", nested)).toThrow(
			"Invalid native nested tool relationship",
		);
		expect(
			result("session.read", {
				...transcript(),
				progress: {
					...transcript().progress,
					nestedTools: [
						{
							callId: "a/b",
							name: "read",
							status: "done",
							taskId: 2,
							parentTaskId: 1,
							parentCallId: "a",
						},
					],
				},
			}),
		).toMatchObject({ id: 7 });
	});
});

describe("server envelopes", () => {
	test("refuses an unknown method and an unversioned frame", () => {
		expect(() =>
			frame({ version: 1, type: "hello", connection: "c", methods: ["nope"] }),
		).toThrow("Invalid server capabilities");
		expect(() =>
			frame({ version: 2, type: "hello", connection: "c", methods: [] }),
		).toThrow("Unsupported server protocol");
	});

	test("validates a published session before it reaches client state", () => {
		expect(
			frame({
				version: 1,
				type: "session",
				sequence: 1,
				watchId: "w:1",
				value: transcript(),
			}),
		).toMatchObject({ type: "session" });
		expect(() =>
			frame({
				version: 1,
				type: "session",
				sequence: 0,
				watchId: "w:1",
				value: transcript(),
			}),
		).toThrow("Invalid session publication");
	});
});
