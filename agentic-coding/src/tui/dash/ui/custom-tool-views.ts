// Custom tools share content primitives and the exact same card in standalone
// transcripts and codemode. This module only projects existing data.
import type { AgentSessionToolCall } from "../agent-session.ts";
import {
	cleanToolText,
	contentRows,
	metadataWithout,
	record,
	resultValue,
	safeToolValue,
	scalar,
	statusRow,
	title,
	valueRows,
} from "./tool-content.ts";
import type { ToolView, ToolViewRow, ToolViewSection } from "./tool-views.ts";

const FAMILIES = {
	search: ["grep", "glob", "find", "ls", "search"],
	web: ["webfetch", "websearch", "web_fetch", "web_search", "fetch"],
	environment: ["env_list", "env_status", "env_start", "env_stop"],
	logs: ["env_build", "env_test", "env_logs"],
	http: ["http_request", "stage_api_request"],
	database: ["db_query"],
	telemetry: ["otel_query", "browser_console", "browser_network"],
	script: ["browser_run_script", "browser_eval"],
	browser: [
		"browser_open",
		"browser_close",
		"browser_click",
		"browser_fill",
		"browser_press",
		"browser_select",
		"browser_hover",
		"browser_wait",
		"browser_snapshot",
		"browser_find",
		"stage_login",
		"stage_login_wait",
		"stage_wait",
	],
	stage: [
		"stage_info",
		"stage_token_info",
		"stage_step",
		"stage_journal",
		"stage_blocks",
		"stage_run",
		"stage_block_save",
		"stage_flows",
		"stage_replay",
	],
	workflow: [
		"list_projects",
		"list_workflow_types",
		"list_agent_config",
		"list_branches",
		"list_workflows",
		"list_changes",
		"workflow_status",
		"list_steps",
		"validate_blueprint",
		"start_workflow",
		"workflow_action",
		"drain_workflow",
	],
	events: [
		"subscribe_events",
		"unsubscribe_events",
		"list_subscriptions",
		"read_events",
	],
	debug: [
		"debug_request",
		"debug_result",
		"debug_wait",
		"debug_cancel",
		"sessions_report",
		"opencode_session",
	],
	evidence: [
		"evidence_attach",
		"evidence_list",
		"browser_screenshot",
		"browser_record_start",
		"browser_record_stop",
	],
} as const;
export type CustomToolFamily = keyof typeof FAMILIES;
const families = new Map<string, CustomToolFamily>(
	Object.entries(FAMILIES).flatMap(([family, names]) =>
		names.map((name) => [name, family as CustomToolFamily] as const),
	),
);
export const customToolNames = [...families.keys()];
const ACTION_LABELS: Readonly<Record<string, string>> = {
	env_list: "Environment",
	env_status: "Status",
	env_start: "Start",
	env_stop: "Stop",
	workflow_status: "Workflow",
	list_projects: "Projects",
	list_workflows: "Workflows",
	list_workflow_types: "Workflow types",
	list_agent_config: "Agent configuration",
	list_branches: "Branches",
	list_changes: "Changes",
	list_steps: "Steps",
	validate_blueprint: "Validate blueprint",
	start_workflow: "Start workflow",
	workflow_action: "Workflow action",
	drain_workflow: "Drain workflow",
	subscribe_events: "Subscribe",
	unsubscribe_events: "Unsubscribe",
	list_subscriptions: "Subscriptions",
	read_events: "Events",
	debug_request: "Investigate",
	debug_result: "Investigation",
	debug_wait: "Wait for investigation",
	debug_cancel: "Cancel investigation",
	evidence_attach: "Attach evidence",
	evidence_list: "Evidence",
	browser_screenshot: "Screenshot",
	browser_record_start: "Start recording",
	browser_record_stop: "Stop recording",
};

function arg(call: AgentSessionToolCall, ...keys: string[]): string {
	for (const key of keys) {
		const value = call.args[key];
		if (typeof value === "string" || typeof value === "number")
			return String(value);
		if (Array.isArray(value)) return value.map(scalar).join(", ");
	}
	return "";
}

function section(
	id: string,
	label: string,
	rows: readonly ToolViewRow[],
): ToolViewSection[] {
	return rows.length > 0 ? [{ id, label, rows }] : [];
}

