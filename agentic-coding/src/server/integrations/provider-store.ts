// Provider credential store, ported from `server/pkg/provider/provider.go`
// (`port-git-providers-and-ai-to-bun`, task 2.1). Credentials never live in a
// provider definition file: the file keeps `${...}` placeholders and the value
// lives in the config `.env`, which is why a clear-text file is reported as
// invalid rather than loaded.
import fs from "node:fs";
import path from "node:path";
import {
	loadEnvFile,
	removeEnvFileKeys,
	substituteVarsWithWarnings,
	upsertEnvFile,
} from "./env-file.ts";

export const PROVIDER_TYPE_GITHUB = "github";
export const PROVIDER_TYPE_GITLAB = "gitlab";

export interface Provider {
	name: string;
	type: string;
	username: string;
	token: string;
	missingVars: string[];
}

export interface InvalidProvider {
	name: string;
	type: string;
	file: string;
	reason: string;
	message: string;
}

export class ProviderStoreError extends Error {
	readonly code = "provider-store";
	constructor(message: string) {
		super(message);
		this.name = "ProviderStoreError";
	}
}

interface RawProviderFile {
	name?: unknown;
	type?: unknown;
	username?: unknown;
	token?: unknown;
}

export class ProviderStore {
	readonly dir: string;
	readonly envFilePath: string;
	private providers = new Map<string, Provider>();
	private invalid = new Map<string, InvalidProvider>();

	constructor(dir: string, envFilePath: string) {
		this.dir = dir;
		this.envFilePath = envFilePath;
	}

	/**
	 * Reload every provider file. A file with clear-text credentials is
	 * reported through `invalidProviders()`; unparseable content fails the
	 * whole load rather than publishing a partial snapshot.
	 */
	load(): void {
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o755 });
		const envVars =
			this.envFilePath === "" ? undefined : loadEnvFile(this.envFilePath);

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.dir, { withFileTypes: true });
		} catch (error) {
			throw new ProviderStoreError(
				`failed to read providers directory ${this.dir}: ${message(error)}`,
			);
		}

		const providers = new Map<string, Provider>();
		const invalid = new Map<string, InvalidProvider>();
		for (const entry of entries) {
			if (entry.isDirectory() || !entry.name.endsWith(".json")) continue;
			let raw: string;
			try {
				raw = fs.readFileSync(path.join(this.dir, entry.name), "utf8");
			} catch (error) {
				throw new ProviderStoreError(
					`failed to read provider file ${entry.name}: ${message(error)}`,
				);
			}
			const parsed = parseProviderFile(entry.name, raw);
			const clearText = clearTextCredentialError(entry.name, parsed);
			if (clearText !== null) {
				const name = text(parsed.name) || entry.name.slice(0, -".json".length);
				invalid.set(name, {
					name,
					type: text(parsed.type),
					file: entry.name,
					reason: "clear-text-credentials",
					message: clearText,
				});
				continue;
			}

			let content = raw;
			let missingVars: string[] = [];
			if (envVars) {
				const substituted = substituteVarsWithWarnings(content, envVars);
				content = substituted.text;
				missingVars = substituted.missing;
			}
			const resolved = parseProviderFile(entry.name, content);
			let username = text(resolved.username);
			let token = text(resolved.token);
			if (isEnvPlaceholder(username)) username = "";
			if (isEnvPlaceholder(token)) token = "";
			const name = text(resolved.name) || entry.name.slice(0, -".json".length);
			providers.set(name, {
				name,
				type: text(resolved.type),
				username,
				token,
				missingVars,
			});
		}

		this.providers = providers;
		this.invalid = invalid;
	}

	get(name: string): Provider | undefined {
		return this.providers.get(name);
	}

	/** Providers sorted by name: the Go store listed a map, so the set content
	 * is the contract, not an incidental iteration order. */
	list(): Provider[] {
		return [...this.providers.values()].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
	}

	invalidProviders(): InvalidProvider[] {
		return [...this.invalid.values()].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
	}

	/** Persist a provider. An empty token keeps the stored one so an edit that
	 * only changes the username does not silently drop the credential. */
	save(provider: Provider): void {
		validateProvider(provider);
		for (const name of this.providers.keys()) {
			if (
				name !== provider.name &&
				sanitizeProviderEnvName(name) === sanitizeProviderEnvName(provider.name)
			)
				throw new ProviderStoreError(
					`provider name ${quote(provider.name)} collides with existing provider ${quote(name)} for env credential keys`,
				);
		}
		const toWrite = { ...provider };
		if (toWrite.token === "") {
			const existing = this.providers.get(provider.name);
			if (existing) toWrite.token = existing.token;
		}
		this.providers.set(toWrite.name, toWrite);
		this.invalid.delete(toWrite.name);
		this.saveProviderFile(toWrite);
	}

	delete(name: string): void {
		let fileName = `${name}.json`;
		if (!this.providers.has(name)) {
			const invalidProvider = this.invalid.get(name);
			if (!invalidProvider)
				throw new ProviderStoreError(`provider ${quote(name)} not found`);
			if (invalidProvider.file !== "") fileName = invalidProvider.file;
		}
		const filePath = path.join(this.dir, fileName);
		try {
			fs.rmSync(filePath);
		} catch (error) {
			if (!isMissing(error))
				throw new ProviderStoreError(
					`failed to delete provider file ${filePath}: ${message(error)}`,
				);
		}
		if (this.envFilePath !== "") {
			try {
				removeEnvFileKeys(this.envFilePath, providerCredentialEnvKeys(name));
			} catch (error) {
				throw new ProviderStoreError(
					`failed to remove provider credential env entries: ${message(error)}`,
				);
			}
		}
		this.providers.delete(name);
		this.invalid.delete(name);
	}

	credentialsFor(name: string): { username: string; token: string } {
		const provider = this.get(name);
		if (!provider) return { username: "", token: "" };
		return { username: provider.username, token: provider.token };
	}

	private saveProviderFile(provider: Provider): void {
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o755 });
		let toWrite = provider;
		if (this.envFilePath !== "") {
			const keys = providerCredentialEnvKeys(provider.name);
			try {
				upsertEnvFile(
					this.envFilePath,
					new Map([
						[keys[0], provider.username],
						[keys[1], provider.token],
					]),
				);
			} catch (error) {
				throw new ProviderStoreError(
					`failed to write provider credentials to env file: ${message(error)}`,
				);
			}
			toWrite = {
				...provider,
				username: `\${${keys[0]}}`,
				token: `\${${keys[1]}}`,
			};
		}
		// Field order and 2-space indentation match the Go encoding so a
		// written provider file is byte-identical.
		const payload: Record<string, unknown> = {
			name: toWrite.name,
			type: toWrite.type,
			username: toWrite.username,
			token: toWrite.token,
		};
		if (toWrite.missingVars.length > 0)
			payload.missing_vars = toWrite.missingVars;
		const filePath = path.join(this.dir, `${provider.name}.json`);
		fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), {
			mode: 0o600,
		});
	}
}

