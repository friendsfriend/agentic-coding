// The models the durable (`pi-durable`) runtime can actually run.
//
// Both pi-durable model surfaces — the dashboard `/model` picker
// (`agent-host/host.ts`'s `catalog`) and the Settings agent-profile model select
// (`tui/settings/agentPresets.ts`) — offer exactly this set: the models of the
// providers the user has configured. Listing pi-ai's whole generated catalog
// instead offered models no credential covers.
//
// "Configured" spans both layers pi itself knows: pi-ai's built-in providers
// plus the custom providers of the user's global pi `models.json`
// (durable-agent-configuration: "Durable model enumeration"). That second layer
// is what a pi-durable-only reader used to miss: a profile bound to
// `eon/<model>` validated at workflow start (that validation reads `models.json`
// directly, `workflow/profiles.ts`) and then found no such provider in the host's
// collection — missing from every picker and unresolvable at launch. The two
// layers are composed by pi's own loader (`ModelRuntime`, which loads
// `models.json` through `ModelConfig` and composes each provider with
// `composeModelProvider`) rather than by a second reading of that file here, so
// pi's schema, its `apiKey` forms (literal / `$ENV_VAR` template / `!command`)
// and its header handling are the ones in force, including its precedence for a
// provider id that collides with a built-in one (the `models.json` entry is
// overlaid on the built-in provider, which keeps its api and gains the
// configured base URL, models and auth).
//
// Availability is resolved in process, from the live global-pi credentials the
// durable runtime already authenticates with (`auth.json` plus the provider's
// environment key, through `agent-host/credentials.ts`). The bundled durable
// runtime ships no model CLI of its own and none is required here: this module
// spawns nothing, so a pi-durable host and its editors depend on no `pi`
// executable at all.
//
// This module carries the pi-ai provider-catalog imports, so a TUI or workflow
// module reaches it through a dynamic `await import(...)` — the same rule
// `agent-host/client.ts` follows — rather than a static import that would load
// the whole provider catalog into an unrelated process. `@earendil-works/
// pi-coding-agent` (the owner of the `models.json` loader) is heavier still and
// is imported inside {@link durableModels}, so a caller that builds its own
// collection (`DurableHostOptions.models`, every focused test) never pays for it.

import path from "node:path";
import type { Models, MutableModels, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PiAuthCredentialStore, piAgentDir } from "./credentials.ts";

/** Global pi's `models.json`, next to the `auth.json` the durable runtime
 * authenticates with — same `PI_CODING_AGENT_DIR` override, same `~/.pi/agent`
 * default (`credentials.ts`'s `piAgentDir`). */
export function modelsJsonPath(agentDir: string = piAgentDir()): string {
	return path.join(agentDir, "models.json");
}

/** pi's `ModelRuntime` persists a refreshed provider catalog to
 * `models-store.json` next to `models.json`. The durable host never refreshes a
 * catalog over the network — it re-reads `models.json` at every host open — so
 * the store is an in-memory no-op and the user's pi agent directory gains no
 * second file the durable host writes behind pi's back. */
const inMemoryModelsStore = {
	read: async () => undefined,
	write: async () => undefined,
	delete: async () => undefined,
};

export interface DurableModelsOptions {
	/** `auth.json` to authenticate with; the durable host passes its own
	 * (`DurableHostOptions.credentialsPath`). Defaults to {@link piAgentDir}. */
	readonly credentialsPath?: string;
	/** The `models.json` to compose in. Defaults to
	 * {@link modelsJsonPath} of the current process environment. */
	readonly modelsPath?: string;
	/** Receives the one diagnostic of a `models.json` that could not be used
	 * (absent files report nothing). The message is pi's own: it names the file
	 * and, for a schema error, the offending paths — never the file's content and
	 * never an `apiKey` value. */
	readonly onDiagnostic?: (message: string) => void;
}