function readable(
	value: unknown,
	text: string,
	markdown = false,
): ToolViewRow[] {
	return value === undefined
		? contentRows(text, undefined, markdown)
		: valueRows(value);
}

function sourceSections(call: AgentSessionToolCall): ToolViewSection[] {
	const sections: ToolViewSection[] = [];
	for (const [key, syntax] of [
		["sql", "sql"],
		["code", "javascript"],
		["blueprint", "json"],
	] as const) {
		const value = call.args[key];
		if (value !== undefined)
			sections.push(
				...section(
					key,
					key === "sql" ? "SQL" : title(key === "code" ? "script" : key),
					contentRows(
						typeof value === "string"
							? value
							: JSON.stringify(safeToolValue(value), null, 2),
						syntax,
					),
				),
			);
	}
	return sections;
}

/** Preserve unknown fields rather than dropping them when a server adds data. */
function detailsSection(
	value: unknown,
	consumed: readonly string[],
): ToolViewSection[] {
	return section("details", "Details", metadataWithout(value, consumed));
}

function searchView(
	call: AgentSessionToolCall,
	lines: readonly string[],
	value: unknown,
): ToolView {
	const pattern = arg(call, "pattern", "query");
	const path = arg(call, "path", "glob");
	const files = new Map<string, ToolViewRow[]>();
	const remaining: ToolViewRow[] = [];
	for (const line of lines) {
		const match = /^(.+?):(\d+):(?:\d+:)?(.*)$/.exec(line);
		if (!match) {
			remaining.push({ text: line });
			continue;
		}
		const path = match[1] ?? "";
		const rows = files.get(path) ?? [];
		rows.push({
			text: match[3] ?? "",
			lineNumber: Number(match[2]),
			highlight: pattern,
		});
		files.set(path, rows);
	}
	const label =
		call.name === "grep" || call.name === "search"
			? `Search ${pattern ? `“${pattern}”` : path}`
			: `${title(call.name)} ${pattern || path}`;
	return {
		icon: "✱",
		label: label.trim(),
		summary: pattern || path || title(call.name),
		hint:
			[
				path && pattern ? path : undefined,
				files.size > 0
					? `${files.size} files · ${[...files.values()].reduce((n, rows) => n + rows.length, 0)} matches`
					: undefined,
			]
				.filter(Boolean)
				.join(" · ") || undefined,
		rows: value === undefined ? remaining : valueRows(value),
		sections: [...files].map(([path, rows]) => ({
			id: `file:${path}`,
			label: path,
			rows,
		})),
	};
}

function httpView(
	call: AgentSessionToolCall,
	value: unknown,
	text: string,
): ToolView {
	const object = record(value);
	const method = (arg(call, "method") || "GET").toUpperCase();
	const url =
		arg(call, "path", "url", "endpoint") || scalar(object?.url ?? "request");
	const rows: ToolViewRow[] = [];
	if (object?.status !== undefined)
		rows.push(
			statusRow(
				`HTTP ${scalar(object.status)} ${scalar(object.statusText ?? "")}`.trim(),
				typeof object.status === "number" &&
					object.status >= 100 &&
					object.status < 600
					? object.status >= 400
						? "error"
						: "ok"
					: object.status,
			),
		);
	const request = record(safeToolValue(call.args));
	return {
		icon: "↗",
		label: `${method} ${url}`,
		summary: url,
		hint:
			object?.status === undefined
				? undefined
				: `${scalar(object.status)}${object.durationMs === undefined ? "" : ` · ${scalar(object.durationMs)}ms`}`,
		rows,
		sections: [
			...section(
				"request",
				"Request",
				metadataWithout(request, ["method", "path", "url", "endpoint"]),
			),
			...section(
				"headers",
				"Response headers",
				object?.headers ? valueRows(object.headers) : [],
			),
			...section(
				"body",
				"Response body",
				object?.body === undefined
					? object
						? []
						: readable(value, text)
					: typeof object.body === "string"
						? contentRows(object.body)
						: valueRows(object.body),
			),
			...detailsSection(object, [
				"headers",
				"body",
				"status",
				"statusText",
				"url",
				"durationMs",
			]),
		],
	};
}

