import type { Data } from "../../../protocol/index.ts";

// The per-family projection of a tool result, ported from the v1 TUI's
// `custom-tool-views.ts` and `tool-content.ts`. It only projects data the call
// already supplied — no transport, no execution, no live resource — and every
// row it produces is drawn from exact supplied fields or is absent.
//
// A family whose result has real structure (a search's matches grouped by file,
// an HTTP response's status and headers, a query's columns and rows, a trace's
// spans, a workflow's report) reads badly as one JSON blob. Each family gets the
// reading its own payload deserves; every field the projection consumes is also
// still reachable through the card's retained-parts and complete-argument
// folds, so nothing is lost by reading it this way.

export type CustomRow = {
	id?: string;
	text: string;
	/** Supplied source drawn with its own language. */
	syntax?: string;
	/** Supplied text drawn as markdown. */
	markdown?: boolean;
	/** Log or shell output: one block, never reflowed as prose. */
	shell?: boolean;
	/** A table of supplied cells. */
	table?: { columns: string[]; rows: string[][] };
	tone?: "error" | "warning" | "success";
	lineNumber?: number;
	highlight?: string;
	detail?: CustomRow[];
};

export type CustomSection = {
	id: string;
	label: string;
	shell?: boolean;
	tone?: "error" | "warning" | "success";
	rows: CustomRow[];
};

export type CustomBody = {
	label: string;
	hint?: string;
	rows: CustomRow[];
	sections: CustomSection[];
};

const record = (value: unknown): Data | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: undefined;

/** `file_path` / `filePath` → `File path`, as the original detail headings read. */
export const title = (value: string): string => {
	const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const SECRET =
	/^(authorization|proxy_authorization|cookie|set_cookie|password|passwd|secret|secret_value|client_secret|token|jwt|access_token|refresh_token|api_key|private_key|connection_string|.*_(?:token|secret|password|api_key))$/i;

const secretKey = (key: string): boolean =>
	SECRET.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").replaceAll("-", "_"));

const safeUrl = (value: string): string => {
	if (!value.includes("://") && !value.includes("?")) return value;
	try {
		const url = new URL(value, "https://tool.invalid");
		let changed = false;
		if (url.username || url.password) {
			url.username = "[redacted]";
			url.password = "";
			changed = true;
		}
		for (const key of [...url.searchParams.keys()])
			if (secretKey(key)) {
				url.searchParams.set(key, "[redacted]");
				changed = true;
			}
		return changed
			? value.includes("://")
				? url.href
				: `${url.pathname}${url.search}${url.hash}`
			: value;
	} catch {
		return value;
	}
};

export const parseToolJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/** Defensive rendering redaction on top of the backend's own value redaction: a
 * credential that reached the client is still not drawn on screen. */
export const safeToolValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(safeToolValue);
	const object = record(value);
	if (!object) return value;
	return Object.fromEntries(
		Object.entries(object).map(([key, item]) => [
			key,
			(secretKey(key) ||
				(key === "value" &&
					typeof object.name === "string" &&
					secretKey(object.name))) &&
			item !== null
				? "[redacted]"
				: typeof item === "string" && /^(url|uri|path|endpoint)$/i.test(key)
					? safeUrl(item)
					: typeof item === "string" &&
							/^(body|payload|data)$/i.test(key) &&
							parseToolJson(item) !== undefined
						? JSON.stringify(safeToolValue(parseToolJson(item)))
						: safeToolValue(item),
		]),
	);
};

export const scalar = (value: unknown): string => {
	if (value === null) return "null";
	if (value === undefined) return "—";
	return typeof value === "object"
		? JSON.stringify(safeToolValue(value))
		: String(value);
};

export const cleanToolText = (value: string): string =>
	value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: remove transport ANSI escapes, not source characters printed as escape sequences.
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\[[0-9;]*m/g, "")
		.replace(/\r\n?/g, "\n");

const tone = (value: unknown): "error" | "warning" | "success" | undefined => {
	const text = String(value).toLowerCase();
	if (
		/^(error|fatal|critical|failed|failure|cancelled|aborted|unhealthy|refused|denied)$/.test(
			text,
		)
	)
		return "error";
	if (/^(waiting|pending|starting|warn|warning|queued|blocked)$/.test(text))
		return "warning";
	if (
		/^(ok|success|succeeded|passed|healthy|ready|running|completed)$/.test(text)
	)
		return "success";
	return undefined;
};

export const statusRow = (text: string, status: unknown): CustomRow => ({
	text,
	...(tone(status) ? { tone: tone(status) } : {}),
});

/** Structured results stay complete: rows wrap, tables stack on narrow panes,
 * and unknown nested fields remain independently readable. */
