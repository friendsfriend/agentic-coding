// `.env` reading/writing for provider credentials, ported from
// `server/pkg/resources/envfile.go` (`port-git-providers-and-ai-to-bun`,
// task 2.1). Unrelated lines are preserved on every write, values are quoted
// only when they need it, and the file is tightened to 0600 on each write
// because `writeFile` only applies the mode when it creates the file.
import fs from "node:fs";
import path from "node:path";

const VAR_PATTERN = /\$\{([^}]*)\}/g;

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
		const separator = line.indexOf("=");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim();
		const value = unquoteEnvValue(line.slice(separator + 1).trim());
		if (key !== "") vars.set(key, value);
	}
	return vars;
}

/**
 * Replace `${VAR}` placeholders and report the names that had no value.
 * A malformed placeholder (empty name) is left as-is and not reported.
 */
export function substituteVarsWithWarnings(
	text: string,
	vars: ReadonlyMap<string, string>,
): { text: string; missing: string[] } {
	const missing: string[] = [];
	const substituted = text.replace(VAR_PATTERN, (match, key: string) => {
		if (key === "") return match;
		const value = vars.get(key);
		if (value === undefined) {
			missing.push(key);
			return match;
		}
		return value;
	});
	return { text: substituted, missing };
}

/** Update or append keys while preserving unrelated lines. */
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
	const trimmed = line.trim();
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
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
	fs.writeFileSync(filePath, content, { mode: 0o600 });
	fs.chmodSync(filePath, 0o600);
}

function quoteEnvValue(value: string): string {
	if (value === "" || /[ \t#'"\\]/.test(value)) {
		const escaped = value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
		return `'${escaped}'`;
	}
	return value;
}

function unquoteEnvValue(value: string): string {
	if (value.length >= 2) {
		const quote = value[0];
		if ((quote === "'" || quote === '"') && value.endsWith(quote)) {
			return value
				.slice(1, -1)
				.replaceAll(`\\${quote}`, quote)
				.replaceAll("\\\\", "\\");
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
