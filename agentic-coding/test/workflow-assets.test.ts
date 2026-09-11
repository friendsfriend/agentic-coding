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
	expect(AGENT_DEFINITIONS["extensions/developer-question.ts"]).not.toContain(
		"Bun.",
	);
	expect(AGENT_DEFINITIONS["extensions/developer-question.ts"]).toContain(
		'from "node:child_process"',
	);
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

test("embedded bridges carry the enriched payload hooks and dropped noise", () => {
	const pi = AGENT_DEFINITIONS["bridges/pi-telemetry.ts"];
	for (const hook of [
		"agent_start",
		"tool_execution_start",
		"tool_execution_end",
		"before_provider_request",
		"after_provider_response",
		"turn_start",
		"turn_end",
		"session_before_compact",
		"session_compact",
		"model_select",
		"agent_settled",
	])
		expect(pi).toContain(`'${hook}'`);
	// Streaming updates are deliberately unwired (task 4.8).
	expect(pi).not.toContain("'tool_execution_update'");
	expect(pi).not.toContain("'message_update'");
	for (const key of [
		"pi.tool.duration_ms",
		"pi.provider.status",
		"pi.model",
		"pi.context.percent",
		"pi.session.input_tokens",
		"sessionId",
	])
		expect(pi).toContain(key);

	for (const bridge of [
		"bridges/opencode-telemetry.js",
		"bridges/opencode-v2-telemetry.js",
	]) {
		const source = AGENT_DEFINITIONS[bridge];
		for (const marker of [
			"message.part.updated",
			"step-finish",
			"permission.asked",
			"todo.updated",
			"session.diff",
			"file.watcher",
			"oc.tool.duration_ms",
		])
			expect(source).toContain(marker);
	}
});
