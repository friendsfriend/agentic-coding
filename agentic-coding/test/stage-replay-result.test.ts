// `decodeReplayResult` (`add-stage-flow-replay` tasks 3.8/4.7): the refusal
// paths for a malformed, mismatched or dishonest `stage-run.json` — pinned
// directly with a hand-written result file, no Playwright process needed.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	decodeReplayResult,
	replayEventsFromSteps,
} from "../src/server/browser/stage-replay.ts";

const IDENTITY = {
	flowId: "customer-address",
	routeHash: `sha256:${"a".repeat(64)}`,
	inputsHash: `sha256:${"b".repeat(64)}`,
};

function validResult(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: 1,
		flowId: IDENTITY.flowId,
		routeHash: IDENTITY.routeHash,
		inputsHash: IDENTITY.inputsHash,
		status: "passed",
		startedAt: new Date().toISOString(),
		durationMs: 10,
		steps: [
			{
				index: 0,
				routeStepId: "open",
				block: "crm.ui.open",
				version: "1.0.0",
				status: "passed",
				durationMs: 10,
			},
		],
		...overrides,
	};
}

function tempResultFile(content?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-result-"));
	const file = path.join(dir, "stage-run.json");
	if (content !== undefined) fs.writeFileSync(file, content);
	return file;
}

describe("decodeReplayResult (add-stage-flow-replay)", () => {
	test("accepts a valid, matching, zero-exit result", () => {
		const file = tempResultFile(JSON.stringify(validResult()));
		const result = decodeReplayResult(file, IDENTITY, 0);
		expect(result.status).toBe("passed");
		expect(result.flowId).toBe(IDENTITY.flowId);
	});

	test("refuses a missing result file, with redacted process output context", () => {
		const file = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "replay-result-")),
			"stage-run.json",
		);
		expect(() =>
			decodeReplayResult(
				file,
				IDENTITY,
				1,
				(text) => text.replace("s3cr3t", "[redacted]"),
				{ stdout: "", stderr: "login failed for s3cr3t" },
			),
		).toThrow(/without stage-run\.json/);
		try {
			decodeReplayResult(
				file,
				IDENTITY,
				1,
				(text) => text.replace("s3cr3t", "[redacted]"),
				{ stdout: "", stderr: "login failed for s3cr3t" },
			);
		} catch (error) {
			expect(String((error as Error).message)).not.toContain("s3cr3t");
			expect(String((error as Error).message)).toContain("[redacted]");
			expect((error as { code?: string }).code).toBe("replay-result-invalid");
		}
	});

	test("refuses malformed JSON", () => {
		const file = tempResultFile("{ this is not json");
		expect(() => decodeReplayResult(file, IDENTITY, 0)).toThrow(
			/does not match the replay contract/,
		);
	});

	test("refuses a result that does not match the replay contract schema", () => {
		// A well-formed JSON object, missing the required `routeHash`/`status`.
		const file = tempResultFile(
			JSON.stringify({ version: 1, flowId: IDENTITY.flowId }),
		);
		expect(() => decodeReplayResult(file, IDENTITY, 0)).toThrow(
			/does not match the replay contract/,
		);
	});

	test("refuses a flowId, routeHash or inputsHash that does not match what was launched", () => {
		const wrongFlow = tempResultFile(
			JSON.stringify(validResult({ flowId: "other-flow" })),
		);
		expect(() => decodeReplayResult(wrongFlow, IDENTITY, 0)).toThrow(
			/identity does not match/,
		);
		const wrongRoute = tempResultFile(
			JSON.stringify(validResult({ routeHash: `sha256:${"c".repeat(64)}` })),
		);
		expect(() => decodeReplayResult(wrongRoute, IDENTITY, 0)).toThrow(
			/identity does not match/,
		);
		const wrongInputs = tempResultFile(
			JSON.stringify(validResult({ inputsHash: `sha256:${"d".repeat(64)}` })),
		);
		expect(() => decodeReplayResult(wrongInputs, IDENTITY, 0)).toThrow(
			/identity does not match/,
		);
	});

	test("refuses a non-zero process exit that reports a pass", () => {
		const file = tempResultFile(JSON.stringify(validResult()));
		expect(() => decodeReplayResult(file, IDENTITY, 1)).toThrow(
			/exited 1 but reported a pass/,
		);
	});

	test("accepts a non-zero exit that honestly reports a failure", () => {
		const file = tempResultFile(
			JSON.stringify(validResult({ status: "failed", error: "it broke" })),
		);
		const result = decodeReplayResult(file, IDENTITY, 1);
		expect(result.status).toBe("failed");
	});

	test("decodes a skipped step: a step never attempted after an earlier failure stays distinguishable from a failed one", () => {
		const file = tempResultFile(
			JSON.stringify(
				validResult({
					status: "failed",
					error: "login failed",
					steps: [
						{
							index: 0,
							routeStepId: "login",
							block: "crm.auth.loginAsRole",
							version: "1.0.0",
							status: "failed",
							durationMs: 10,
							error: "login failed",
						},
						{
							index: 1,
							routeStepId: "open",
							block: "crm.ui.open",
							version: "1.0.0",
							status: "skipped",
							durationMs: 0,
						},
					],
				}),
			),
		);
		const result = decodeReplayResult(file, IDENTITY, 1);
		expect(result.steps.map((step) => step.status)).toEqual([
			"failed",
			"skipped",
		]);
	});
});

describe("replayEventsFromSteps (add-stage-flow-replay)", () => {
	test("derives one failed event for a skipped step, so it is never ingested as a pass", () => {
		const events = replayEventsFromSteps({
			steps: [
				{
					index: 0,
					routeStepId: "login",
					block: "crm.auth.loginAsRole",
					version: "1.0.0",
					status: "failed",
					durationMs: 10,
					error: "login failed",
				},
				{
					index: 1,
					routeStepId: "open",
					block: "crm.ui.open",
					version: "1.0.0",
					status: "skipped",
					durationMs: 0,
				},
			],
		});
		expect(events.map((event) => event.status)).toEqual(["failed", "failed"]);
		expect(events[1]?.subStep).toBe("crm.ui.open");
	});

	test("uses the fixture's own richer events verbatim when present", () => {
		const providedEvents = [
			{
				index: 0,
				routeStepId: "login",
				block: "crm.auth.loginAsRole",
				version: "1.0.0",
				subStep: "sign in as the requested role",
				status: "passed" as const,
				durationMs: 5,
				evidence: [],
			},
		];
		const events = replayEventsFromSteps({
			events: providedEvents,
			steps: [
				{
					index: 0,
					routeStepId: "login",
					block: "crm.auth.loginAsRole",
					version: "1.0.0",
					status: "passed",
					durationMs: 5,
				},
			],
		});
		expect(events).toEqual(providedEvents);
	});
});
