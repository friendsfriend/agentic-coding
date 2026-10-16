import { describe, expect, test } from "bun:test";
import {
	commandHead,
	digestToolArgs,
	looksLikeCode,
	looksTruncated,
	pathDigest,
	redactBounded,
	redactText,
	textDigest,
} from "../../scripts/efficiency/lib/redact.ts";

describe("redactText", () => {
	test("removes the secret shapes a transcript can carry", () => {
		expect(redactText("key sk-live-abcdefghijklmnop done")).toBe(
			"key «redacted:key» done",
		);
		expect(redactText("token ghp_0123456789abcdefghij")).toBe(
			"token «redacted:token»",
		);
		expect(redactText("Authorization: Bearer abcdefghijklmnop")).toBe(
			"Authorization: Bearer «redacted»",
		);
		expect(redactText("https://user:hunter2@example.com/x")).toBe(
			"https://«redacted»@example.com/x",
		);
		expect(redactText("api_key=supersecretvalue")).toBe("api_key=«redacted»");
		expect(redactText("xoxb-1234567890-abcdefghij")).toBe("«redacted:token»");
		expect(redactText("AKIAIOSFODNN7EXAMPLE")).toBe("«redacted:aws-key»");
	});

	test("reduces a standalone opaque blob but leaves a path readable", () => {
		const blob =
			"QWxhZGRpbjpvcGVuSXNlc2FtZUFuZE1vcmVDaGFyc0hlcmVUb29raXR0b21ha2U2MGNoYXJz";
		expect(blob.length).toBeGreaterThanOrEqual(60);
		expect(redactText(`secret '${blob}'`)).toBe("secret '«redacted:blob»'");
		const path =
			"/Users/someone/development/worktrees/agentic-coding.feature-fix-a-long-named-thing/src/index.ts";
		expect(redactText(path)).toBe(path);
	});

	test("is idempotent", () => {
		const once = redactText("sk-live-abcdefghijklmnop");
		expect(redactText(once)).toBe(once);
	});
});

describe("bounded digests", () => {
	test("commandHead keeps the program and drops everything after it", () => {
		expect(commandHead("git status --short")).toBe("git");
		expect(commandHead("FOO=1 sudo rm -rf /tmp/x")).toBe("rm");
		expect(commandHead("cd /tmp && bun test")).toBe("bun");
		expect(
			commandHead(
				"curl -H 'Authorization: Bearer sk-live-abcdefghijklmnop' https://x/y",
			),
		).toBe("curl");
		expect(commandHead("")).toBe("");
	});

	test("pathDigest never redacts a plausible path", () => {
		const hint = "agentic-coding-e3447de8.feature-fix-markdown-live-jump";
		const path = `/Users/someone/development/worktrees/${hint}/src/tui/index.ts`;
		expect(pathDigest(path)).toBe(path);
	});

	test("digestToolArgs keeps a path or a command head, and hashes the rest", () => {
		const read = digestToolArgs("read", { path: "src/a.ts", limit: 10 });
		expect(read.digest).toBe("read src/a.ts");
		expect(read.hash).toHaveLength(16);
		expect(read.bytes).toBeGreaterThan(0);
		const bash = digestToolArgs("bash", {
			command: "sed -n 1,40p src/a.ts",
		});
		expect(bash.digest).toBe("bash sed");
		// Two different commands never share a digest, even when the head matches.
		const other = digestToolArgs("bash", { command: "bun test" });
		expect(other.hash).not.toBe(bash.hash);
		expect(digestToolArgs("codemode", "await tools.read({})").digest).toBe(
			"codemode await",
		);
		expect(digestToolArgs("bash", undefined).digest).toBe("bash");
	});

	test("redactBounded truncates and textDigest never returns the text", () => {
		expect(redactBounded("a".repeat(50), 10)).toBe(`${"a".repeat(10)}…`);
		const digest = textDigest("a finding description");
		expect(digest.hash).toHaveLength(16);
		expect(digest.bytes).toBe(21);
		expect(JSON.stringify(digest)).not.toContain("finding");
	});
});

describe("heuristics that are stored as flags", () => {
	test("looksTruncated recognizes the reader's markers", () => {
		expect(looksTruncated("[truncated 900 bytes]")).toBe(true);
		expect(looksTruncated("output truncated to its end")).toBe(true);
		expect(looksTruncated("nothing to see")).toBe(false);
	});

	test("looksLikeCode separates a reason code from prose", () => {
		expect(looksLikeCode("verification_requested")).toBe(true);
		expect(looksLikeCode("because the plan changed a lot")).toBe(false);
		expect(looksLikeCode("")).toBe(false);
	});
});
