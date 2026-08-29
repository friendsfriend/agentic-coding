import { expect, test } from "bun:test";
import { AGENT_DEFINITIONS } from "../src/workflow/embedded.generated.ts";

test("embedded workflow assets stay outside skill/plugin discovery", () => {
	const names = Object.keys(AGENT_DEFINITIONS);
	expect(names.some((name) => name.includes("SKILL.md"))).toBe(false);
	expect(
		names.every(
			(name) =>
				name.startsWith("instructions/") ||
				name.startsWith("bridges/") ||
				name.startsWith("extensions/"),
		),
	).toBe(true);
	expect(names).toContain("extensions/developer-question.ts");
	expect(names).toContain("bridges/pi-telemetry.ts");
	expect(names).toContain("bridges/opencode-telemetry.js");
	expect(names).toContain("bridges/opencode-v2-telemetry.js");
	for (const bridge of [
		"bridges/pi-telemetry.ts",
		"bridges/opencode-telemetry.js",
		"bridges/opencode-v2-telemetry.js",
	]) {
		const source = AGENT_DEFINITIONS[bridge];
		expect(source).not.toContain("herdr_check");
		expect(source).not.toContain("herdr_handoff");
		expect(source).not.toContain("bwrap");
		expect(source).toContain("HERDR_TELEMETRY_PATH");
		expect(source).toContain("schemaVersion: 1");
		expect(source).toContain("traceparent");
		expect(source).not.toMatch(/herdr\.db|state\.json|nudge|switch.*runtime/i);
	}
	expect(AGENT_DEFINITIONS["bridges/pi-telemetry.ts"]).toContain(
		"emit('runtime.started'",
	);
});
