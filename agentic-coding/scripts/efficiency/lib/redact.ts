// Secret redaction and bounded digests for the efficiency dataset.
//
// The dataset is built from a read-only snapshot of real transcripts and
// telemetry, which may contain credentials (bash commands with tokens, URLs
// with userinfo, env values, provider keys). Nothing raw leaves this module:
// every free-text field is either hashed, reduced to a bounded digest (a path
// or a command head, never the full text), or passed through `redactText` and
// bounded. That is why the dataset can be reviewed and committed-adjacent
// without becoming a secret leak, and why `redact.test` asserts each rule.

import { createHash } from "node:crypto";

/** Ordered `[pattern, replacement]` pairs. Order matters: the specific shapes
 * (private keys, JWTs, known key prefixes) run before the generic ones so a
 * matched secret is labelled with what it was, not collapsed into a blob. */
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
	[/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://«redacted»@"],
	[/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer «redacted»"],
	[
		/((?:\bapi[_-]?key|\baccess[_-]?token|\bauth[_-]?token|\btoken|\bsecret|\bpassword|\bpasswd|\bpassphrase|\bclient[_-]?secret|\bauthorization)\b\s*[:=]\s*)(?:"|')?(?!Bearer(?:\s|$))(?![«\s])[^\s"',;]{6,}/gi,
		"$1«redacted»",
	],
	// A long unbroken alphanumeric run is a plausible raw credential or blob.
	// The lookarounds keep it to a *standalone* token: a path or URL is made of
	// these characters plus `/`, `.` and `-`, so it never matches and stays
	// readable as a path digest.
	[/(?<![\w/.-])[A-Za-z0-9+/=_-]{60,}(?![\w/.-])/g, "«redacted:blob»"],
];

/** Replace every recognized secret shape. Idempotent and safe on any text. */
export function redactText(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS)
		out = out.replace(pattern, replacement);
	return out;
}

/** `redactText` plus a hard length bound, for fields stored verbatim. */
export function redactBounded(text: string, max: number): string {
	const redacted = redactText(text);
	return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/** A short, space-free value is a code (`verification_requested`,
 * `manual_override`), not prose. Prose never reaches the dataset. */
export function looksLikeCode(value: string): boolean {
	return value.length > 0 && value.length <= 60 && !/\s/.test(value);
}

/** Bounded digest of a free-text field: the text itself is never retained. */
export function textDigest(text: string): { hash: string; bytes: number } {
	return {
		hash: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16),
		bytes: Buffer.byteLength(text, "utf8"),
	};
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function bounded(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A command head: the program the command runs, with env assignments, `cd`
 * targets and shell separators skipped. `FOO=1 cd /tmp && git status -sb`
 * reduces to `git`. Arguments are never kept, so a command carrying a token
 * cannot leak through the digest.
 */
export function commandHead(command: string): string {
	const tokens = command
		.trim()
		.split(/[\s;|&()]+/)
		.filter((token) => token.length > 0);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		if (token === "sudo" || token === "env" || token === "nohup") continue;
		if (token === "cd") {
			index += 1;
			continue;
		}
		return bounded(redactText(token), 40);
	}
	return "";
}

/** A path digest keeps the path (relative paths stay comparable, which is what
 * repeated-read detection needs) but never anything else from the arguments. */
export function pathDigest(value: string): string {
	return bounded(redactText(value), 160);
}

export interface ArgsDigest {
	/** Stable hash of the full argument JSON; joins repeated calls exactly. */
	hash: string;
	/** Short, human-readable, secret-free summary: a path or a command head. */
	digest: string;
	/** Byte length of the argument JSON (a size, not the content). */
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
	value: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

/** Summarize tool arguments without retaining them. Recognized shapes get a
 * purpose-built digest; anything else falls back to the first string value's
 * command head, so the worst case is a bounded first token. */
export function digestToolArgs(tool: string, args: unknown): ArgsDigest {
	const json = safeJson(args);
	let digest = "";
	if (typeof args === "string") digest = commandHead(args);
	else if (args && typeof args === "object" && !Array.isArray(args)) {
		const record = args as Record<string, unknown>;
		const path = firstString(record, ["path", "file", "file_path", "filePath"]);
		const command = firstString(record, ["command", "cmd"]);
		const pattern = firstString(record, ["pattern", "query", "glob", "search"]);
		const url = firstString(record, ["url"]);
		if (path !== undefined) digest = pathDigest(path);
		else if (command !== undefined) digest = commandHead(command);
		else if (pattern !== undefined) digest = bounded(redactText(pattern), 40);
		else if (url !== undefined) digest = bounded(redactText(url), 80);
		else {
			const first = Object.values(record).find(
				(value) => typeof value === "string" && value.length > 0,
			);
			digest = typeof first === "string" ? commandHead(first) : "";
		}
	}
	return {
		hash: sha256Hex(json).slice(0, 16),
		digest: `${bounded(tool, 40)}${digest ? ` ${digest}` : ""}`,
		bytes: Buffer.byteLength(json, "utf8"),
	};
}

/** Heuristic truncation marker used by the agent's own readers. Recorded as a
 * heuristic flag, never as evidence of the exact byte count. */
export function looksTruncated(text: string): boolean {
	return /\[truncated|truncated \d+ (?:bytes|lines)|<truncated>|output truncated|… \[\d+ (?:lines|bytes) omitted\]/i.test(
		text,
	);
}
