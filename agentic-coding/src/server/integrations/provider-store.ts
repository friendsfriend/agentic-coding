// Provider credential store, ported from `server/pkg/provider/provider.go`
// (`port-git-providers-and-ai-to-bun`, task 2.1). Credentials never live in a
// provider definition file: the file keeps `${...}` placeholders and the value
// lives in the config `.env`, which is why a clear-text file is reported as
// invalid rather than loaded.
//
// Reference resolution happens on the parsed document, field by field
// (unify-json-configuration-directory, task 3.2). Substituting into the raw JSON
// text first — the behavior this replaced — corrupts the document whenever a
// secret contains a quote, a backslash or a newline.
import fs from "node:fs";
import path from "node:path";
import {
	type EnvReferenceScope,
	envReferenceName,
	loadEnvFile,
	removeEnvFileKeys,
	resolveEnvReference,
	upsertEnvFile,
} from "../../env-file.ts";

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
		const scope: EnvReferenceScope = {
			fileVars:
				this.envFilePath === ""
					? new Map<string, string>()
					: loadEnvFile(this.envFilePath),
		};

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
			// Parse before resolving: a secret must never be spliced into JSON source.
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

			const { username, token, missingVars } = resolveProviderCredentials(
				parsed,
				scope,
			);
			const name = text(parsed.name) || entry.name.slice(0, -".json".length);
			providers.set(name, {
				name,
				type: text(parsed.type),
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
		// Only credentials the operator actually supplied are written to the root
		// `.env`. An empty field keeps whatever the file already references, so a
		// value resolved from the process environment is never materialized into
		// `.env` by an unrelated edit.
		const supplied = new Map<string, string>();
		if (this.envFilePath !== "") {
			const keys = providerCredentialEnvKeys(provider.name);
			if (provider.username !== "") supplied.set(keys[0], provider.username);
			if (provider.token !== "") supplied.set(keys[1], provider.token);
		}
		const stable = { ...provider };
		if (supplied.size === 0) {
			const existing = this.providers.get(provider.name);
			if (existing) {
				stable.username = existing.username;
				stable.token = existing.token;
			}
		} else if (stable.token === "") {
			const existing = this.providers.get(provider.name);
			if (existing) stable.token = existing.token;
		}
		this.providers.set(stable.name, stable);
		this.invalid.delete(stable.name);
		this.saveProviderFile(stable, supplied);
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

	private saveProviderFile(
		provider: Provider,
		supplied: ReadonlyMap<string, string>,
	): void {
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o755 });
		const filePath = path.join(this.dir, `${provider.name}.json`);
		let toWrite = provider;
		if (this.envFilePath !== "") {
			const keys = providerCredentialEnvKeys(provider.name);
			if (supplied.size > 0) {
				try {
					upsertEnvFile(this.envFilePath, supplied);
				} catch (error) {
					throw new ProviderStoreError(
						`failed to write provider credentials to env file: ${message(error)}`,
					);
				}
			}
			// The file always keeps references; a field the operator did not supply
			// keeps the reference it already had.
			const previous = fs.existsSync(filePath)
				? parseProviderFile(provider.name, fs.readFileSync(filePath, "utf8"))
				: {};
			const previousUsername = text(previous.username);
			const previousToken = text(previous.token);
			toWrite = {
				...provider,
				username:
					!supplied.has(keys[0]) && isEnvPlaceholder(previousUsername)
						? previousUsername
						: `\${${keys[0]}}`,
				token:
					!supplied.has(keys[1]) && isEnvPlaceholder(previousToken)
						? previousToken
						: `\${${keys[1]}}`,
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

/**
 * Resolve the reference-capable fields of one provider file. Only a
 * whole-value `${VAR}` reference is resolved; a literal is never a credential
 * here (clear-text values were already reported invalid), and a non-string
 * field is not coerced into one. A missing name is reported by name only — the
 * resolved value is never logged, stored or returned in an error.
 */
function resolveProviderCredentials(
	parsed: RawProviderFile,
	scope: EnvReferenceScope,
): { username: string; token: string; missingVars: string[] } {
	const missing = new Set<string>();
	const resolve = (value: unknown): string => {
		const literal = text(value);
		if (literal === "") return "";
		const name = envReferenceName(literal);
		if (name === undefined) return literal;
		const resolved = resolveEnvReference(name, scope);
		if (resolved === undefined) {
			missing.add(name);
			return "";
		}
		return resolved;
	};
	return {
		username: resolve(parsed.username),
		token: resolve(parsed.token),
		missingVars: [...missing],
	};
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
