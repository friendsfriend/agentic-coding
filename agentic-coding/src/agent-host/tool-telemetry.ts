// Bounded, secret-free telemetry fields for one tool call.
//
// The efficiency review could measure neither the bytes a tool call returned
// nor how long it took nor how it failed: the runtime envelope carried only the
// tool name and an `ok`/`error` outcome. This module derives the missing
// fixed-size fields from a call — an argument hash plus a bounded, secret-free
// digest of *what was asked*, the result size, and a machine-readable failure
// kind — and it never returns argument or result text: the only strings it
// produces are a path, a redacted command head and a code from a fixed
// vocabulary. `telemetry.ts` emits them on the existing runtime envelopes, so
// no new transport and no payload leaves the process.

import { createHash } from "node:crypto";

/** Hard bound of the argument digest. */
export const ARGS_DIGEST_LIMIT = 200;
/** Bound of the command text kept for a `bash` call (the command head). */
export const COMMAND_DIGEST_LIMIT = 120;
/** Bound of a path or pattern digest. */
const DETAIL_LIMIT = 160;
/** Bound of the one error line a fail-fast report keeps from a failed call. */
export const FAILURE_LINE_LIMIT = 120;

/** The machine-readable failure vocabulary. `other` is the honest catch-all for
 * a call that failed without a recognizable cause, never a classification
 * invented from an unknown string. */
export type ToolFailureKind =
	| "not-found"
	| "no-match"
	| "denied"
	| "host-error"
	| "timeout"
	| "aborted"
	| "invalid-args"
	| "other";

export const TOOL_FAILURE_KINDS: readonly ToolFailureKind[] = [
	"not-found",
	"no-match",
	"denied",
	"host-error",
	"timeout",
	"aborted",
	"invalid-args",
	"other",
];

/** Ordered `[pattern, replacement]` pairs. The specific shapes (private keys,
 * known key prefixes, bearer tokens, URL credentials) run before the generic
 * `name=value` rules, and every rule keeps the *name*: the digest stays
 * readable enough to identify the call while the value is gone. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
		"«redacted:private-key»",
	],
	[/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "«redacted:key»"],
	[/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "«redacted:token»"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "«redacted:token»"],
	[/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "«redacted:token»"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "«redacted:aws-key»"],
	[/\bAIza[0-9A-Za-z_-]{20,}/g, "«redacted:api-key»"],
	[
		/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
		"«redacted:jwt»",
	],
	// URL credentials: `scheme://user:secret@host`.
	[/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1«redacted»@"],
	// Header and flag forms.
	[
		/\b[Aa]uthorization:\s*(?:Bearer\s+|Basic\s+)?\S+/g,
		"Authorization: «redacted»",
	],
	[/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer «redacted»"],
	[
		/(^|\s)(--password|--passwd|--token|--api-key)(=|\s+)(\S+)/gi,
		"$1$2$3«redacted»",
	],
	// `-p` is only a password flag when a separator follows it: `-print` and
	// `--prepare` are single-dash flags, not credentials.
	[/(^|\s)(-p)(=|\s+)(\S+)/g, "$1$2$3«redacted»"],
	// An environment assignment: `KEY=value` with a shell-style name, and any
	// `name=value` whose name says it is a secret.
	[/\b([A-Z][A-Z0-9_]{2,})=(\S+)/g, "$1=«redacted»"],
	[
		/\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|credential|auth)[A-Za-z0-9_-]*)=(\S+)/gi,
		"$1=«redacted»",
	],
	// A long unbroken alphanumeric run is a plausible raw credential. The
	// lookarounds keep it to a standalone token, so a path or URL survives.
	[/(?<![\w/.-])[A-Za-z0-9+/=_-]{60,}(?![\w/.-])/g, "«redacted:blob»"],
];

/** Replace every recognized secret shape. Idempotent and safe on any text. */
export function redactToolText(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS)
		out = out.replace(pattern, replacement);
	return out;
}

function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Redact, then bound: the bound may never cut a secret in half. */
function boundedRedacted(text: string, max: number): string {
	const redacted = flatten(redactToolText(text));
	return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/** The fixed-size fields recorded for one call's arguments. */
export interface ToolArgsTelemetry {
	/** Stable hash of the argument JSON: exact repeats join on it. */
	hash: string;
	/** Bounded (<= 200 chars), secret-free summary of *what was asked*. */
	digest: string;
	/** Byte length of the argument JSON — a size, never the content. */
	bytes: number;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return '"<unserializable>"';
	}
}

