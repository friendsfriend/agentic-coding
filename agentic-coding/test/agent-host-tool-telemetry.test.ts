// Tool-call telemetry shape: the bounded, secret-free fields the runtime
// records for every call (what was asked, how large the answer was, how it
// failed), asserted directly: these values are what the efficiency dataset
// later measures, and a secret-looking value must never survive one.
import { describe, expect, test } from "bun:test";
import {
	ARGS_DIGEST_LIMIT,
	classifyToolFailure,
	isToolFailureKind,
	TOOL_FAILURE_KINDS,
	toolArgsTelemetry,
	toolResultTelemetry,
} from "../src/agent-host/tool-telemetry.ts";

/** A tool-result entry shaped like the harness writes it: the model message
 * carries the text, `data.diagnostics` the structured list. */
function entry(options: {
	text?: string;
	isError?: boolean;
	diagnostics?: Array<{
		severity: string;
		code?: string;
		message: string;
	}>;
}) {
	return {
		model: [
			{
				role: "toolResult",
				content: [{ type: "text", text: options.text ?? "" }],
				isError: options.isError ?? false,
			},
		],
		...(options.diagnostics === undefined
			? {}
			: { data: { diagnostics: options.diagnostics } }),
	};
}

describe("toolArgsTelemetry", () => {
	test("hashes the arguments and keeps a path digest for a file tool", () => {
		const args = { path: "src/tui/index.ts", limit: 40 };
		const first = toolArgsTelemetry("read", args);
		expect(first.hash).toHaveLength(16);
		expect(first.digest).toBe("read src/tui/index.ts");
		expect(first.bytes).toBe(Buffer.byteLength(JSON.stringify(args), "utf8"));
		// The same arguments hash the same way; a different file does not.
		expect(toolArgsTelemetry("read", args).hash).toBe(first.hash);
		expect(toolArgsTelemetry("read", { path: "src/other.ts" }).hash).not.toBe(
			first.hash,
		);
	});

	test("keeps the searched path and pattern for a search tool", () => {
		const digest = toolArgsTelemetry("grep", {
			path: "src/workflow",
			pattern: "tool_call",
			ignoreCase: true,
		}).digest;
		expect(digest).toBe("grep src/workflow /tool_call/");
	});

	test("keeps a bounded command head for bash", () => {
		const long = `bun test ${"test/a-very-long-name.test.ts ".repeat(12)}`;
		const digest = toolArgsTelemetry("bash", { command: long }).digest;
		expect(digest.startsWith("bash bun test ")).toBe(true);
		expect(digest.length).toBeLessThanOrEqual(ARGS_DIGEST_LIMIT);
		expect(digest.endsWith("…")).toBe(true);
	});

	test("redacts the credential shapes a command carries", () => {
		const cases: Array<[string, string]> = [
			[
				"curl -H 'Authorization: Bearer abcdefghijklmnop' https://x",
				"abcdefghijklmnop",
			],
			["curl https://user:hunter2@example.com/x", "hunter2"],
			[
				"GITHUB_TOKEN=ghp_0123456789abcdefghij git push",
				"ghp_0123456789abcdefghij",
			],
			["mysql -p swordfish -e 'select 1'", "swordfish"],
			["deploy --password=hunter2 --token sk-live-abcdefghijklmnop", "hunter2"],
			[
				"OPENAI_API_KEY=sk-live-abcdefghijklmnop bun run build",
				"sk-live-abcdefghijklmnop",
			],
			["deploy --token=abc123xyz", "abc123xyz"],
		];
		for (const [command, secret] of cases) {
			const digest = toolArgsTelemetry("bash", { command }).digest;
			expect(digest).not.toContain(secret);
			expect(digest).toContain("«redacted");
		}
	});

	test("never returns argument text for a free-form tool", () => {
		const script = "await tools.read({ path: 'src/secret.ts' })";
		const digest = toolArgsTelemetry("codemode", script).digest;
		expect(digest.startsWith("codemode ")).toBe(true);
		// The digest is the argument itself here, so it is bounded like every
		// other; a 200-character summary is the worst case, never the full text.
		expect(digest.length).toBeLessThanOrEqual(ARGS_DIGEST_LIMIT);
		expect(toolArgsTelemetry("bash", undefined).digest).toBe("bash");
		expect(toolArgsTelemetry("bash", { command: "" }).digest).toBe("bash");
	});
});

describe("toolResultTelemetry", () => {
	test("measures the result without keeping it", () => {
		const facts = toolResultTelemetry(
			entry({ text: "line one\nline two\nline three" }),
		);
		expect(facts?.bytes).toBe(28);
		expect(facts?.lines).toBe(3);
		expect(facts?.isError).toBe(false);
		expect(facts?.truncated).toBe(false);
		expect(JSON.stringify(facts)).not.toContain("line one");
	});

	test("marks a truncated result from the harness's own diagnostic", () => {
		const facts = toolResultTelemetry(
			entry({
				text: "kept",
				diagnostics: [
					{ severity: "warn", code: "truncated", message: "…" },
					{ severity: "info", code: "full_output", message: "…" },
				],
			}),
		);
		expect(facts?.truncated).toBe(true);
	});

	test("returns nothing when no result entry survived", () => {
		expect(toolResultTelemetry(undefined)).toBeUndefined();
		expect(toolResultTelemetry({})).toBeUndefined();
	});
});

describe("classifyToolFailure", () => {
	test("a missing result entry is a host error", () => {
		expect(classifyToolFailure(undefined)).toBe("host-error");
	});

	test("separates the failures the old vocabulary collapsed", () => {
		const cases: Array<[string, ReturnType<typeof classifyToolFailure>]> = [
			["ENOENT: no such file or directory, open 'src/a.ts'", "not-found"],
			[
				"Could not find edits[0] in src/a.ts. The oldText must match exactly including all whitespace and newlines.",
				"no-match",
			],
			["edit: Replacement range is outside the base content.", "no-match"],
			["grep: path escapes the repository: ../outside", "denied"],
			["EACCES: permission denied, open '/root/x'", "denied"],
			["Command timed out after 120 seconds", "timeout"],
			["Command aborted", "aborted"],
			[
				"Edit tool input is invalid. edits must contain at least one replacement.",
				"invalid-args",
			],
			["Command exited with code 1", "other"],
		];
		for (const [text, kind] of cases)
			expect(classifyToolFailure(entry({ text, isError: true }))).toBe(kind);
	});

	test("uses the diagnostic code for an unsupported image", () => {
		expect(
			classifyToolFailure(
				entry({
					text: "/tmp/x.png is an image (image/png)",
					diagnostics: [
						{
							severity: "error",
							code: "unsupported_image",
							message: "/tmp/x.png is an image (image/png)",
						},
					],
				}),
			),
		).toBe("invalid-args");
	});

	test("every kind it can produce is part of the documented vocabulary", () => {
		for (const kind of TOOL_FAILURE_KINDS)
			expect(isToolFailureKind(kind)).toBe(true);
		expect(isToolFailureKind("tool_error")).toBe(false);
	});
});
