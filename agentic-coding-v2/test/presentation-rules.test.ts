// Pure presentation and configuration rules: no renderer, runtime, gateway or
// engine. These replace the screenshots-and-stack tests that used to prove them.
import { expect, test } from "bun:test";
import { readKubernetes } from "../src/environment/kubernetes-config.ts";
import type { Session } from "../src/protocol/index.ts";
import { followUpSession } from "../src/session-access.ts";
import { bulkFold, foldAll } from "../src/tui/features/sessions/card-folds.ts";
import {
	customToolBody,
	safeToolValue,
} from "../src/tui/features/sessions/custom-tool-view.ts";
import {
	activeContextTokens,
	lastAssistantMessage,
	promptMeter,
	runningCompaction,
} from "../src/tui/features/sessions/prompt-meter.ts";
import {
	toolIcon,
	toolPresentation,
} from "../src/tui/features/sessions/tool-presentation.ts";
import {
	assistantFailure,
	generationSpeed,
	modelLabel,
	turnStats,
} from "../src/tui/features/sessions/turn-stats.ts";
import {
	formatCallDuration,
	formatCost,
	formatTokenCount,
} from "../src/tui/presentation/components/transcriptFormat.ts";

test("token counts and costs render in the compact transcript form", () => {
	expect(formatTokenCount(0)).toBe("0");
	expect(formatTokenCount(999)).toBe("999");
	expect(formatTokenCount(12_340)).toBe("12.3K");
	expect(formatTokenCount(999_999)).toBe("1000.0K");
	expect(formatTokenCount(1_234_567)).toBe("1.2M");
	expect(formatCost(0)).toBe("$0.00");
	expect(formatCost(0.004)).toBe("<$0.01");
	expect(formatCost(0.01)).toBe("$0.01");
	expect(formatCost(1.239)).toBe("$1.24");
	expect(formatCallDuration(950)).toBe("950ms");
	expect(formatCallDuration(4200)).toBe("4.2s");
	expect(formatCallDuration(95_000)).toBe("1m 35s");
});

test("one footer per input sums only recorded usage and names every model", () => {
	const messages = [
		{ identity: 1, role: "user", text: "go" },
		{
			identity: 2,
			role: "assistant",
			provider: "anthropic",
			model: "a",
			usage: { cost: { total: 0.01 }, input: 1000, output: 200 },
		},
		{ identity: 3, role: "toolResult", toolName: "read" },
		{
			identity: 4,
			role: "assistant",
			provider: "anthropic",
			model: "b",
			usage: { cost: { total: 0.02 }, input: 2000, output: 300 },
		},
		{ identity: 5, role: "user", text: "again" },
		{
			identity: 6,
			role: "assistant",
			provider: "openai",
			model: "c",
			usage: { cost: { total: Number.NaN }, input: -1, output: 40 },
		},
	] as never[];
	const stats = turnStats(messages);
	// The footer belongs to the group's last rendered message, not the response.
	expect(stats.get("4")).toMatchObject({
		cost: 0.03,
		input: 3000,
		output: 500,
		responses: 2,
		models: ["anthropic/a", "anthropic/b"],
	});
	expect(stats.has("2")).toBe(false);
	// Non-finite and negative recordings are omitted, never estimated.
	expect(stats.get("6")).toMatchObject({ responses: 1, output: 40 });
	expect(stats.get("6")?.cost).toBeUndefined();
	expect(stats.get("6")?.input).toBeUndefined();
	// The label is a quoted, bounded string so it can never look like two fields.
	expect(modelLabel(["anthropic/a"])).toBe('"anthropic/a"');
	expect(modelLabel([])).toBe("not supplied");
	expect(Array.from(modelLabel(["m".repeat(200)])).length).toBe(101);
});