function firstString(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

/** What identifies the call: a path, a search path plus pattern, a URL, or the
 * command head — the command's first 120 characters, redacted. */
function argumentDetail(args: unknown): string {
	if (typeof args === "string") return commandDigest(args);
	if (args === null || typeof args !== "object" || Array.isArray(args))
		return "";
	const record = args as Record<string, unknown>;
	const path = firstString(record, ["path", "file", "file_path", "filePath"]);
	const pattern = firstString(record, ["pattern", "query", "search"]);
	const command = firstString(record, ["command", "cmd"]);
	const url = firstString(record, ["url"]);
	if (pattern !== undefined)
		return boundedRedacted(`${path ?? "."} /${pattern}/`, COMMAND_DIGEST_LIMIT);
	if (command !== undefined) return commandDigest(command);
	if (path !== undefined) return boundedRedacted(path, DETAIL_LIMIT);
	if (url !== undefined) return boundedRedacted(url, COMMAND_DIGEST_LIMIT);
	const first = Object.values(record).find(
		(value) => typeof value === "string" && value.length > 0,
	);
	return typeof first === "string" ? commandDigest(first) : "";
}

/** `git status -sb` → `git status -sb` (redacted, bounded); the program stays
 * first so a reader can still group by command. */
function commandDigest(command: string): string {
	const text = flatten(command);
	if (text.length === 0) return "";
	return boundedRedacted(text, COMMAND_DIGEST_LIMIT);
}

/**
 * Derive the recorded argument fields for one call. The digest is prefixed with
 * the tool name, matching the dataset's own convention (`read src/a.ts`,
 * `bash git status -sb`), so old and new rows read the same way.
 */
export function toolArgsTelemetry(
	tool: string,
	args: unknown,
): ToolArgsTelemetry {
	const json = safeJson(args);
	const detail = argumentDetail(args);
	const digest = boundedRedacted(`${tool} ${detail}`, ARGS_DIGEST_LIMIT);
	return {
		hash: createHash("sha256").update(json, "utf8").digest("hex").slice(0, 16),
		digest,
		bytes: Buffer.byteLength(json, "utf8"),
	};
}

/** The parts of a tool result a durable envelope records. Structurally typed so
 * this module never depends on a harness entry's full shape. */
export interface ToolResultEntryLike {
	readonly model?: readonly unknown[];
	readonly data?: unknown;
}

interface DiagnosticLike {
	readonly code?: string;
	readonly message?: string;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type !== "text") continue;
		if (typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("");
}

/** The committed `toolResult` message of a result entry, or `undefined` when no
 * result entry survived (the call faulted or was orphaned). */
function resultMessage(
	entry: ToolResultEntryLike | undefined,
): Record<string, unknown> | undefined {
	if (entry === undefined) return undefined;
	const messages = Array.isArray(entry.model) ? entry.model : [];
	return messages.find((candidate) => {
		if (candidate === null || typeof candidate !== "object") return false;
		return (candidate as { role?: unknown }).role === "toolResult";
	}) as Record<string, unknown> | undefined;
}

/** The result text of one call, or the empty string when there is none. Used
 * only to derive a failure kind or a bounded error line; never returned as
 * payload. */
function resultText(entry: ToolResultEntryLike | undefined): string {
	const message = resultMessage(entry);
	return message === undefined ? "" : textOf(message.content);
}

function diagnosticsOf(entry: ToolResultEntryLike): DiagnosticLike[] {
	const data = entry.data;
	if (data === null || typeof data !== "object") return [];
	const list = (data as { diagnostics?: unknown }).diagnostics;
	if (!Array.isArray(list)) return [];
	const out: DiagnosticLike[] = [];
	for (const item of list) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		out.push({
			...(typeof record.code === "string" ? { code: record.code } : {}),
			...(typeof record.message === "string"
				? { message: record.message }
				: {}),
		});
	}
	return out;
}

/** Diagnostic codes that mean the harness retained only part of the output. */
const TRUNCATION_CODES: ReadonlySet<string> = new Set([
	"truncated",
	"full_output",
]);

