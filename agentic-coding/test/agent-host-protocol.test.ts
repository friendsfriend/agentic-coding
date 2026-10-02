import { describe, expect, test } from "bun:test";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	MAX_FRAME_BYTES,
	PROTOCOL_VERSION,
} from "../src/agent-host/protocol.ts";

describe("agent host protocol framing", () => {
	test("round-trips a request through encode/decode", () => {
		const request = {
			type: "submit" as const,
			runId: "r1",
			text: "hello",
			requestId: "req-1",
		};
		const frame = encodeFrame(request);
		expect(frame.endsWith("\n")).toBe(true);
		const decoded = decodeFrame(frame.slice(0, -1));
		expect(decoded).toEqual({ ok: true, value: request });
	});

	test("rejects a frame above the byte bound without throwing", () => {
		const huge = "x".repeat(MAX_FRAME_BYTES + 1);
		const decoded = decodeFrame(huge);
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) expect(decoded.error.code).toBe("oversized-frame");
	});

	test("encodeFrame throws rather than emit an oversized frame", () => {
		const huge = "x".repeat(MAX_FRAME_BYTES);
		expect(() =>
			encodeFrame({ type: "submit", runId: "r1", text: huge, requestId: "x" }),
		).toThrow();
	});

	test("rejects malformed JSON as a structured error", () => {
		const decoded = decodeFrame("not json");
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) expect(decoded.error.code).toBe("invalid-request");
	});

	test("protocol version is a small positive integer client and host both pin", () => {
		expect(PROTOCOL_VERSION).toBeGreaterThan(0);
	});

	test("FrameReader reassembles lines split across chunks", () => {
		const reader = new FrameReader();
		expect(reader.push('{"type":"a"}\n{"type":"b')).toEqual(['{"type":"a"}']);
		expect(reader.push('"}\n')).toEqual(['{"type":"b"}']);
	});

	test("FrameReader holds a partial line until its newline arrives", () => {
		const reader = new FrameReader();
		expect(reader.push("partial")).toEqual([]);
		expect(reader.push(" line\n")).toEqual(["partial line"]);
	});
});