function logView(
	call: AgentSessionToolCall,
	value: unknown,
	text: string,
): ToolView {
	const object = record(value);
	const failed =
		call.result?.isError === true ||
		(typeof object?.exitCode === "number" && object.exitCode !== 0) ||
		/^(failed|failure|cancelled|aborted)$/.test(String(object?.status));
	const output = cleanToolText(
		typeof object?.output === "string"
			? object.output
			: Array.isArray(object?.lines)
				? object.lines.map(scalar).join("\n")
				: text,
	);
	const label =
		`${({ env_build: "Build", env_test: "Test", env_logs: "Logs" } as Record<string, string>)[call.name]} ${arg(call, "app", "service")}`.trim();
	return {
		icon: "$",
		failed,
		label,
		summary: label,
		shell: true,
		preview: true,
		hint:
			[
				object?.status,
				object?.exitCode === undefined
					? undefined
					: `exit ${scalar(object.exitCode)}`,
				object?.targetId,
			]
				.filter((item) => item !== undefined)
				.map(scalar)
				.join(" · ") || undefined,
		rows: output
			? output.split("\n").map(
					(text): ToolViewRow => ({
						text,
						...(call.result?.isError
							? { emphasis: "highlight", tone: "error" }
							: {}),
					}),
				)
			: [],
		sections: detailsSection(object, [
			"output",
			"lines",
			"status",
			"exitCode",
			"targetId",
		]),
	};
}

function telemetryRows(
	value: unknown,
	text: string,
	prefix = "span",
): ToolViewRow[] {
	const object = record(value);
	if (!object) return readable(value, text);
	if (Array.isArray(object.spans))
		return [
			...metadataWithout(object, ["spans"]),
			...object.spans.flatMap((span, index) =>
				telemetryRows(span, "", `${prefix}:${index}`),
			),
		];
	// A trace's children stay beneath their span rather than becoming nested JSON.
	if (typeof object.name === "string" && Array.isArray(object.children))
		return [
			{
				id: `${prefix}:${String(object.spanId ?? object.name)}`,
				...statusRow(
					`${object.name}${object.durationMs === undefined ? "" : ` · ${scalar(object.durationMs)}ms`}`,
					object.status,
				),
				detail: [
					...metadataWithout(object, ["name", "children", "durationMs"]),
					...object.children.flatMap((child, index) =>
						telemetryRows(child, "", `${prefix}:${index}`),
					),
				],
			},
		];
	return valueRows(object);
}

/** All registered custom families have a meaningful subject and independently
 * foldable components. Unsupported data always falls back losslessly. */
