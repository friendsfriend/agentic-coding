import path from "node:path";
import * as z from "zod/v4";
import type { ProviderConfig, ProviderType } from "../domain/provider.ts";
import { readConfigurationJson } from "./read-json.ts";

const providerSchema = z.object({
	name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	type: z.enum(["github", "gitlab"]),
	baseUrl: z.string().min(1).max(256).optional(),
	username: z.string().max(128).optional(),
	tokenRef: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
		.max(128)
		.optional(),
});
const configSchema = z.object({
	providers: z.array(providerSchema).max(32).default([]),
});

function defaultBaseUrl(type: ProviderType) {
	return type === "github" ? "https://api.github.com" : "https://gitlab.com";
}

function providerUrl(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid provider base URL");
	}
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		throw new Error("Provider base URL must use HTTPS");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Invalid provider base URL");
	return url.origin;
}

/** Read only the configured provider registry from the v2 `config.json`.
 * Tokens stay as references; no secret value is read here. */
export function readProviderConfigs(configDir: string): ProviderConfig[] {
	const file = path.join(path.resolve(configDir), "config.json");
	const config = configSchema.parse(readConfigurationJson(file));
	const names = new Set<string>();
	return config.providers.map((provider) => {
		if (names.has(provider.name)) throw new Error("Duplicate provider name");
		names.add(provider.name);
		return {
			name: provider.name,
			type: provider.type,
			baseUrl: providerUrl(provider.baseUrl ?? defaultBaseUrl(provider.type)),
			username: provider.username ?? "",
			tokenRef: provider.tokenRef ?? "",
		};
	});
}
