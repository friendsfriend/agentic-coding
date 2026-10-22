// The OpenCode session bridge is a thin CLI boundary: the orchestrator tool
// names an operation and a prompt, and this module builds the argv and reads
// the JSON envelope. These tests pin both halves without starting OpenCode.
import { describe, expect, test } from "bun:test";
import {
	openCodeApiArgs,
	parseOpenCodeApiOutput,
} from "../src/agent-host/opencode-sessions.ts";

describe("opencode api argv", () => {
	test("names the operation, path params and JSON body", () => {
		expect(
			openCodeApiArgs({
				cwd: "/repo",
				operation: "session.prompt",
				params: { sessionID: "ses_123" },
				body: { text: "hello" },
			}),
		).toEqual([
			"opencode",
			"api",
			"session.prompt",
			"--param",
			"sessionID=ses_123",
			"-d",
			'{"text":"hello"}',
		]);
	});

	test("omits a body that is not provided", () => {
		expect(
			openCodeApiArgs({ cwd: "/repo", operation: "session.create" }),
		).toEqual(["opencode", "api", "session.create"]);
	});
});

describe("opencode api envelope", () => {
	test("returns the data payload", () => {
		expect(
			parseOpenCodeApiOutput(
				'{"data":{"id":"ses_123","title":"Probe"}}\n',
				"",
				0,
			),
		).toEqual({ id: "ses_123", title: "Probe" });
	});

	test("uses the error envelope and stderr on a failed request", () => {
		expect(() =>
			parseOpenCodeApiOutput(
				'{"_tag":"SessionNotFoundError","sessionID":"ses_bad","message":"Session not found: ses_bad"}',
				"HTTP 404 Not Found",
				1,
			),
		).toThrow("SessionNotFoundError: Session not found: ses_bad");
	});

	test("a business error envelope fails even with exit code zero", () => {
		expect(() =>
			parseOpenCodeApiOutput(
				'{"_tag":"SessionNotFoundError","message":"Session not found"}',
				"",
				0,
			),
		).toThrow("Session not found");
	});

	test("a non-JSON success is an error, not an empty payload", () => {
		expect(() => parseOpenCodeApiOutput("not json", "", 0)).toThrow("non-JSON");
	});
});
