// The models the durable (`pi-durable`) runtime can actually run.
//
// Both pi-durable model surfaces — the dashboard `/model` picker
// (`agent-host/host.ts`'s `catalog`) and the Settings agent-profile model select
// (`tui/settings/agentPresets.ts`) — offer exactly this set: the models of the
// providers the user has configured. Listing pi-ai's whole generated catalog
// instead offered models no credential covers.
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
// the whole provider catalog into an unrelated process.

import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PiAuthCredentialStore } from "./credentials.ts";

/** The providers pi-ai can authenticate with the given models collection, read
 * from the live global-pi credentials (`auth.json` plus the provider's
 * environment key, through `agent-host/credentials.ts`). Defaults to the
 * built-in provider catalog, which is what a client outside the durable host
 * has.
 *
 * This is per *provider*, never per model: the answer is one availability check
 * per provider (42 on a current install), and a caller that then wants models
 * asks only the configured providers for theirs. Scanning the whole generated
 * catalog to filter it instead costs a string and a set membership per model —
 * well over a thousand allocations to answer a question about a few dozen
 * providers.
 *
 * Availability uses pi-ai's `checkAuth`, the side-effect-free check, so reading
 * a picker never refreshes an OAuth token or performs other request-time work.
 * The checks run concurrently, and a provider whose check throws is left out
 * rather than failing the whole list: a provider we cannot authenticate is not
 * one the user has configured. */
export async function configuredProviderIds(
	models?: Models,
): Promise<Set<string>> {
	const collection =
		models ??
		builtinModels({
			credentials: new PiAuthCredentialStore() as never,
		});
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
	const collection =
		models ??
		builtinModels({
			credentials: new PiAuthCredentialStore() as never,
		});
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
