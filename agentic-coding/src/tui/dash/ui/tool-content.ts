// Pure content projection shared by tool families; no transport or UI state.
import type { ToolViewRow } from "./tool-views.ts";

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function title(value: string): string {
	const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const SECRET =
	/^(authorization|proxy_authorization|cookie|set_cookie|password|passwd|secret|secret_value|client_secret|token|jwt|access_token|refresh_token|api_key|private_key|connection_string|.*_(?:token|secret|password|api_key))$/i;

function secretKey(key: string): boolean {
	return SECRET.test(
		key.replace(/([a-z])([A-Z])/g, "$1_$2").replaceAll("-", "_"),
	);
}

function safeUrl(value: string): string {
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
}

/** Defensive rendering redaction in addition to the backend's value redaction. */
export function safeToolValue(value: unknown): unknown {
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
}

export function parseToolJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function resultValue(
	lines: readonly string[],
	details?: Readonly<Record<string, unknown>>,
): unknown {
	return safeToolValue(details?.view ?? parseToolJson(lines.join("\n")));
}

export function scalar(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "—";
	return typeof value === "object"
		? JSON.stringify(safeToolValue(value))
		: String(value);
}

export function cleanToolText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: remove transport ANSI escapes, not source characters printed as escape sequences.
			.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
			.replace(/\[[0-9;]*m/g, "")
			.replace(/\r\n?/g, "\n")
	);
}

export function statusRow(text: string, status: unknown): ToolViewRow {
	const value = String(status).toLowerCase();
	const tone =
		/^(error|fatal|critical|failed|failure|cancelled|aborted|unhealthy|refused|denied)$/.test(
			value,
		)
			? "error"
			: /^(waiting|pending|starting|warn|warning|queued|blocked)$/.test(value)
				? "warning"
				: /^(ok|success|succeeded|passed|healthy|ready|running|completed)$/.test(
							value,
						)
					? "success"
					: undefined;
	return { text, ...(tone ? ({ emphasis: "highlight", tone } as const) : {}) };
}

/** Structured results stay complete: rows wrap, tables stack on narrow panes,
 * and unknown nested fields remain independently readable. */
export function valueRows(value: unknown, prefix = "value"): ToolViewRow[] {
	const safe = safeToolValue(value);
	if (Array.isArray(safe)) {
		if (safe.length === 0) return [{ text: "No results", emphasis: "muted" }];
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
	return Object.entries(object).map(([key, item]): ToolViewRow => {
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
): ToolViewRow[] {
	text = cleanToolText(text);
	if (!text) return [];
	if (syntax && syntax !== "json") return [{ text, syntax }];
	const parsed = parseToolJson(text);
	if (parsed !== undefined)
		return [
			{ text: JSON.stringify(safeToolValue(parsed), null, 2), syntax: "json" },
		];
	if (syntax) return [{ text, syntax }];
	if (markdown || /(^|\n)(#{1,6} |[-*] |```|> )/.test(text))
		return [{ text, markdown: true }];
	return text.split("\n").map((line) => ({ text: line }));
}

export function metadataWithout(
	value: unknown,
	keys: readonly string[],
): ToolViewRow[] {
	const object = record(value);
	return object
		? valueRows(
				Object.fromEntries(
					Object.entries(object).filter(([key]) => !keys.includes(key)),
				),
			)
		: [];
}