/** The one durable model collection: pi-ai's built-in providers with the custom
 * providers of the user's global pi `models.json` composed over them, ready to
 * hand to the `Harness` and to enumerate for the pickers.
 *
 * Both layers come from pi: `builtinModels` (the same collection the host used
 * before custom providers existed, and still the answer when there is no
 * `models.json`) is the base, and `ModelRuntime.create` supplies each provider
 * pi composes from `models.json` — a custom provider as its own provider, a
 * colliding id as the built-in provider with the file's overlay applied. Never
 * throws and never rejects for a bad file: an absent file adds nothing, an
 * unreadable one, a syntax error and a schema error each leave the built-ins
 * intact and report one diagnostic (through `onDiagnostic`) — a picker is never
 * emptied and a host never fails to open because of this file.
 *
 * `refreshOnCreate: false` skips pi's create-time catalog refresh: this is a
 * read of `models.json`, not a network round trip. */
export async function durableModels(
	options: DurableModelsOptions = {},
): Promise<MutableModels> {
	const credentials = new PiAuthCredentialStore(options.credentialsPath);
	const collection = builtinModels({ credentials: credentials as never });
	const modelsPath = options.modelsPath ?? modelsJsonPath();
	const report = (diagnostic: string): void => {
		// pi's diagnostics span several lines (the error, the file, the schema
		// paths); one line keeps a host log line a line.
		options.onDiagnostic?.(diagnostic.replace(/\s+/g, " ").trim());
	};
	let providers: readonly Provider[];
	try {
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		const runtime = await ModelRuntime.create({
			modelsPath,
			credentials: credentials as never,
			modelsStore: inMemoryModelsStore,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		providers = runtime.getProviders();
		const diagnostic = runtime.getError();
		if (diagnostic) report(diagnostic);
	} catch (error) {
		report(
			`models.json "${modelsPath}" could not be loaded (${
				error instanceof Error ? error.message : String(error)
			}); using the built-in providers only`,
		);
		return collection;
	}
	// Providers pi composed, including the untouched built-ins: a colliding id is
	// pi's composed answer rather than a second rule invented here.
	for (const provider of providers) collection.setProvider(provider);
	return collection;
}

/** The providers pi can authenticate with the given models collection, read
 * from the live global-pi credentials (`auth.json` plus the provider's
 * environment key, through `agent-host/credentials.ts`). Defaults to
 * {@link durableModels}, which is what every durable surface enumerates.
 *
 * This is per *provider*, never per model: the answer is one availability check
 * per provider (42 on a current install, plus the user's custom ones), and a
 * caller that then wants models asks only the configured providers for theirs.
 * Scanning the whole generated catalog to filter it instead costs a string and a
 * set membership per model — well over a thousand allocations to answer a
 * question about a few dozen providers.
 *
 * Availability uses pi-ai's `checkAuth`, the side-effect-free check, so reading
 * a picker never refreshes an OAuth token or performs other request-time work.
 * It is also what counts a `models.json` `apiKey` as configured: pi's composed
 * provider answers "configured" for a literal key and for an environment
 * template whose variables are set, and — deliberately — for a `!command` key
 * without running it (`composeApiKeyAuth`'s `check` returns before resolution),
 * so no picker executes a command in the user's `models.json`. A provider whose
 * check throws is left out rather than failing the whole list: a provider we
 * cannot authenticate is not one the user has configured. */
export async function configuredProviderIds(
	models?: Models,
): Promise<Set<string>> {
	const collection = models ?? (await durableModels());
	const resolved = await Promise.all(
		collection.getProviders().map(async (provider) => {
			try {
				return (await collection.checkAuth(provider.id))
					? provider.id
					: undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return new Set(resolved.filter((id): id is string => id !== undefined));
}

/** `provider/modelId` for every model of every configured provider.
 *
 * Walks only the configured providers, so the cost is proportional to the models
 * a user can actually run rather than to the size of the catalog. Model-level
 * `Provider.filterModels` narrowing is not applied: this answers "which
 * providers are configured", and every model such a provider declares is
 * offered. */
export async function configuredModels(models?: Models): Promise<string[]> {
	const collection = models ?? (await durableModels());
	const configured = await configuredProviderIds(collection);
	const ids: string[] = [];
	for (const provider of collection.getProviders()) {
		if (!configured.has(provider.id)) continue;
		for (const model of collection.getModels(provider.id))
			ids.push(`${model.provider}/${model.id}`);
	}
	return ids;
}

/** {@link configuredModels} sorted, for a select field's options. */
export async function configuredModelList(models?: Models): Promise<string[]> {
	return (await configuredModels(models)).sort();
}