function projectCustomTool(
	call: AgentSessionToolCall,
	runningOutput: readonly string[] = [],
	pending = false,
): ToolView {
	const family = families.get(call.name);
	const lines = pending ? runningOutput : (call.result?.lines ?? []);
	const text = lines.join("\n");
	const details = pending ? call.progress : call.result?.details;
	const value = resultValue(lines, details);
	const object = record(value);
	const safeArgs = record(safeToolValue(call.args)) ?? {};
	if (call.name === "browser_fill" && "value" in safeArgs)
		safeArgs.value = "[redacted]";
	const subject =
		arg(
			{ ...call, args: safeArgs },
			"app",
			"stage",
			"workflowId",
			"requestId",
			"goal",
			"url",
			"path",
			"session",
			"infra",
			"traceId",
			"repo",
			"pattern",
			"query",
			"role",
			"name",
			"event",
			"subscriptionId",
			"ref",
			"selector",
			"endpoint",
			"command",
		) ||
		String(
			Object.entries(safeArgs)
				.filter(
					([key]) =>
						!["sql", "code", "blueprint", "body", "headers"].includes(key),
				)
				.map(([, value]) => value)
				.find(
					(value) =>
						(typeof value === "string" || typeof value === "number") &&
						value !== "[redacted]",
				) ?? "",
		);
	const action = Object.hasOwn(ACTION_LABELS, call.name)
		? ACTION_LABELS[call.name]
		: title(call.name);
	const label = `${action}${subject ? ` ${subject}` : ""}`;
	const failed = call.result?.isError === true;
	// Never interpret an error envelope as a successful domain response.
	if (failed)
		return {
			icon: "!",
			failed: true,
			label,
			summary: subject || title(call.name),
			sections: [
				...sourceSections(call),
				...(typeof object?.output === "string"
					? [
							{
								id: "output",
								label: "Output",
								shell: true,
								rows: cleanToolText(object.output)
									.split("\n")
									.map((text) => ({ text })),
							},
						]
					: []),
				...section(
					"error",
					"Error",
					contentRows(text).map((row) => ({
						...row,
						emphasis: "highlight",
						tone: "error",
					})),
				),
				...section(
					"arguments",
					"Arguments",
					metadataWithout(safeArgs, ["sql", "code", "blueprint"]),
				),
				...(details?.view === undefined
					? []
					: detailsSection(object, ["output"])),
			],
		};
	if (family === "search") return searchView(call, lines, value);
	if (family === "http")
		return httpView({ ...call, args: safeArgs }, value, text);
	if (family === "logs")
		return logView(
			call,
			value ??
				(record(call.progress)?.output === undefined
					? undefined
					: call.progress),
			text,
		);
	if (family === "database") {
		const rows = object?.rows;
		const columns = Array.isArray(object?.columns)
			? object.columns.map((column) =>
					typeof column === "string"
						? column
						: scalar(record(column)?.name ?? column),
				)
			: undefined;
		const resultRows: ToolViewRow[] =
			columns && Array.isArray(rows) && rows.every(Array.isArray)
				? [
						{
							text: "",
							table: {
								columns,
								rows: rows.map((row) =>
									columns.map((column, index) =>
										scalar(
											record(safeToolValue({ [column]: row[index] }))?.[column],
										),
									),
								),
							},
						},
					]
				: rows === undefined
					? readable(value, text)
					: valueRows(rows);
		return {
			icon: "≡",
			label: `Query ${subject || "database"}`,
			summary: subject || "database",
			hint: Array.isArray(rows) ? `${rows.length} rows` : undefined,
			sections: [
				...sourceSections(call),
				...section(
					"arguments",
					"Query options",
					metadataWithout(safeArgs, ["sql"]),
				),
				...section("results", "Results", resultRows),
				...(rows === undefined
					? []
					: detailsSection(object, [
							"rows",
							...(Array.isArray(object?.columns) &&
							object.columns.every((column) => typeof column === "string")
								? ["columns"]
								: []),
						])),
			],
		};
	}
	if (family === "script")
		return {
			icon: "λ",
			label,
			summary: subject || title(call.name),
			sections: [
				...sourceSections(call),
				...section(
					"arguments",
					"Script options",
					metadataWithout(safeArgs, ["code"]),
				),
				...(typeof object?.output === "string"
					? [
							{
								id: "output",
								label: "Output",
								shell: true,
								rows: object.output.split("\n").map((text) => ({ text })),
							},
						]
					: section(
							"output",
							"Output",
							readable(object?.result ?? object?.value ?? value, text),
						)),
				...(typeof object?.output === "string" &&
				(object.result !== undefined || object.value !== undefined)
					? section(
							"return",
							"Return value",
							readable(object.result ?? object.value, ""),
						)
					: []),
				...(object &&
				("output" in object || "result" in object || "value" in object)
					? detailsSection(object, ["output", "result", "value"])
					: []),
			],
		};
	if (family === "telemetry")
		return {
			icon: "≋",
			label,
			summary: subject || title(call.name),
			rows: telemetryRows(value, text),
			sections: section("filters", "Filters", valueRows(safeArgs)),
		};
	if (family === "browser") {
		const identity = ["title", "url", "snapshotId"].filter(
			(key) => typeof object?.[key] === "string",
		);
		const hasObservation = object?.observation !== undefined;
		const hasMatches = object?.matches !== undefined;
		const target =
			arg(
				{ ...call, args: safeArgs },
				"ref",
				"selector",
				"url",
				"text",
				"key",
			) || subject;
		const verb = call.name.replace(/^browser_/, "").replaceAll("_", " ");
		return {
			icon: "→",
			label: `${title(verb)}${target ? ` ${target}` : ""}`,
			summary: target || verb,
			hint:
				[object?.title, object?.url, object?.snapshotId]
					.filter((item) => typeof item === "string" && item.length > 0)
					.join(" · ") || undefined,
			sections: [
				...section(
					"observation",
					call.name === "browser_find" ? "Matches" : "Observation",
					hasObservation
						? typeof object?.observation === "string"
							? contentRows(object.observation)
							: valueRows(object?.observation)
						: hasMatches
							? valueRows(object?.matches)
							: object
								? metadataWithout(object, identity)
								: readable(value, text),
				),
				...section("target", "Target", valueRows(safeArgs)),
				...(hasObservation || hasMatches
					? detailsSection(object, ["observation", "matches", ...identity])
					: []),
			],
		};
	}
	if (family === "web")
		return {
			icon: "↗",
			label: `${call.name.includes("search") ? "Search web" : "Fetch"} ${subject}`,
			summary: subject || title(call.name),
			rows: readable(value, text, true),
		};
	if (family === "stage") {
		const stepsKey = ["steps", "journal", "results"].find((key) =>
			Array.isArray(object?.[key]),
		);
		const steps = stepsKey ? object?.[stepsKey] : undefined;
		if (Array.isArray(steps))
			return {
				icon: "◈",
				label,
				summary: subject || title(call.name),
				hint: `${steps.length} steps`,
				sections: [
					...section("arguments", "Stage parameters", valueRows(safeArgs)),
					...steps.map((step, index): ToolViewSection => {
						const item = record(step);
						const status = item?.status ?? item?.outcome;
						return {
							id: `step:${index}`,
							label: `Step ${index + 1}${item?.label || item?.name || item?.action ? ` · ${scalar(item.label ?? item.name ?? item.action)}` : ""}${status === undefined ? "" : ` · ${scalar(status)}`}`,
							tone: statusRow("", status).tone,
							rows: valueRows(step),
						};
					}),
					...detailsSection(object, stepsKey ? [stepsKey] : []),
				],
			};
	}
	const report = object?.report;
	const collection = Array.isArray(value)
		? { name: "results", values: value }
		: Object.entries(object ?? {})
				.map(([name, values]) => ({ name, values }))
				.find((entry) => Array.isArray(entry.values));
	const sections = [
		...sourceSections(call),
		...section(
			"result",
			family === "debug"
				? "Investigation"
				: family === "evidence"
					? "Artifacts"
					: family === "events"
						? "Events"
						: family === "stage"
							? "Steps and result"
							: family === "workflow"
								? "Workflow"
								: family === "environment"
									? "Environment"
									: "Result",
			report === undefined
				? readable(value, text)
				: typeof report === "string"
					? contentRows(report, undefined, true)
					: valueRows(report),
		),
		...(report === undefined ? [] : detailsSection(object, ["report"])),
		...section(
			"arguments",
			"Arguments",
			metadataWithout(safeArgs, ["code", "sql", "blueprint"]),
		),
	];
	return {
		icon:
			family === "debug"
				? "◇"
				: family === "evidence"
					? "▧"
					: family === "workflow" || family === "stage"
						? "◈"
						: "•",
		label,
		summary: subject || title(call.name),
		hint:
			[
				object?.status === undefined ? undefined : scalar(object.status),
				collection && Array.isArray(collection.values)
					? `${collection.values.length} ${collection.name}`
					: undefined,
			]
				.filter(Boolean)
				.join(" · ") || undefined,
		sections,
	};
}

export function customToolView(
	call: AgentSessionToolCall,
	runningOutput: readonly string[] = [],
	pending = false,
): ToolView {
	const view = projectCustomTool(call, runningOutput, pending);
	const details = pending ? call.progress : call.result?.details;
	const extra =
		details && !("view" in details)
			? section("metadata", "Metadata", valueRows(details))
			: [];
	const notes = section(
		"diagnostics",
		"Diagnostics",
		(call.result?.notes ?? []).map((text) => ({
			text,
			emphasis: "muted" as const,
		})),
	);
	return extra.length || notes.length
		? { ...view, sections: [...(view.sections ?? []), ...extra, ...notes] }
		: view;
}
