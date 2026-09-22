// Server-owned agent-configuration mutations (expose-unified-bun-backend,
// task 2.6). The model-config modal sends a data mutation; the server applies
// it with the same `saveAgentsSection` layering/conflict rules the in-process
// path used, so no view writes the configuration file itself.
//
// Stale-write detection (centralize-application-settings, task 2.3): a client
// may name the revision it read. The revision digests the effective `[agents]`
// section, so a change from another client is detected before the write instead
// of silently overwriting it; unrelated keys stay out of the digest, and the
// mutation itself still preserves every field it does not edit.
import { createHash } from "node:crypto";
import {
	conflictingAgentsFiles,
	loadConfigWithProvenance,
	saveAgentsSection,
} from "../workflow/effects.ts";
import {
	type AgentsConfig,
	type PresetConfig,
	type ProfileConfig,
	parseAgentsConfig,
} from "../workflow/profiles.ts";

export type AgentsMutation =
	| {
			readonly kind: "set-profile";
			readonly name: string;
			/** Existing key to remove when it differs from `name` (a rename). */
			readonly renameFrom?: string;
			readonly profile: ProfileConfig;
	  }
	| {
			readonly kind: "set-preset";
			readonly name: string;
			/** Existing key to remove when it differs from `name` (a rename). */
			readonly renameFrom?: string;
			readonly preset: PresetConfig;
	  }
	| { readonly kind: "delete-profile"; readonly name: string }
	| { readonly kind: "delete-preset"; readonly name: string };

/** Stable JSON of the effective agents section: object keys are ordered so the
 * digest depends on the values, not on key insertion order. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		return `{${entries
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Revision of the effective `[agents]` section. Two reads that resolve to the
 * same agents configuration produce the same revision, and a write from any
 * other client changes it.
 */
export function agentConfigRevision(repository?: string): string {
	const resolved = loadConfigWithProvenance({ repository });
	return createHash("sha256")
		.update(stableJson(resolved.config.agents ?? {}))
		.digest("hex");
}

/** Apply a single profile/preset mutation through the canonical layering rules.
 * When `expectedRevision` is supplied, a configuration that changed since that
 * revision was read is refused before any write. */
export function applyAgentsMutation(
	mutation: AgentsMutation,
	repository?: string,
	expectedRevision?: string,
): void {
	if (expectedRevision !== undefined) {
		const current = agentConfigRevision(repository);
		if (current !== expectedRevision)
			throw new Error(
				"Agents configuration changed since it was loaded; reload before saving so the other change is not overwritten",
			);
	}
	saveAgentsSection((section) => {
		switch (mutation.kind) {
			case "set-profile": {
				if (section.profiles === undefined || section.profiles === null)
					section.profiles = {};
				else if (
					typeof section.profiles !== "object" ||
					Array.isArray(section.profiles)
				)
					throw new Error("agents.profiles must be a table of profiles");
				if (mutation.renameFrom && mutation.renameFrom !== mutation.name)
					delete (section.profiles as Record<string, unknown>)[
						mutation.renameFrom
					];
				(section.profiles as Record<string, unknown>)[mutation.name] =
					mutation.profile;
				return;
			}
			case "set-preset": {
				if (section.presets === undefined || section.presets === null)
					section.presets = {};
				else if (
					typeof section.presets !== "object" ||
					Array.isArray(section.presets)
				)
					throw new Error("agents.presets must be a table of presets");
				if (mutation.renameFrom && mutation.renameFrom !== mutation.name)
					delete (section.presets as Record<string, unknown>)[
						mutation.renameFrom
					];
				(section.presets as Record<string, unknown>)[mutation.name] =
					mutation.preset;
				return;
			}
			case "delete-profile": {
				if (section.profiles && typeof section.profiles === "object")
					delete (section.profiles as Record<string, unknown>)[mutation.name];
				return;
			}
			case "delete-preset": {
				if (section.presets && typeof section.presets === "object")
					delete (section.presets as Record<string, unknown>)[mutation.name];
				return;
			}
		}
	}, repository);
}

/** The effective parsed agents config, provenance, the conflicting `[agents]`
 * definitions the writer must refuse over, and the revision of the effective
 * agents section. */
export function loadAgentConfig(repository?: string): {
	agents: AgentsConfig;
	provenance: ReturnType<typeof loadConfigWithProvenance>["provenance"];
	conflicts: string[];
	revision: string;
} {
	const resolved = loadConfigWithProvenance({ repository });
	return {
		agents: parseAgentsConfig(resolved.config.agents, resolved.config),
		provenance: resolved.provenance,
		conflicts: conflictingAgentsFiles(undefined, repository ?? process.cwd()),
		revision: agentConfigRevision(repository),
	};
}
