import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentSessionToolCall } from "../../src/tui/dash/agent-session.ts";
import {
	customToolNames,
	customToolView,
} from "../../src/tui/dash/ui/custom-tool-views.ts";
import {
	contentRows,
	safeToolValue,
	valueRows,
} from "../../src/tui/dash/ui/tool-content.ts";
import {
	type ToolView,
	type ToolViewRow,
	toolPendingView,
	toolView,
} from "../../src/tui/dash/ui/tool-views.ts";

function call(
	name: string,
	args: Record<string, unknown>,
	value?: unknown,
): AgentSessionToolCall {
	return {
		name,
		args,
		...(value === undefined
			? {}
			: {
					result: {
						lines: [JSON.stringify(value)],
						details: { view: value },
						notes: [],
						isError: false,
					},
				}),
	};
}
function rows(view: ToolView): readonly ToolViewRow[] {
	return [
		...(view.rows ?? []),
		...(view.sections ?? []).flatMap((section) => section.rows),
	];
}

describe("custom tool families", () => {
	test("every directly registered custom tool has a family presenter", () => {
		const native = new Set([
			"read",
			"write",
			"edit",
			"bash",
			"codemode",
			"ask_jev",
			"developer_question",
			"agent_ask",
		]);
		const covered = new Set(customToolNames);
		for (const file of [
			"tools",
			"environment-tools",
			"browser-tools",
			"debug-tools",
			"stage-tools",
			"orchestrator",
		]) {
			const source = readFileSync(
				new URL(`../../src/agent-host/${file}.ts`, import.meta.url),
				"utf8",
			);
			for (const match of source.matchAll(
				/defineTool\(\{\s*name:\s*"([a-z_]+)"/g,
			)) {
				const name = match[1] ?? "";
				expect(
					native.has(name) || covered.has(name),
					`missing presenter for ${name}`,
				).toBe(true);
			}
		}
	});
	for (const name of customToolNames)
		test(`${name} has a complete and in-progress presentation`, () => {
			const input = call(
				name,
				{
					app: "demo",
					path: "/api/example",
					code: "return 1;",
					sql: "select 1",
					workflowId: "wf-1",
				},
				{ status: "ready", customField: "retained" },
			);
			const view = toolView(input);
			expect(view?.label).toBeTruthy();
			expect(view?.icon).toBeTruthy();
			expect(JSON.stringify(view)).toContain("retained");
			expect(toolPendingView({ name, args: input.args }).icon).toBeTruthy();
		});
	test("search groups matches by file and retains diagnostics and unmatched output", () => {
		const view = customToolView({
			name: "grep",
			args: { path: "src", pattern: "needle" },
			result: {
				lines: [
					"src/a.ts:12:const needle = 1;",
					"src/b.ts:4:needle();",
					"… stopped early",
				],
				notes: ["bounded by host"],
				isError: false,
			},
		});
		expect(view.label).toBe("Search “needle”");
		expect(view.hint).toContain("2 files · 2 matches");
		expect(view.sections?.map((section) => section.label)).toEqual([
			"src/a.ts",
			"src/b.ts",
			"Diagnostics",
		]);
		expect(view.sections?.[0]?.rows[0]).toMatchObject({
			text: "const needle = 1;",
			lineNumber: 12,
			highlight: "needle",
		});
		expect(view.rows?.[0]?.text).toContain("stopped early");
	});
	test("HTTP separates request, response headers, body and metadata without losing status", () => {
		const view = customToolView(
			call(
				"http_request",
				{
					method: "post",
					path: "/api/check",
					headers: { authorization: "secret-value" },
				},
				{
					status: 404,
					statusText: "Not Found",
					body: '{"message":"missing"}',
					headers: { "set-cookie": "private-cookie" },
					bytes: 12,
					truncated: true,
				},
			),
		);
		expect(view.label).toBe("POST /api/check");
		expect(view.rows?.[0]?.tone).toBe("error");
		expect(
			view.sections?.find((section) => section.id === "body")?.rows[0]?.syntax,
		).toBe("json");
		expect(JSON.stringify(view)).not.toContain("secret-value");
		expect(JSON.stringify(view)).not.toContain("private-cookie");
		expect(JSON.stringify(view)).toContain("Truncated: true");
	});
	test("SQL keeps source, real column names, nulls and all rows", () => {
		const view = customToolView(
			call(
				"db_query",
				{
					infra: "postgres",
					schema: "public",
					sql: "select id, note from notes",
				},
				{
					database: "demo",
					columns: ["id", "note"],
					rows: [
						[1, null],
						[2, "x".repeat(400)],
					],
					truncated: false,
				},
			),
		);
		expect(
			view.sections?.find((section) => section.id === "sql")?.rows[0]?.syntax,
		).toBe("sql");
		const table = view.sections?.find((section) => section.id === "results")
			?.rows[0]?.table;
		expect(table?.columns).toEqual(["id", "note"]);
		expect(table?.rows[0]).toEqual(["1", "null"]);
		expect(table?.rows[1]?.[1]).toHaveLength(400);
	});
	test("environment actions render logs, exit code and domain failures", () => {
		const view = customToolView(
			call(
				"env_test",
				{ app: "demo" },
				{
					status: "failed",
					exitCode: 1,
					output: "first\n\n  final",
					targetId: "unit",
					truncated: false,
				},
			),
		);
		expect(view.shell).toBe(true);
		expect(view.failed).toBe(true);
		expect(view.rows?.map((row) => row.text)).toEqual(["first", "", "  final"]);
		expect(view.hint).toContain("exit 1");
	});
	test("environment output can change without a text chunk arriving", () => {
		const view = toolPendingView({
			name: "env_build",
			args: { app: "demo" },
			progress: {
				view: { status: "running", output: "building now", targetId: "build" },
			},
		});
		expect(view.rows?.[0]?.text).toBe("building now");
	});
	test("browser scripts use source and shell output components", () => {
		const view = customToolView(
			call(
				"browser_run_script",
				{ code: "return page.title();", session: "s-1" },
				{ output: "console output", result: "Title", evidenceId: "e-1" },
			),
		);
		expect(
			view.sections?.find((section) => section.id === "code")?.rows[0]?.syntax,
		).toBe("javascript");
		expect(
			view.sections?.find((section) => section.id === "output")?.shell,
		).toBe(true);
		expect(JSON.stringify(view)).toContain("e-1");
	});
	test("browser observations retain page identity, refs and unknown fields", () => {
		const view = customToolView(
			call(
				"browser_snapshot",
				{ session: "s-1" },
				{
					url: "https://example.test",
					title: "Example",
					snapshotId: "snap-1",
					observation: '[e1] button "Sign in"',
					version: 2,
				},
			),
		);
		expect(view.hint).toContain("snap-1");
		expect(JSON.stringify(view)).toContain("[e1]");
		expect(JSON.stringify(view)).toContain("Version: 2");
	});
	test("form fill values and credential fields are never echoed", () => {
		const view = customToolView(
			call(
				"browser_fill",
				{ selector: "#password", value: "very-private" },
				{ status: "ok" },
			),
		);
		expect(JSON.stringify(view)).not.toContain("very-private");
		expect(
			safeToolValue({
				nested: { accessToken: "private", password: "private" },
				count: 3,
			}),
		).toEqual({
			nested: { accessToken: "[redacted]", password: "[redacted]" },
			count: 3,
		});
	});
	test("request URLs, JSON bodies, numeric secrets and positional SQL credentials are redacted", () => {
		const safe = safeToolValue({
			url: "https://user:private-user-password@example.test/path?access_token=private-token",
			body: '{"password":"private-body-password"}',
			password: 123456,
			headers: { "X-API-Key": "private-key" },
		});
		const text = JSON.stringify(safe);
		for (const secret of [
			"private-user-password",
			"private-token",
			"private-body-password",
			"123456",
			"private-key",
		])
			expect(text).not.toContain(secret);
		const view = customToolView(
			call(
				"db_query",
				{ infra: "db", sql: "select token from sessions" },
				{ columns: ["token"], rows: [["private-database-token"]] },
			),
		);
		expect(JSON.stringify(view)).not.toContain("private-database-token");
	});
	test("failed transports retain the last live action log and diagnostics", () => {
		const view = customToolView({
			name: "env_test",
			args: { app: "demo" },
			result: {
				lines: ["connection lost"],
				notes: ["interrupted"],
				isError: true,
				details: { view: { output: "partial log", targetId: "unit" } },
			},
		});
		expect(view.failed).toBe(true);
		expect(
			view.sections?.find((section) => section.id === "output")?.shell,
		).toBe(true);
		for (const value of [
			"partial log",
			"connection lost",
			"interrupted",
			"unit",
		])
			expect(JSON.stringify(view)).toContain(value);
	});
	test("stage executions retain each returned step as an independent component", () => {
		const view = customToolView(
			call(
				"stage_replay",
				{ flow: "login" },
				{
					steps: [
						{ name: "Sign in", status: "passed", durationMs: 12 },
						{ name: "Load page", status: "failed", error: "timed out" },
					],
					snapshotId: "s-1",
				},
			),
		);
		expect(
			view.sections
				?.filter((section) => section.id.startsWith("step:"))
				.map((section) => section.tone),
		).toEqual(["success", "error"]);
		expect(JSON.stringify(view)).toContain("timed out");
		expect(JSON.stringify(view)).toContain("s-1");
	});
	test("unknown tools keep structured arguments and syntax-highlight valid JSON", () => {
		const view = customToolView({
			name: "future_tool",
			args: { target: "target-1", customInput: 1 },
			result: {
				lines: ['{"newField":"new value"}'],
				notes: [],
				isError: false,
			},
		});
		expect(view.label).toBe("Future tool target-1");
		expect(JSON.stringify(rows(view))).toContain("new value");
		expect(contentRows('{"hello":1}')[0]?.syntax).toBe("json");
	});
	test("reports use markdown and traces retain nested span identity", () => {
		const report = customToolView(
			call(
				"debug_result",
				{ requestId: "r-1" },
				{
					status: "completed",
					report: "# Finding\n\nThe request failed.",
					evidence: ["e-1"],
				},
			),
		);
		expect(report.sections?.[0]?.rows[0]?.markdown).toBe(true);
		const trace = customToolView(
			call(
				"otel_query",
				{ traceId: "t-1" },
				{
					name: "request",
					spanId: "root",
					durationMs: 12,
					children: [
						{ name: "SQL", spanId: "child", durationMs: 4, children: [] },
					],
				},
			),
		);
		expect(JSON.stringify(trace)).toContain("child");
		expect(trace.rows?.[0]?.detail).toBeDefined();
	});
	test("generic record tables preserve different columns and nested values", () => {
		const table = valueRows([
			{ name: "one", extra: { id: 1 } },
			{ name: "two", status: "ready" },
		])[0]?.table;
		expect(table?.columns).toEqual(["name", "extra", "status"]);
		expect(table?.rows[0]?.[1]).toBe('{"id":1}');
		expect(table?.rows[1]?.[1]).toBe("—");
	});
	test("questions and judgments retain long source and all distribution entries", () => {
		const question = `${"full question ".repeat(40)}last question word`;
		const dialogue = toolView({
			name: "developer_question",
			args: { description: question },
		});
		expect(dialogue?.summary).toBe(question);
		expect(dialogue?.compactLabel?.length).toBeLessThanOrEqual(160);
		const view = toolView({
			name: "ask_jev",
			args: {
				questions: { verdict: { type: "choice", instructions: question } },
			},
			result: {
				lines: [],
				notes: [],
				isError: false,
				details: {
					answers: {
						verdict: {
							choice: "label0",
							confidence: 0.9,
							probabilities: Object.fromEntries(
								Array.from({ length: 10 }, (_, index) => [
									`label${index}`,
									0.1,
								]),
							),
							explanation: "complete explanation",
						},
					},
				},
			},
		});
		const judgment = view?.sections?.find(
			(section) => section.id === "judgment:verdict",
		);
		expect(judgment?.rows[0]?.text).toBe(question);
		expect(JSON.stringify(judgment)).toContain("label9");
		expect(JSON.stringify(judgment)).toContain("complete explanation");
	});
});
