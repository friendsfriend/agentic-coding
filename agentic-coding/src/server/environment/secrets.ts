import path from "node:path";
import { loadEnvFile } from "../../env-file.ts";
import { MIN_SECRET_CHARS } from "../redaction.ts";

export interface EnvironmentSecret {
	readonly name: string;
	readonly value: string;
}

/** Values declared in a configuration .env file, longest first. */
export function environmentSecrets(configDir: string): EnvironmentSecret[] {
	const secrets: EnvironmentSecret[] = [];
	if (configDir !== "") {
		for (const [name, value] of loadEnvFile(path.join(configDir, ".env")))
			if (value.trim() !== "") secrets.push({ name, value });
	}
	return secrets.sort((left, right) => right.value.length - left.value.length);
}

function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactString(
	value: string,
	secrets: readonly EnvironmentSecret[],
): string {
	let redacted = value;
	for (const secret of secrets) {
		if (!redacted.includes(secret.value)) continue;
		const marker = `«redacted:${secret.name}»`;
		if (secret.value.length >= MIN_SECRET_CHARS) {
			redacted = redacted.split(secret.value).join(marker);
			continue;
		}
		const assignment = new RegExp(
			`(${escapePattern(secret.name)}\\s*[=:]\\s*['"]?)${escapePattern(secret.value)}(['"]?)`,
			"g",
		);
		redacted = redacted.replace(assignment, `$1${marker}$2`);
	}
	return redacted;
}

/** Do not publish a suffix that could become a secret when the next chunk
 * arrives. Progress uses snapshots; the final response flushes the full value. */
export function redactProgress(
	value: string,
	secrets: readonly EnvironmentSecret[],
): string {
	let end = value.length;
	for (const secret of secrets) {
		for (
			let size = Math.min(secret.value.length - 1, value.length);
			size > 0;
			size--
		) {
			if (value.endsWith(secret.value.slice(0, size))) {
				end = Math.min(end, value.length - size);
				break;
			}
		}
	}
	// A held suffix may overlap another complete secret. Move the boundary to
	// its start rather than exposing that secret's now-incomplete prefix.
	let previous = -1;
	while (previous !== end) {
		previous = end;
		for (const secret of secrets) {
			if (!secret.value) continue;
			let start = value.indexOf(secret.value);
			while (start >= 0 && start < end) {
				if (start + secret.value.length > end) {
					end = start;
					break;
				}
				start = value.indexOf(secret.value, start + 1);
			}
		}
	}
	return redactString(value.slice(0, end), secrets);
}

/** Deep-replace declared secret values in one response or stored artifact. */
export function redact(
	value: unknown,
	secrets: readonly EnvironmentSecret[],
): unknown {
	if (secrets.length === 0) return value;
	if (typeof value === "string") return redactString(value, secrets);
	if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value))
		out[key] = redact(item, secrets);
	return out;
}
