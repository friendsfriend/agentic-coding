import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalPiTools, piSettingsPath } from "../src/workflow/pi-tools.ts";

/** A settings file in a throwaway directory, so a test never reads (or depends
 * on) the machine's real pi configuration. */
function settingsWith(value: unknown): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-"));
	const file = path.join(directory, "settings.json");
	fs.writeFileSync(file, JSON.stringify(value));
	return file;
}

describe("globally configured pi tools", () => {
	test("an addition is handed over with the extension that provides it", () => {
		// The shape a user actually configures: `defaultTools: ["+codemode"]`.
		expect(
			globalPiTools(settingsWith({ defaultTools: ["+codemode"] })),
		).toEqual([{ tool: "codemode", extension: "codemode" }]);
		expect(
			globalPiTools(settingsWith({ defaultTools: ["+tool_search"] })),
		).toEqual([{ tool: "tool_search", extension: "tool-search" }]);
	});

	test("pi's own +- rules decide what survives", () => {
		// A plain name replaces the selection; +name/-name then apply in order, so
		// the removal below wins over the earlier addition.
		expect(
			globalPiTools(
				settingsWith({ defaultTools: ["read", "bash", "+codemode"] }),
			),
		).toEqual([{ tool: "codemode", extension: "codemode" }]);
		expect(
			globalPiTools(settingsWith({ defaultTools: ["+codemode", "-codemode"] })),
		).toEqual([]);
		// A plain-name-only list selects exactly those built-ins: nothing extra.
		expect(
			globalPiTools(settingsWith({ defaultTools: ["read", "bash"] })),
		).toEqual([]);
		// A plain name after an addition resets the selection, dropping the tool.
		expect(
			globalPiTools(settingsWith({ defaultTools: ["+codemode", "read"] })),
		).toEqual([]);
	});

	test("built-in tools and tools without a loadable extension are left out", () => {
		// The profile owns built-ins (the read-only policy and the handoff path
		// depend on `bash`), and a user's own extension file is deliberately not
		// loaded into a managed run, so naming its tool would be a promise the
		// launch cannot keep.
		expect(
			globalPiTools(
				settingsWith({ defaultTools: ["+grep", "+gitlab_mr_comments"] }),
			),
		).toEqual([]);
	});

	test("unreadable, malformed or absent settings contribute nothing", () => {
		// An optional tool must never fail a launch.
		const missing = path.join(
			os.tmpdir(),
			"pi-settings-absent",
			"settings.json",
		);
		expect(globalPiTools(missing)).toEqual([]);
		const broken = settingsWith("not json" as unknown);
		fs.writeFileSync(broken, "{ not json");
		expect(globalPiTools(broken)).toEqual([]);
		expect(globalPiTools(settingsWith({ defaultTools: "codemode" }))).toEqual(
			[],
		);
	});

	test("the settings path follows pi's own agent directory", () => {
		// `PI_CODING_AGENT_DIR` is pi's override; the default is its config dir,
		// and an empty override counts as unset exactly like pi's own resolution.
		expect(piSettingsPath("/tmp/agent")).toBe("/tmp/agent/settings.json");
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = "/tmp/from-env";
			expect(piSettingsPath(undefined)).toBe("/tmp/from-env/settings.json");
			process.env.PI_CODING_AGENT_DIR = "   ";
			expect(
				piSettingsPath(undefined).endsWith(".pi/agent/settings.json"),
			).toBe(true);
			delete process.env.PI_CODING_AGENT_DIR;
			expect(
				piSettingsPath(undefined).endsWith(".pi/agent/settings.json"),
			).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});
