import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UiCapabilityApi } from "../../src/ui/capability-api.ts";
import { createHttpUiCapabilityApi } from "../../src/ui/http-capability-api.ts";

const DEFAULT_URL = "http://127.0.0.1:38471";
const DEFAULT_TOKEN_FILE = join(
	homedir(),
	".config/environment-mcp/client-token",
);

function optionText(
	options: Readonly<Record<string, unknown>> | undefined,
	key: string,
): string | undefined {
	const value = options?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "environment-request-failed";
}

/** Reads the same loopback capability endpoint the standalone OpenTUI uses.
 * The plugin never imports MCP registration, listeners or service internals. */
export function createEnvironmentApi(
	options?: Readonly<Record<string, unknown>>,
): UiCapabilityApi {
	const url =
		optionText(options, "url") ??
		process.env.ENVIRONMENT_MCP_URL ??
		DEFAULT_URL;
	const tokenFile =
		optionText(options, "tokenFile") ??
		process.env.ENVIRONMENT_MCP_TOKEN_FILE ??
		DEFAULT_TOKEN_FILE;
	let token: string;
	try {
		token = readFileSync(tokenFile, "utf8").trim();
	} catch {
		throw new Error(`client token unavailable: ${tokenFile}`);
	}
	if (!token) throw new Error(`client token is empty: ${tokenFile}`);
	try {
		return createHttpUiCapabilityApi({ url, token });
	} catch (error) {
		throw new Error(
			`client token invalid (${tokenFile}): ${errorMessage(error)}`,
		);
	}
}

/** Keeps the page controller shape intact when setup fails before an API
 * exists, so the error state and retry path are the same as a network error. */
export function failingApi(message: string): UiCapabilityApi {
	return {
		async list() {
			throw new Error(message);
		},
		async invoke() {
			throw new Error(message);
		},
	};
}
