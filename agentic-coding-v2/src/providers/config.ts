import { lstatSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { object, text } from "../config.ts";

export type ProviderType = "github" | "gitlab";
export type ProviderConfig = {
	name: string;
	type: ProviderType;
	baseUrl: string;
	username: string;
	tokenRef: string;
	/** CONFIG_DIR/.env: reference target store (v1 kept provider secrets there). */
	envFile?: string;
};
export function defaultBaseUrl(type: ProviderType): string {
	return type === "github" ? "https://api.github.com" : "https://gitlab.com";
}
/** Named providers from config. Tokens are env-var references resolved at call
 * time; nothing secret is stored or echoed. */
export function readProviders(
	value: unknown,
	envFile?: string,
): ProviderConfig[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("providers must be an array");
	return value.map((raw) => {
		const entry = object(raw);
		const name = text(entry.name, "provider name", 64);
		if (!/^[a-z][a-z0-9-]*$/.test(name))
			throw new Error("Invalid provider name");
		const type = text(entry.type, "provider type", 16);
		if (type !== "github" && type !== "gitlab")
			throw new Error("Unsupported provider type");
		const baseUrl =
			entry.baseUrl === undefined
				? defaultBaseUrl(type)
				: text(entry.baseUrl, "provider base URL", 256);
		let url: URL;
		try {
			url = new URL(baseUrl);
		} catch {
			throw new Error("Invalid provider base URL");
		}
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
		if (url.protocol === "http:" && !loopback)
			throw new Error("Provider base URL must use HTTPS");
		if (url.protocol !== "https:" && url.protocol !== "http:")
			throw new Error("Invalid provider base URL");
		return {
			name,
			type,
			baseUrl: url.origin,
			username:
				entry.username === undefined
					? ""
					: text(entry.username, "provider username", 128),
			tokenRef:
				entry.tokenRef === undefined
					? ""
					: text(entry.tokenRef, "provider token reference", 128),
			...(envFile ? { envFile } : {}),
		};
	});
}
export function findProvider(
	providers: readonly ProviderConfig[],
	name: string,
): ProviderConfig {
	const provider = providers.find((entry) => entry.name === name);
	if (!provider) throw new Error("Unknown provider");
	return provider;
}
/** Token materialized only for the outbound call. Empty means tokenless. */
export function providerToken(provider: ProviderConfig): string {
	if (!provider.tokenRef) return "";
	const explicit = process.env[provider.tokenRef];
	if (explicit) return explicit;
	return provider.envFile
		? (readSecrets(provider.envFile)[provider.tokenRef] ?? "")
		: "";
}
/** The bounded private `.env` a provider reference may resolve from. */
export function readSecrets(file: string): Record<string, string> {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > 65536) return {};
		return parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}
export function providerProjection(provider: ProviderConfig): {
	name: string;
	type: ProviderType;
	baseUrl: string;
	username: string;
	has_token: boolean;
} {
	return {
		name: provider.name,
		type: provider.type,
		baseUrl: provider.baseUrl,
		username: provider.username,
		has_token: providerToken(provider) !== "",
	};
}
