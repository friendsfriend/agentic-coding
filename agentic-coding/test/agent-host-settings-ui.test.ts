// add-pi-durable-runtime 6.5: the Settings profile editor offers `pi-durable`
// as a runtime choice with the same pi-shaped fields (thinking, no `agent`).
import { describe, expect, test } from "bun:test";
import {
	profileDraft,
	profileFields,
	RUNTIMES,
} from "../src/tui/settings/agentPresets.ts";

describe("pi-durable in the Settings profile editor", () => {
	test("is offered as a runtime choice", () => {
		expect(RUNTIMES).toContain("pi-durable");
	});

	test("offers a thinking level and no agent-name field, like pi", () => {
		const draft = profileDraft("durable-profile", { runtime: "pi-durable" });
		const fields = profileFields(draft);
		const keys = fields.map((field) => field.key);
		expect(keys).toContain("thinking");
		expect(keys).not.toContain("agent");
	});

	test("opencode still gets an agent-name field and no thinking level", () => {
		const draft = profileDraft("opencode-profile", { runtime: "opencode" });
		const fields = profileFields(draft);
		const keys = fields.map((field) => field.key);
		expect(keys).toContain("agent");
		expect(keys).not.toContain("thinking");
	});
});