test("a Kubernetes pod target refuses what the chart or the operator owns", () => {
	const base = {
		cluster: "local",
		namespace: "fixtures",
		image: "fixture:latest",
	};
	expect(readKubernetes(base)).toMatchObject({ namespace: "fixtures" });
	for (const invalid of [
		{ ...base, namespace: "default" },
		{ ...base, namespace: "kube-system" },
		{ ...base, namespace: "Fixtures" },
		{ ...base, cluster: "1local" },
		{ ...base, environment: { A: "b" } },
		{ ...base, secretRefs: { A: "B" } },
		{ ...base, workload: "helm-release-v1", image: undefined },
	])
		expect(() => readKubernetes(invalid)).toThrow(/Kubernetes|Helm release/);
	// A forward must be one loopback port per replica, never a pod picker.
	expect(
		readKubernetes({
			...base,
			portForwards: [{ local: 10_000, remote: 5432 }],
		}),
	).toMatchObject({ portForwards: [{ local: 10_000, replica: 0 }] });
	for (const forwards of [
		[{ local: 0, remote: 5432 }],
		[{ local: 8080, remote: 0 }],
		[
			{ local: 8080, remote: 5432 },
			{ local: 8080, remote: 6379 },
		],
		[{ local: 8080, remote: 5432, replica: 2 }],
	])
		expect(() => readKubernetes({ ...base, portForwards: forwards })).toThrow(
			/Kubernetes|forward/,
		);
});

// The prompt footer reports the active context against the model's own window;
// it never invents either, and the window totals stay visibly separate.
test("the prompt meter reports context, cost and window tokens in that order", () => {
	expect(
		promptMeter({
			contextTokens: 63_900,
			contextWindow: 1_000_000,
			cost: 0.01,
			input: 1200,
			output: 300,
		}),
	).toBe("63.9K (6%) · $0.01 · tok 1.2K→300");
	// No catalogued window: the percentage is omitted, the size is not.
	expect(
		promptMeter({ contextTokens: 8100, contextWindow: null, cost: 0 }),
	).toBe("8.1K · $0.00");
	// Nothing recorded reports nothing rather than a zero.
	expect(promptMeter({})).toBe("");
	expect(promptMeter({ cost: 0.002 })).toBe("<$0.01");
});

test("the active context is the newest generation's prompt, cache included", () => {
	const entries = [
		{ id: 1, model: [{ role: "assistant", usage: { input: 10 } }] },
		{ id: 2, model: [{ role: "user" }] },
		{
			id: 3,
			model: [
				{ role: "assistant", usage: { input: 4000 } },
				{ role: "toolResult" },
				{
					role: "assistant",
					usage: { input: 400, cacheRead: 3600, cacheWrite: 40 },
				},
			],
		},
		// A trailing entry with no usage cannot hide the last recorded one.
		{ id: 4, model: [{ role: "assistant" }] },
	];
	expect(activeContextTokens(entries)).toBe(4040);
	expect(activeContextTokens([{ id: 1, model: [{ role: "user" }] }])).toBe(
		undefined,
	);
	// A zero total is not a context size.
	expect(
		activeContextTokens([
			{ id: 1, model: [{ role: "assistant", usage: { input: 0 } }] },
		]),
	).toBe(undefined);
});

// The footer's last two segments: the completed generation's own rate and a
// compaction the session is running, in the original order and wording.
test("the prompt meter reports the recorded rate and a running compaction", () => {
	expect(
		promptMeter({
			contextTokens: 63_900,
			contextWindow: 200_000,
			cost: 0.01,
			input: 1200,
			output: 300,
			tokensPerSecond: 42.7,
			compacting: { reason: "manual" },
		}),
	).toBe(
		"63.9K (32%) · $0.01 · tok 1.2K→300 · 42.7 tok/s · compacting (manual)",
	);
	// Any other supplied reason reads as the automatic one, and a supplied retry
	// error adds the retrying marker; the error text itself stays out of the meter.
	expect(
		promptMeter({
			compacting: { reason: "threshold", retrying: true },
		}),
	).toBe("compacting (automatic, retrying)");
	// An unusable rate adds nothing at all; a supplied zero still prints, because
	// the producer only records a rate it measured.
	expect(promptMeter({ tokensPerSecond: Number.NaN })).toBe("");
	expect(promptMeter({ tokensPerSecond: 0 })).toBe("0 tok/s");
});