export function valueRows(value: unknown, prefix = "value"): CustomRow[] {
	const safe = safeToolValue(value);
	if (Array.isArray(safe)) {
		if (safe.length === 0) return [{ text: "No results" }];
		const objects = safe.map(record);
		if (objects.every((item) => item !== undefined)) {
			const columns = [
				...new Set(objects.flatMap((item) => Object.keys(item ?? {}))),
			];
			return [
				{
					text: "",
					table: {
						columns,
						rows: objects.map((item) =>
							columns.map((key) => scalar(item?.[key])),
						),
					},
				},
			];
		}
		return safe.flatMap((item, index) =>
			record(item) || Array.isArray(item)
				? [
						{
							id: `${prefix}:${index}`,
							text: `Result ${index + 1}`,
							detail: valueRows(item, `${prefix}:${index}`),
						},
					]
				: [{ text: scalar(item) }],
		);
	}
	const object = record(safe);
	if (!object) return [{ text: scalar(safe) }];
	return Object.entries(object).map(([key, item]): CustomRow => {
		if (item !== null && typeof item === "object")
			return {
				id: `${prefix}:${key}`,
				text: title(key),
				detail: valueRows(item, `${prefix}:${key}`),
			};
		const text = `${title(key)}: ${scalar(item)}`;
		return /status|outcome|severity|level/i.test(key)
			? statusRow(text, item)
			: { text };
	});
}

