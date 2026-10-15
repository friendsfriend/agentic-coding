import { describe, expect, test } from "bun:test";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	type HostRequest,
	type HostResponse,
	MAX_FRAME_BYTES,
	normalizeSubmitMode,
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

	test("round-trips a compact-run request and its structured answer", () => {
		const request: HostRequest = {
			type: "compactRun",
			runId: "r1",
			instructions: "focus on the open findings",
		};
		const decodedRequest = decodeFrame(encodeFrame(request).slice(0, -1));
		expect(decodedRequest).toEqual({ ok: true, value: request });
		const response: HostResponse = {
			type: "compactRun",
			runId: "r1",
			status: "already-compacting",
			reason: "manual",
		};
		expect(decodeFrame(encodeFrame(response).slice(0, -1))).toEqual({
			ok: true,
			value: response,
		});
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

describe("submit mode normalization", () => {
	test("an interrupt-style mode steers and everything else follows up", () => {
		expect(normalizeSubmitMode("steer")).toBe("steer");
		expect(normalizeSubmitMode("overwrite")).toBe("steer");
		expect(normalizeSubmitMode("Interrupt")).toBe("steer");
		expect(normalizeSubmitMode("followUp")).toBe("followUp");
		expect(normalizeSubmitMode("mystery-mode")).toBe("followUp");
		expect(normalizeSubmitMode(undefined)).toBe("followUp");
		expect(normalizeSubmitMode(7)).toBe("followUp");
	});
});
