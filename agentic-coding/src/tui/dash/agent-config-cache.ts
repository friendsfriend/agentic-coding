// Client-side cache for the model-config view. Reads the effective agents
// config through the typed backend client when a transport is configured and
// falls back to the in-process reader only for a transport-less run
// (demo/tests), so the view component performs no config-file I/O.
import { backendClient } from "../../server/client.ts";
import { loadAgentConfig } from "../../server/config.ts";
import type { AgentsConfig } from "../../workflow/profiles.ts";

export interface AgentConfigEntry {
	agents?: AgentsConfig;
	provenance?: ReturnType<typeof loadAgentConfig>["provenance"];
	conflicts?: string[];
	/** Revision of the effective agents section this entry was read from; the
	 * editor sends it back so a write from another client is detected. */
	revision?: string;
	error?: string;
}

const cache = new Map<string, AgentConfigEntry>();
const key = (repository?: string) => repository ?? "";

function readLocal(repository?: string): AgentConfigEntry {
	try {
		return loadAgentConfig(repository);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Synchronous read of the cached entry. A server-backed cache starts empty and
 * is filled by {@link refreshAgentConfig}; a transport-less run reads locally. */
export function agentConfigEntry(repository?: string): AgentConfigEntry {
	const existing = cache.get(key(repository));
	if (existing) return existing;
	if (backendClient()) {
		const entry: AgentConfigEntry = {};
		cache.set(key(repository), entry);
		return entry;
	}
	const entry = readLocal(repository);
	cache.set(key(repository), entry);
	return entry;
}

/** Re-read the transport-less config into the cache (used after an in-process
 * mutation so the view's synchronous read reflects the write). */
export function reloadAgentConfigLocal(repository?: string): void {
	cache.set(key(repository), readLocal(repository));
}

/** Refresh from the typed client (or in-process when no transport is set). */
export async function refreshAgentConfig(
	repository?: string,
): Promise<AgentConfigEntry> {
	const client = backendClient();
	if (!client) {
		const entry = readLocal(repository);
		cache.set(key(repository), entry);
		return entry;
	}
	try {
		const value = await client.loadAgents(repository);
		const entry: AgentConfigEntry = {
			agents: value.agents as AgentsConfig,
			provenance: value.provenance as AgentConfigEntry["provenance"],
			conflicts: value.conflicts,
			...(value.revision ? { revision: value.revision } : {}),
		};
		cache.set(key(repository), entry);
		return entry;
	} catch (error) {
		const entry: AgentConfigEntry = {
			error: error instanceof Error ? error.message : String(error),
		};
		cache.set(key(repository), entry);
		return entry;
	}
}