export function contentRows(
	text: string,
	syntax?: string,
	markdown = false,
): CustomRow[] {
	const clean = cleanToolText(text);
	if (!clean) return [];
	if (syntax && syntax !== "json") return [{ text: clean, syntax }];
	const parsed = parseToolJson(clean);
	if (parsed !== undefined)
		return [
			{
				text: JSON.stringify(safeToolValue(parsed), null, 2),
				syntax: "json",
			},
		];
	if (syntax) return [{ text: clean, syntax }];
	if (markdown || /(^|\n)(#{1,6} |[-*] |```|> )/.test(clean))
		return [{ text: clean, markdown: true }];
	return clean.split("\n").map((text) => ({ text }));
}

const metadataWithout = (
	value: unknown,
	keys: readonly string[],
): CustomRow[] => {
	const object = record(value);
	return object
		? valueRows(
				Object.fromEntries(
					Object.entries(object).filter(([key]) => !keys.includes(key)),
				),
			)
		: [];
};

/** Result value: the supplied structured view when the tool recorded one, else
 * the parsed body text. Never a re-encoding of what the tool did not say. */
const resultValue = (text: string, details: Data | null): unknown => {
	const view = record(details)?.view;
	return safeToolValue(view ?? parseToolJson(text));
};

// The families the projection answers for. A name outside them keeps the
// card's generic body, so nothing that already read well changes.
//
// Only names this build's runtime emits are listed: the browser, stage,
// workflow, events and debug families belong to the shell's own orchestrator,
// so their views are removed with them and return with the family if a native
// task ever gains one.
const FAMILIES: Readonly<Record<string, readonly string[]>> = {
	search: ["grep", "find", "ls"],
	environment: [
		"env_list",
		"env_status",
		"env_discover",
		"env_draft_stage",
		"env_draft_source",
		"env_cluster_status",
		"env_cluster_namespace",
		"environment_action",
	],
	logs: ["env_build", "env_test", "env_logs"],
	http: ["env_http_request"],
	database: ["db_query"],
	telemetry: ["otel_query"],
	evidence: ["attach_evidence"],
	orchestrator: ["catalog", "start_task", "task_result", "request_review"],
};

const families = new Map<string, string>(
	Object.entries(FAMILIES).flatMap(([family, names]) =>
		names.map((name) => [name, family] as const),
	),
);

const ACTION_LABELS: Readonly<Record<string, string>> = {
	env_list: "Environment",
	env_status: "Status",
	env_discover: "Discover",
	env_draft_stage: "Draft stage",
	env_draft_source: "Draft source",
	env_cluster_status: "Cluster status",
	env_cluster_namespace: "Cluster namespace",
	attach_evidence: "Attach evidence",
	catalog: "Catalog",
	start_task: "Start task",
	task_result: "Task result",
	request_review: "Review",
};

const arg = (args: Data, ...keys: string[]): string => {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" || typeof value === "number")
			return String(value);
		if (Array.isArray(value)) return value.map(scalar).join(", ");
	}
	return "";
};

const section = (
	id: string,
	label: string,
	rows: readonly CustomRow[],
	extra: Partial<CustomSection> = {},
): CustomSection[] =>
	rows.length > 0 ? [{ id, label, rows: [...rows], ...extra }] : [];

const readable = (
	value: unknown,
	text: string,
	markdown = false,
): CustomRow[] =>
	value === undefined
		? contentRows(text, undefined, markdown)
		: valueRows(value);

/** The request the call carried, drawn with its own syntax where it has one. */
const sourceSections = (args: Data): CustomSection[] => {
	const sections: CustomSection[] = [];
	for (const [key, syntax] of [["sql", "sql"]] as const) {
		const value = args[key];
		if (value === undefined) continue;
		sections.push(
			...section(
				key,
				"SQL",
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
};

const detailsSection = (
	value: unknown,
	consumed: readonly string[],
): CustomSection[] =>
	section("details", "Details", metadataWithout(value, consumed));

const searchView = (
	name: string,
	args: Data,
	lines: readonly string[],
	value: unknown,
): Omit<CustomBody, "sections"> & { sections: CustomSection[] } => {
	const pattern = arg(args, "pattern", "query");
	const path = arg(args, "path", "glob");
	const files = new Map<string, CustomRow[]>();
	const remaining: CustomRow[] = [];
	for (const line of lines) {
		const match = /^(.+?):(\d+):(?:\d+:)?(.*)$/.exec(line);
		if (!match) {
			remaining.push({ text: line });
			continue;
		}
		const file = match[1] ?? "";
		const rows = files.get(file) ?? [];
		rows.push({
			text: match[3] ?? "",
			lineNumber: Number(match[2]),
			...(pattern ? { highlight: pattern } : {}),
		});
		files.set(file, rows);
	}
	const matches = [...files.values()].reduce(
		(total, rows) => total + rows.length,
		0,
	);
	return {
		label:
			name === "grep"
				? `Search ${pattern ? `“${pattern}”` : path}`
				: `${title(name)} ${pattern || path}`.trim(),
		...(path && pattern
			? { hint: `${path} · ${files.size} files · ${matches} matches` }
			: files.size > 0
				? { hint: `${files.size} files · ${matches} matches` }
				: {}),
		rows: value === undefined ? remaining : valueRows(value),
		sections: [...files].map(([file, rows]) => ({
			id: `file:${file}`,
			label: file,
			rows,
		})),
	};
};

/** An approved request to one declared endpoint: the verb and path name the
 * call, the app/endpoint pair names the target it reached, and the request's own
 * authority flags and payload stay beside the response they produced. */
const httpView = (args: Data, value: unknown, text: string): CustomBody => {
	const object = record(value);
	const method = (arg(args, "method") || "GET").toUpperCase();
	const path = arg(args, "path") || "/";
	const target = [arg(args, "app"), arg(args, "endpoint")]
		.filter((part) => part)
		.join(" · ");
	const rows: CustomRow[] = [];
	if (object?.status !== undefined) {
		const status = object.status;
		rows.push(
			statusRow(
				`HTTP ${scalar(status)} ${scalar(object.statusText ?? "")}`.trim(),
				typeof status === "number" && status >= 100 && status < 600
					? status >= 400
						? "error"
						: "ok"
					: status,
			),
		);
	}
	const request = record(safeToolValue(args));
	const body = request?.body;
	return {
		label: `${method} ${path}`,
		...(target ? { hint: target } : {}),
		rows,
		sections: [
			...section(
				"request",
				"Request",
				metadataWithout(request, [
					"method",
					"path",
					"url",
					"endpoint",
					"headers",
					"body",
				]),
			),
			...section(
				"request-headers",
				"Request headers",
				record(request?.headers) === undefined
					? []
					: valueRows(request?.headers),
			),
			...section(
				"request-body",
				"Request body",
				typeof body === "string"
					? contentRows(body)
					: body === undefined
						? []
						: valueRows(body),
				{ shell: typeof body === "string" },
			),
			...section(
				"headers",
				"Response headers",
				object?.headers === undefined ? [] : valueRows(object.headers),
			),
			...section(
				"body",
				"Response body",
				typeof object?.body === "string"
					? contentRows(object.body)
					: object?.body !== undefined
						? valueRows(object.body)
						: object?.bodyFormat === "omitted"
							? [
									{
										text: "Omitted: not UTF-8 text, or encoded",
										tone: "warning" as const,
									},
								]
							: object
								? []
								: readable(value, text),
				{ shell: typeof object?.body === "string" },
			),
			...detailsSection(object, [
				"headers",
				"body",
				"status",
				"statusText",
				"url",
				"durationMs",
				"bytes",
				"bodyFormat",
			]),
		],
	};
};

const logView = (
	name: string,
	args: Data,
	value: unknown,
	text: string,
	failed: boolean,
): CustomBody => {
	const object = record(value);
	const broken =
		failed ||
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
		`${({ env_build: "Build", env_test: "Test", env_logs: "Logs" } as Record<string, string>)[name]} ${arg(args, "app", "service")}`.trim();
	return {
		label,
		hint:
			[
				object?.status,
				object?.exitCode === undefined
					? undefined
					: `exit ${scalar(object.exitCode)}`,
				object?.targetId,
			]
				.filter((item) => item !== undefined)
				.map((item) => scalar(item))
				.join(" · ") || undefined,
		rows: [],
		sections: [
			{
				id: "output",
				label: broken ? "Output (failed)" : "Output",
				shell: true,
				...(broken ? { tone: "error" as const } : {}),
				rows: output ? output.split("\n").map((text) => ({ text })) : [],
			},
			...detailsSection(object, [
				"output",
				"lines",
				"status",
				"exitCode",
				"targetId",
			]),
		].filter((item) => item.rows.length > 0),
	};
};

const telemetryRows = (
	value: unknown,
	text: string,
	prefix = "span",
): CustomRow[] => {
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
};

export type CustomToolInput = {
	name: string;
	args: Data;
	/** The call's returned text, joined from its text parts. */
	text: string;
	/** Whatever structured details the call recorded, if any. */
	details: Data | null;
	/** Bounded live output of a call that has not returned. */
	progressOutput?: string;
	failed: boolean;
	pending: boolean;
};

export function customToolBody(input: CustomToolInput): CustomBody | null {
	const family = families.get(input.name);
	if (!family) return null;
	const text = cleanToolText(input.text);
	const value = resultValue(text, input.details);
	const object = record(value);
	const safeArgs = record(safeToolValue(input.args)) ?? {};
	const subject =
		arg(
			safeArgs,
			"app",
			"requestId",
			"goal",
			"url",
			"path",
			"infra",
			"traceId",
			"repo",
			"repository",
			"pattern",
			"query",
			"name",
			"endpoint",
			"command",
			"taskId",
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
	const action = Object.hasOwn(ACTION_LABELS, input.name)
		? (ACTION_LABELS[input.name] ?? title(input.name))
		: title(input.name);
	const label = `${action}${subject ? ` ${subject}` : ""}`;
	// Never interpret an error envelope as a successful domain response.
	if (input.failed)
		return {
			label,
			hint: subject ? title(input.name) : undefined,
			rows: [],
			sections: [
				...sourceSections(safeArgs),
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
					contentRows(text).map((row) => ({ ...row, tone: "error" as const })),
				),
				...section(
					"arguments",
					"Arguments",
					metadataWithout(safeArgs, ["sql"]),
				),
				...(input.details?.view === undefined
					? []
					: detailsSection(object, ["output"])),
			],
		};
	if (family === "search")
		return searchView(input.name, safeArgs, text.split("\n"), value);
	if (family === "http") return httpView(safeArgs, value, text);
	if (family === "logs")
		return logView(
			input.name,
			safeArgs,
			value ??
				(input.progressOutput === undefined
					? undefined
					: { output: input.progressOutput }),
			text,
			input.failed,
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
		const resultRows: CustomRow[] =
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
			label: `Query ${subject || "database"}`,
			hint: Array.isArray(rows) ? `${rows.length} rows` : undefined,
			rows: [],
			sections: [
				...sourceSections(safeArgs),
				...section(
					"arguments",
					"Query options",
					metadataWithout(safeArgs, ["sql"]),
				),
				...section("results", "Results", resultRows, {
					shell: resultRows.some(
						(row) => row.syntax === undefined && !row.table,
					),
				}),
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
	if (family === "telemetry")
		return {
			label,
			hint: undefined,
			rows: telemetryRows(value, text),
			sections: section("filters", "Filters", valueRows(safeArgs)),
		};
	const report = object?.report;
	const collection = Array.isArray(value)
		? { name: "results", values: value }
		: Object.entries(object ?? {})
				.map(([name, values]) => ({ name, values }))
				.find((entry) => Array.isArray(entry.values));
	return {
		label,
		hint:
			[
				object?.status === undefined ? undefined : scalar(object.status),
				collection && Array.isArray(collection.values)
					? `${collection.values.length} ${collection.name}`
					: undefined,
			]
				.filter(Boolean)
				.join(" · ") || undefined,
		rows: [],
		sections: [
			...sourceSections(safeArgs),
			...section(
				"result",
				family === "evidence"
					? "Artifacts"
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
			...section("arguments", "Arguments", metadataWithout(safeArgs, ["sql"])),
		],
	};
}
