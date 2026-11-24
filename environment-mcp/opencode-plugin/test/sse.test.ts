import { describe, expect, test } from "bun:test";
import { drainSseFrames } from "../src/client.ts";

describe("SSE frames", () => {
	test("heartbeats advance the buffer without producing events", () => {
		const frames: { id?: string; data?: string }[] = [];
		const rest = drainSseFrames(
			': keepalive\n\nid: 7\ndata: {"type":"status"}\n\npartial',
			(frame) => frames.push(frame),
		);
		expect(frames).toEqual([{ id: "7", data: '{"type":"status"}' }]);
		expect(rest).toBe("partial");
	});

	test("multiple frames and comments are consumed in order", () => {
		const frames: { id?: string; data?: string }[] = [];
		const rest = drainSseFrames(
			": keepalive\n\nid: 1\ndata: one\n\n: keepalive\n\nid: 2\ndata: two\n\n",
			(frame) => frames.push(frame),
		);
		expect(frames).toEqual([
			{ id: "1", data: "one" },
			{ id: "2", data: "two" },
		]);
		expect(rest).toBe("");
	});
});