test("the rate pairs one message's output with its own recorded duration", () => {
	const completed = {
		role: "assistant",
		usage: { output: 300 },
		durationMs: 7000,
	};
	expect(generationSpeed(completed)).toBe(42.9);
	// A partial has no duration yet, and an unrecorded duration is not a rate.
	expect(generationSpeed({ role: "assistant", usage: { output: 300 } })).toBe(
		undefined,
	);
	expect(generationSpeed({ ...completed, durationMs: 0 })).toBe(undefined);
	expect(
		generationSpeed({ ...completed, usage: { output: 0 }, durationMs: 5000 }),
	).toBe(undefined);
	expect(generationSpeed(undefined)).toBe(undefined);
	// The reading comes from the newest assistant message, never from a tool
	// result or a user turn that follows it.
	expect(
		lastAssistantMessage([
			{ id: 1, model: [{ role: "assistant", usage: { input: 5 } }] },
			{
				id: 2,
				model: [
					{
						role: "assistant",
						usage: { input: 10, output: 20 },
						durationMs: 1000,
					},
					{ role: "toolResult" },
				],
			},
			{ id: 3, model: [{ role: "user" }] },
		]),
	).toMatchObject({ durationMs: 1000 });
	expect(lastAssistantMessage([{ id: 1, model: [{ role: "user" }] }])).toBe(
		undefined,
	);
});

test("a compaction is running only while a supplied record says so", () => {
	expect(runningCompaction([])).toBe(undefined);
	expect(runningCompaction(undefined)).toBe(undefined);
	// A record without a reason cannot name what is running.
	expect(runningCompaction([{ taskId: 9 }])).toBe(undefined);
	expect(runningCompaction([{ taskId: 9, reason: "manual" }])).toEqual({
		reason: "manual",
	});
	// The first supplied record is the one running; a retry error is only a
	// marker, never the message the footer prints.
	expect(
		runningCompaction([
			{ taskId: 9, reason: "threshold", retry: { error: "rate limited" } },
			{ taskId: 10, reason: "manual" },
		]),
	).toEqual({ reason: "threshold", retrying: true });
	expect(
		runningCompaction([{ taskId: 9, reason: "manual", retry: {} }]),
	).toEqual({ reason: "manual" });
});

// v1 gave each tool family its own line; v2's own families (orchestrator,
// environment, evidence, scheduling) were named twice and had no icon at all.
test("a tool family is named by what it does and what it does it to", () => {
	// Families with a bespoke body keep their own header.
	for (const name of [
		"read",
		"write",
		"edit",
		"bash",
		"codemode",
		// Both shells are named by the card itself: the runtime registers
		// `powershell` beside `bash` with the same command/timeout shape.
		"powershell",
	])
		expect(toolPresentation(name, {}, "done")).toBe(null);
	// A started task names the skill it runs and the checkout it runs in; an
	// unreturned call is never spelled as a completed one.
	expect(
		toolPresentation(
			"start_task",
			{
				skill: "review-runner",
				repository: "agentic-coding",
				workspace: "worktree" as const,
			},
			"pending",
		),
	).toEqual({
		label: "Starting review-runner",
		hint: "agentic-coding · own worktree",
	});
	expect(
		toolPresentation("start_task", { skill: "review-runner" }, "done"),
	).toEqual({ label: "Started review-runner" });
	// One action tool, five actions: the row names the action that was asked for,
	// on the apps it names, and spells a returned call as completed.
	for (const [action, pending, done] of [
		["run", "Starting", "Started"],
		["build", "Building", "Built"],
		["test", "Testing", "Tested"],
		["stop", "Stopping", "Stopped"],
	] as const) {
		const args = { apps: ["api", "web"], action, runtime: "docker" };
		expect(toolPresentation("environment_action", args, "pending")).toEqual({
			label: `${pending} api, web`,
			hint: "docker",
		});
		expect(toolPresentation("environment_action", args, "done")).toEqual({
			label: `${done} api, web`,
			hint: "docker",
		});
	}
	// A single app has one name, and a queue continuation names its acquisition.
	expect(
		toolPresentation(
			"environment_action",
			{ action: "build", app: "api" },
			"done",
		),
	).toEqual({ label: "Built api" });
	expect(
		toolPresentation(
			"environment_action",
			{ action: "wait", acquisition: "acq-1" },
			"pending",
		),
	).toEqual({ label: "Waiting for", hint: "acq-1" });
	// Diagnostics name their verb and path; SQL keeps its own line and names the
	// database it runs against.
	expect(
		toolPresentation(
			"env_http_request",
			{ app: "gateway", endpoint: "web", method: "post", path: "/v1/x" },
			"done",
		),
	).toEqual({ label: "POST /v1/x", hint: "gateway · web" });
	expect(
		toolPresentation("env_http_request", { app: "gateway" }, "pending"),
	).toEqual({ label: "GET", hint: "gateway" });
	expect(
		toolPresentation(
			"db_query",
			{ infra: "primary", sql: "\n  select 1\n  from dual" },
			"done",
		),
	).toEqual({ label: "SQL · primary", hint: "select 1" });
	// Everything else states its own name and target once: never the name twice,
	// never an argument the call did not supply.
	expect(toolPresentation("frobnicate", {}, "done")).toEqual({
		label: "frobnicate",
	});
	expect(
		toolPresentation("task", { description: "Read the logs" }, "done"),
	).toEqual({ label: "task", hint: "Read the logs" });
	// Evidence names the file it retained and keeps the caption as its
	// description, bounded like every other supplied label.
	expect(
		toolPresentation(
			"attach_evidence",
			{ path: "out/run.log", caption: "x".repeat(400) },
			"done",
		),
	).toEqual({ label: "Attached out/run.log", hint: `${"x".repeat(89)}…` });
});

