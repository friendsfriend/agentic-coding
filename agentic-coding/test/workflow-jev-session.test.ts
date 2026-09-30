import { describe, expect, test } from "bun:test";
import { jevSessionBinding } from "../src/workflow/classifier-runner.ts";
import type { AgentsConfig } from "../src/workflow/profiles.ts";

const LOCAL: AgentsConfig = {
	profiles: {},
	classifier: { provider: "laya-local" },
};
const HOSTED: AgentsConfig = {
	profiles: {},
	classifier: { provider: "opencode-zen" },
};
const TARGET = {
	url: "http://127.0.0.1:9/v1/systemone",
	headers: { "Content-Type": "application/json" },
	model: "laya-system-one",
};

describe("in-session Jev binding", () => {
	test("a hosted provider never reaches a pane", () => {
		// Its credential belongs to another process, so no binding is built even
		// when the target would resolve.
		expect(jevSessionBinding(HOSTED, undefined, () => TARGET)).toBeUndefined();
	});

	test("a pinned provider outranks the configured one", () => {
		expect(
			jevSessionBinding(HOSTED, "laya-local", () => TARGET),
		).not.toBeUndefined();
		expect(
			jevSessionBinding(LOCAL, "opencode-zen", () => TARGET),
		).toBeUndefined();
	});

	test("a sidecar that is not running yields no binding, never a stale endpoint", () => {
		expect(
			jevSessionBinding(LOCAL, undefined, () => {
				throw new Error("classifier laya-local is not running");
			}),
		).toBeUndefined();
	});

	test("the binding carries the transport and nothing that would fix a question", () => {
		// The tool is general: the agent writes the questions. A question, a
		// threshold, or a conventions preamble in the binding would tie every call
		// to the file-judgment use the engine-side sweep already owns.
		expect(jevSessionBinding(LOCAL, undefined, () => TARGET)).toEqual({
			provider: "laya-local",
			model: "laya-system-one",
			endpoint: "http://127.0.0.1:9/v1/systemone",
		});
	});

	test("the model reported is the sidecar's own, not the configured id", () => {
		// The local provider always answers with its own model id, so the pane is
		// told what the sidecar will actually be asked for.
		const binding = jevSessionBinding(LOCAL, undefined, () => ({
			...TARGET,
			model: "laya-system-one",
		}));
		expect(binding?.model).toBe("laya-system-one");
	});
});
