// add-pi-durable-runtime 6.5: the Settings profile editor offers `pi-durable`
// as a runtime choice with the same pi-shaped fields (thinking, no `agent`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	profileDraft,
	profileFields,
	RUNTIMES,
} from "../src/tui/settings/agentPresets.ts";

// A pane runtime's model field is built by enumerating that runtime through its
// CLI (`opencode models`; a durable profile enumerates nothing at all). A stub
// keeps this file hermetic instead of spawning the developer's own `opencode`
// (see test/settings/agentPresets.test.ts for the same stubs).
const ORIGINAL_PATH = process.env.PATH;
let runtimeBin = "";

beforeAll(() => {
	runtimeBin = fs.mkdtempSync(
		path.join(os.tmpdir(), "agent-host-settings-bin-"),
	);
	fs.writeFileSync(
		path.join(runtimeBin, "opencode"),
		["#!/bin/sh", "echo 'stub/opencode-one'"].join("\n"),
		{ mode: 0o700 },
	);
	process.env.PATH = [runtimeBin, ORIGINAL_PATH ?? ""].join(path.delimiter);
});

afterAll(() => {
	if (ORIGINAL_PATH === undefined) delete process.env.PATH;
	else process.env.PATH = ORIGINAL_PATH;
	fs.rmSync(runtimeBin, { recursive: true, force: true });
});

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
		// A durable model's choices are the configured providers' models the view
		// resolved in process. With none supplied the field stays free text rather
		// than enumerating a runtime: the bundled runtime has no model CLI.
		expect(fields.find((field) => field.key === "model")?.kind).toBe("text");
	});
});