test("every family is recognised by an icon, named ones exactly", () => {
	expect(toolIcon("read")).toBe("→");
	expect(toolIcon("start_task")).toBe("▷");
	expect(toolIcon("env_start")).toBe("⚙");
	expect(toolIcon("env_cluster_status")).toBe("☸");
	expect(toolIcon("env_http_request")).toBe("⚙");
	expect(toolIcon("powershell")).toBe(">");
	expect(toolIcon("otel_query")).toBe("≋");
	expect(toolIcon("frobnicate")).toBe("•");
});

// A family whose result has structure gets the reading its payload deserves:
// matches grouped by file, a response's status and headers, a query's columns.
test("a search groups its matches by file and counts them", () => {
	const body = customToolBody({
		name: "grep",
		args: { pattern: "needle", path: "src" },
		text: [
			"src/a.ts:12:const needle = 1;",
			"src/a.ts:40:needle again",
			"src/b.ts:7:  needle",
			"binary file matches",
		].join("\n"),
		details: null,
		failed: false,
		pending: false,
	});
	expect(body?.label).toBe("Search “needle”");
	expect(body?.hint).toBe("src · 2 files · 3 matches");
	expect(body?.sections.map((section) => section.label)).toEqual([
		"src/a.ts",
		"src/b.ts",
	]);
	expect(body?.sections[0]?.rows).toEqual([
		{ text: "const needle = 1;", lineNumber: 12, highlight: "needle" },
		{ text: "needle again", lineNumber: 40, highlight: "needle" },
	]);
	// A line the pattern does not explain is not turned into a match.
	expect(body?.rows).toEqual([{ text: "binary file matches" }]);
});

test("an HTTP result reports its status, headers and body", () => {
	const body = customToolBody({
		name: "env_http_request",
		args: {
			app: "gateway",
			endpoint: "web",
			method: "post",
			path: "/v1/x",
			authorization: "hunter2",
		},
		text: "",
		details: {
			view: {
				status: 404,
				statusText: "Not Found",
				durationMs: 12,
				url: "https://x.test/v1/x?token=abc",
				headers: {
					"content-type": "application/json",
					authorization: "hunter2",
				},
				body: '{"error":"missing"}',
			},
		},
		failed: false,
		pending: false,
	});
	expect(body?.label).toBe("POST /v1/x");
	// The target is the app/endpoint pair the request was approved for; the
	// response's own status is a row, not a duplicated hint.
	expect(body?.hint).toBe("gateway · web");
	expect(body?.rows).toEqual([{ text: "HTTP 404 Not Found", tone: "error" }]);
	const headers = body?.sections.find((section) => section.id === "headers");
	expect(headers?.rows).toEqual([
		{ text: "Content type: application/json" },
		{ text: "Authorization: [redacted]" },
	]);
	// A body that is JSON is drawn as JSON, and the request section keeps only
	// what the verb and path do not already say.
	expect(body?.sections.find((section) => section.id === "body")).toEqual({
		id: "body",
		label: "Response body",
		shell: true,
		rows: [{ text: '{\n  "error": "missing"\n}', syntax: "json" }],
	});
	// The request keeps what the label and hint do not already say, and a
	// credential-named argument is never drawn.
	expect(
		body?.sections.find((section) => section.id === "request")?.rows,
	).toEqual([{ text: "App: gateway" }, { text: "Authorization: [redacted]" }]);
});