export function providerCredentialEnvKeys(name: string): [string, string] {
	const base = `DEVENV_PROVIDER_${sanitizeProviderEnvName(name)}`;
	return [`${base}_USERNAME`, `${base}_TOKEN`];
}

export function sanitizeProviderEnvName(name: string): string {
	let out = "";
	let lastUnderscore = false;
	for (const char of name.toUpperCase()) {
		if (/[A-Z0-9]/.test(char)) {
			out += char;
			lastUnderscore = false;
			continue;
		}
		if (!lastUnderscore) {
			out += "_";
			lastUnderscore = true;
		}
	}
	return out.replace(/^_+|_+$/g, "");
}

function parseProviderFile(fileName: string, raw: string): RawProviderFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ProviderStoreError(
			`failed to parse provider file ${fileName}: ${message(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new ProviderStoreError(
			`failed to parse provider file ${fileName}: expected a JSON object`,
		);
	return parsed as RawProviderFile;
}

function clearTextCredentialError(
	fileName: string,
	provider: RawProviderFile,
): string | null {
	const username = text(provider.username);
	if (username !== "" && !isEnvPlaceholder(username))
		return `provider file ${fileName} contains clear-text username; move credentials to .env and use \${...} placeholders`;
	const token = text(provider.token);
	if (token !== "" && !isEnvPlaceholder(token))
		return `provider file ${fileName} contains clear-text token; move credentials to .env and use \${...} placeholders`;
	return null;
}

function isEnvPlaceholder(value: string): boolean {
	return value.startsWith("${") && value.endsWith("}") && value.length > 3;
}

function validateProvider(provider: Provider): void {
	if (provider.name === "")
		throw new ProviderStoreError("provider name is required");
	if (
		provider.type !== PROVIDER_TYPE_GITHUB &&
		provider.type !== PROVIDER_TYPE_GITLAB
	)
		throw new ProviderStoreError(
			`provider type must be ${quote(PROVIDER_TYPE_GITHUB)} or ${quote(PROVIDER_TYPE_GITLAB)}, got ${quote(provider.type)}`,
		);
	if (/[/\\:*?"<>|]/.test(provider.name))
		throw new ProviderStoreError("provider name contains invalid characters");
	if (sanitizeProviderEnvName(provider.name) === "")
		throw new ProviderStoreError(
			"provider name must contain a letter or number",
		);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Go's `%q` for the diagnostics the ported messages reproduce verbatim. */
function quote(value: string): string {
	return JSON.stringify(value);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