/** The fixed-size facts of one tool result. `text` is used only to derive the
 * failure kind and is never returned. */
export interface ToolResultTelemetry {
	readonly isError: boolean;
	readonly bytes: number;
	readonly lines: number;
	readonly truncated: boolean;
}

/** Read the result's size and error flag from the tool-result entry. Returns
 * `undefined` when no result entry survived (the call faulted or was orphaned);
 * the caller records that as a host error. */
export function toolResultTelemetry(
	entry: ToolResultEntryLike | undefined,
): ToolResultTelemetry | undefined {
	const message = resultMessage(entry);
	if (entry === undefined || message === undefined) return undefined;
	const text = resultText(entry);
	return {
		isError: message.isError === true,
		bytes: Buffer.byteLength(text, "utf8"),
		lines: text.length === 0 ? 0 : text.split("\n").length,
		truncated: diagnosticsOf(entry).some(
			(diagnostic) =>
				diagnostic.code !== undefined && TRUNCATION_CODES.has(diagnostic.code),
		),
	};
}

/** Ordered `[kind, pattern]` rules over the failure's bounded text. The first
 * match wins; a call that matches none is `other`. */
const FAILURE_RULES: ReadonlyArray<readonly [ToolFailureKind, RegExp]> = [
	["aborted", /\babort(?:ed)?\b|cancell?ed|interrupted/],
	["timeout", /\btimed out\b|\btimeout\b|deadline exceeded/],
	// The words are deliberately specific: `sandbox` and `abort` appear in
	// ordinary paths (`agentic-coding-test-sandbox-…`) and in a command's own
	// output, and a digest-level false positive would mislabel the failure kind.
	[
		"denied",
		/permission denied|eacces|eperm|not permitted|operation not permitted|read-only file system|escapes the repository|outside the repository|refus(?:ed|es)|denied|not allowed/,
	],
	[
		"no-match",
		/could not find|no changes made|occurrences of the text|must be unique|replacement range|different line count|no match(?:es)?\b|nothing matched|string to replace|exact text/,
	],
	[
		"not-found",
		/no such file|enoent|does not exist|not found|beyond end of file|unknown tool/,
	],
	[
		"invalid-args",
		/must not be empty|is invalid|must be a |must contain|replacement range is invalid|unexpected|regex parse error|unrecognized|invalid (?:timeout|argument|input|parameter|value)|missing (?:required )?(?:argument|parameter|field)|schema/,
	],
];

/**
 * Classify a failed call. A call whose result entry never survived is a
 * `host-error` (the tool task faulted or was orphaned) — the distinction the
 * old `tool_error`/`error` vocabulary could not make. Everything else is read
 * from the result's text and diagnostic codes, which are used to pick a code
 * and never stored.
 */
export function classifyToolFailure(
	entry: ToolResultEntryLike | undefined,
): ToolFailureKind {
	if (entry === undefined) return "host-error";
	const message = resultText(entry);
	const haystack = `${message} ${diagnosticsOf(entry)
		.map((diagnostic) => `${diagnostic.code ?? ""} ${diagnostic.message ?? ""}`)
		.join(" ")}`;
	const lowered = haystack.toLowerCase();
	if (/unsupported_image|unsupported image/.test(lowered))
		return "invalid-args";
	for (const [kind, pattern] of FAILURE_RULES)
		if (pattern.test(lowered)) return kind;
	return "other";
}

/** One bounded, secret-free line of a failed call's own error text, or
 * `undefined` when there is none (a call whose result entry never survived has
 * no text at all). Only the first non-empty line is kept, redacted before it is
 * bound, so a fail-fast report can name the failure without carrying a payload
 * or a secret. */
export function toolFailureLine(
	entry: ToolResultEntryLike | undefined,
): string | undefined {
	for (const line of resultText(entry).split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return boundedRedacted(trimmed, FAILURE_LINE_LIMIT);
	}
	return undefined;
}

/** Whether a failure kind is one this module can produce (the dataset refuses
 * any other vocabulary rather than storing an unknown string). */
export function isToolFailureKind(value: string): value is ToolFailureKind {
	return (TOOL_FAILURE_KINDS as readonly string[]).includes(value);
}