test("a request's own payload and an omitted response body are named as such", () => {
	const body = customToolBody({
		name: "env_http_request",
		args: {
			app: "gateway",
			endpoint: "web",
			method: "POST",
			path: "/v1/orders",
			headers: { "content-type": "application/json", cookie: "session=1" },
			body: '{"sku":"A-1"}',
			allowWrite: true,
			followRedirects: false,
		},
		text: "",
		details: {
			view: {
				status: 201,
				statusText: "Created",
				bodyFormat: "omitted",
				headers: { "content-type": "application/pdf" },
			},
		},
		failed: false,
		pending: false,
	});
	expect(body?.label).toBe("POST /v1/orders");
	expect(body?.rows).toEqual([{ text: "HTTP 201 Created", tone: "success" }]);
	expect(
		body?.sections.find((section) => section.id === "request-headers")?.rows,
	).toEqual([
		{ text: "Content type: application/json" },
		{ text: "Cookie: [redacted]" },
	]);
	expect(
		body?.sections.find((section) => section.id === "request-body"),
	).toEqual({
		id: "request-body",
		label: "Request body",
		shell: true,
		rows: [{ text: '{\n  "sku": "A-1"\n}', syntax: "json" }],
	});
	// The authority flags that made the write legal are drawn, not implied.
	expect(
		body?.sections.find((section) => section.id === "request")?.rows,
	).toEqual([
		{ text: "App: gateway" },
		{ text: "Allow Write: true" },
		{ text: "Follow Redirects: false" },
	]);
	// A response body that was not returned as UTF-8 text says so instead of
	// presenting an empty answer as an empty body.
	expect(body?.sections.find((section) => section.id === "body")).toEqual({
		id: "body",
		label: "Response body",
		shell: false,
		rows: [{ text: "Omitted: not UTF-8 text, or encoded", tone: "warning" }],
	});
});

test("a query renders its columns and rows as a table, in supplied order", () => {
	const body = customToolBody({
		name: "db_query",
		args: { infra: "primary", sql: "select id, name from installers" },
		text: "",
		details: {
			view: {
				columns: ["id", "name"],
				rows: [
					[1, "alpha"],
					[2, "beta"],
				],
			},
		},
		failed: false,
		pending: false,
	});
	expect(body?.label).toBe("Query primary");
	expect(body?.hint).toBe("2 rows");
	expect(
		body?.sections.find((section) => section.id === "results")?.rows,
	).toEqual([
		{
			text: "",
			table: {
				columns: ["id", "name"],
				rows: [
					["1", "alpha"],
					["2", "beta"],
				],
			},
		},
	]);
	// The statement itself keeps its own syntax under its own section.
	expect(body?.sections.find((section) => section.id === "sql")?.rows).toEqual([
		{ text: "select id, name from installers", syntax: "sql" },
	]);
});

test("a failed call is an error envelope, never a domain result", () => {
	const body = customToolBody({
		name: "env_logs",
		args: { app: "api" },
		text: "boom",
		details: null,
		failed: true,
		pending: false,
	});
	expect(body?.sections.map((section) => section.id)).toContain("error");
	expect(
		body?.sections.find((section) => section.id === "error")?.rows[0]?.tone,
	).toBe("error");
	// Logs keep their lines whole, with the exit code only when it was recorded.
	const logs = customToolBody({
		name: "env_logs",
		args: { app: "api" },
		text: "",
		details: {
			view: { output: "line one\nline two", exitCode: 2, status: "failed" },
		},
		failed: false,
		pending: false,
	});
	expect(logs?.label).toBe("Logs api");
	expect(logs?.hint).toBe("failed · exit 2");
	expect(logs?.sections[0]).toMatchObject({
		id: "output",
		label: "Output (failed)",
		tone: "error",
		rows: [{ text: "line one" }, { text: "line two" }],
	});
});

