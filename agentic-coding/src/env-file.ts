// The one `.env` contract for the selected configuration root
// (unify-json-configuration-directory, task 3.1). Every reader and writer of a
// root `.env` goes through this module so the supported syntax, the preserving
// write and the file permissions cannot drift between the environment
// bootstrap, the provider store and the migration.
//
// Supported input (all of it tested): blank and `#` comment lines,
// `KEY=value`, single- or double-quoted values, the `export KEY=value` form, and
// the backslash escapes `\\`, `\'`, `\"`, `\n`, `\t`, `\r` inside a quoted
// value. The escapes are what make a credential containing a quote, a backslash
// or a newline survive the line-based format exactly. Nothing here evaluates
// shell syntax, performs substitutions, or auto-loads a `.env` from the current
// directory: a caller always names the file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `${VAR}` used as the entire value of a reference-capable field. */
const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Read a `.env` file into key/value pairs. A missing file is an empty map. */
export function loadEnvFile(filePath: string): Map<string, string> {
	const vars = new Map<string, string>();
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (isMissing(error)) return vars;
		throw error;
	}
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const stripped = line.replace(/^export\s+/, "");
		const separator = stripped.indexOf("=");
		if (separator < 0) continue;
		const key = stripped.slice(0, separator).trim();
		const value = unquoteEnvValue(stripped.slice(separator + 1).trim());
		if (key !== "") vars.set(key, value);
	}
	return vars;
}

/**
 * Expand the bootstrap-only `$HOME`/`${HOME}` syntax. Parsing stays literal —
 * a credential is a credential — so only the one bootstrap value that has
 * always accepted a home-relative path is expanded, at the point it is used.
 */
export function expandEnvHome(
	value: string,
	home: string = os.homedir(),
): string {
	return value.replace(/\$\{HOME\}|\$HOME/g, home);
}

/** True when a value is exactly one `${VARIABLE}` reference. */
export function isEnvReference(value: string): boolean {
	return WHOLE_REFERENCE.test(value);
}

/** The variable name inside a whole-value reference, if it is one. */
export function envReferenceName(value: string): string | undefined {
	return WHOLE_REFERENCE.exec(value)?.[1];
}

export interface EnvReferenceScope {
	/** Values read from the selected root's `.env`. */
	readonly fileVars: ReadonlyMap<string, string>;
	/** Explicitly supplied environment. Takes precedence, including for an
	 * explicitly empty value. Defaults to the process environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve a reference: an explicitly supplied process value first (an empty
 * value is a real value, not a miss), then the root `.env`. Returns undefined
 * for an unknown name so the caller can report field and variable names without
 * inventing a value.
 */
export function resolveEnvReference(
	name: string,
	scope: EnvReferenceScope,
): string | undefined {
	const env = scope.env ?? process.env;
	const explicit = env[name];
	if (explicit !== undefined) return explicit;
	return scope.fileVars.get(name);
}

/**
 * Update or append keys while preserving unrelated lines. The write goes to a
 * sibling temporary file and is renamed into place, so a crash cannot truncate
 * a secret; the result is always owner-only.
 */
export function upsertEnvFile(
	filePath: string,
	values: ReadonlyMap<string, string>,
): void {
	const lines = readEnvLines(filePath);
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const key = envLineKey(lines[i]);
		if (key === "" || key.startsWith("#")) continue;
		const value = values.get(key);
		if (value !== undefined) {
			lines[i] = `${key}=${quoteEnvValue(value)}`;
			seen.add(key);
		}
	}
	const appended = [...values.keys()].filter((key) => !seen.has(key)).sort();
	for (const key of appended)
		lines.push(`${key}=${quoteEnvValue(values.get(key) ?? "")}`);
	writeEnvLines(filePath, lines);
}

/** Remove selected keys while preserving unrelated lines. */
export function removeEnvFileKeys(
	filePath: string,
	keys: readonly string[],
): void {
	const remove = new Set(keys);
	const kept = readEnvLines(filePath).filter(
		(line) => !remove.has(envLineKey(line)),
	);
	writeEnvLines(filePath, kept);
}

function envLineKey(line: string): string {
	const trimmed = line.trim().replace(/^export\s+/, "");
	const separator = trimmed.indexOf("=");
	if (separator < 0) return "";
	return trimmed.slice(0, separator).trim();
}

function readEnvLines(filePath: string): string[] {
	let data: string;
	try {
		data = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const text = data.endsWith("\n") ? data.slice(0, -1) : data;
	return text === "" ? [] : text.split("\n");
}

function writeEnvLines(filePath: string, lines: readonly string[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
	// Atomic owner-only publication: the mode applies to the temporary file that
	// becomes the `.env`, so the secret is never briefly world-readable.
	const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { mode: 0o600 });
		fs.chmodSync(temporary, 0o600);
		fs.renameSync(temporary, filePath);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function quoteEnvValue(value: string): string {
	if (value === "" || /[ \t#'"\\\n\r]/.test(value))
		return `'${escapeEnvValue(value)}'`;
	return value;
}

/** Single-pass escape so one backslash can never be decoded twice. */
function escapeEnvValue(value: string): string {
	return value.replace(/[\\'\n\t\r]/g, (char) => {
		switch (char) {
			case "\\":
				return "\\\\";
			case "'":
				return "\\'";
			case "\n":
				return "\\n";
			case "\t":
				return "\\t";
			default:
				return "\\r";
		}
	});
}

/** Single-pass unescape with the same table as {@link escapeEnvValue}. */
function unescapeEnvValue(value: string): string {
	return value.replace(/\\([\\'"ntr])/g, (_match, char: string) => {
		switch (char) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			default:
				return char;
		}
	});
}

function unquoteEnvValue(value: string): string {
	if (value.length >= 2) {
		const quote = value[0];
		if ((quote === "'" || quote === '"') && value.endsWith(quote)) {
			return unescapeEnvValue(value.slice(1, -1));
		}
	}
	return value;
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