test("a trace keeps its children beneath their span and redacts credentials", () => {
	const body = customToolBody({
		name: "otel_query",
		args: { name: "GET /v1" },
		text: "",
		details: {
			view: {
				spans: [
					{
						name: "GET /v1",
						durationMs: 12,
						status: "ok",
						children: [{ name: "db", durationMs: 3, status: "error" }],
					},
				],
			},
		},
		failed: false,
		pending: false,
	});
	expect(body?.rows[0]).toMatchObject({
		text: "GET /v1 · 12ms",
		tone: "success",
	});
	// The span's own fields stay beside its children, never flattened into them.
	expect(body?.rows[0]?.detail?.[0]).toEqual({
		text: "Status: ok",
		tone: "success",
	});
	// A child without children of its own keeps its fields as fields, and its
	// recorded error tone travels with the status row.
	expect(body?.rows[0]?.detail?.map((row) => row.text)).toEqual([
		"Status: ok",
		"Name: db",
		"Duration Ms: 3",
		"Status: error",
	]);
	expect(body?.rows[0]?.detail?.at(-1)?.tone).toBe("error");
	// A credential recorded in a supplied record is not drawn on screen, and a
	// fill's typed value never is either.
	expect(
		safeToolValue({
			headers: { authorization: "x" },
			name: "api_key",
			value: "y",
		}),
	).toEqual({
		headers: { authorization: "[redacted]" },
		name: "api_key",
		value: "[redacted]",
	});
});

test("a family outside the projection keeps the generic body", () => {
	// Only names this build's runtime emits are projected: a browser, stage,
	// workflow or debug family is restored with such a tool, not carried dead.
	for (const name of [
		"read",
		"bash",
		"powershell",
		"codemode",
		"schedule_skill",
		"browser_click",
		"frobnicate",
	])
		expect(
			customToolBody({
				name,
				args: {},
				text: "",
				details: null,
				failed: false,
				pending: false,
			}),
		).toBe(null);
});

// v1's Ctrl+T / Ctrl+O: one kind of block at a time, and the whole kind moves
// together — closed until one of its members is open, then closed again.
test("a bulk fold closes a half-open kind and keeps every other fold", () => {
	const thoughts = ["a:1", "a:2"];
	expect(bulkFold(thoughts, [])).toEqual({ ids: thoughts, open: true });
	expect(bulkFold(thoughts, ["a:2"])).toEqual({ ids: thoughts, open: false });
	expect(bulkFold(thoughts, ["a:1", "a:2"])).toEqual({
		ids: thoughts,
		open: false,
	});
	// A card's own section fold is not a card: it never decides the kind's state.
	expect(bulkFold(thoughts, ["a:1:output"])).toEqual({
		ids: thoughts,
		open: true,
	});
	expect(foldAll(["a:1", "a:1:output", "b:1"], thoughts, false)).toEqual([
		"a:1:output",
		"b:1",
	]);
	expect(foldAll(["a:1:output", "b:1"], thoughts, true)).toEqual([
		"a:1:output",
		"b:1",
		"a:1",
		"a:2",
	]);
});

test("empty failed assistant messages still show the provider error", () => {
	expect(
		assistantFailure({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "OAuth auth derivation failed: missing module",
		}),
	).toBe("OAuth auth derivation failed: missing module");
	expect(
		assistantFailure({ role: "assistant", content: [], stopReason: "error" }),
	).toBe("Model request failed without an error message");
	expect(assistantFailure({ role: "assistant", stopReason: "aborted" })).toBe(
		"Response aborted",
	);
	expect(
		assistantFailure({ role: "assistant", stopReason: "stop" }),
	).toBeNull();
});

test("follow-up navigation chooses an observed writable owner, never a sibling or guessed root", () => {
	const session = (
		id: number,
		parent: number | null,
		writable: boolean,
	): Session => ({
		id,
		parent,
		writable,
		task: parent === null ? null : id,
		title: "Conversation",
	});
	const sessions = [
		session(1, null, true),
		session(2, 1, false),
		session(3, 2, false),
		session(4, null, true),
	];
	expect(followUpSession(sessions, 3)?.id).toBe(1);
	expect(
		followUpSession(
			sessions.map((s) => (s.id === 2 ? { ...s, writable: true } : s)),
			3,
		)?.id,
	).toBe(2);
	expect(
		followUpSession(
			sessions.filter((s) => s.id !== 2),
			3,
		),
	).toBeUndefined();
	expect(
		followUpSession([session(2, 3, false), session(3, 2, false)], 3),
	).toBeUndefined();
});
