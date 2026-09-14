// Server-owned agent-configuration mutations (expose-unified-bun-backend,
// task 2.6). The model-config modal sends a data mutation; the server applies
// it with the same `saveAgentsSection` layering/conflict rules the in-process
// path used, so no view writes the configuration file itself.
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
			readonly profile: ProfileConfig;
	  }
	| {
			readonly kind: "set-preset";
			readonly name: string;
			readonly preset: PresetConfig;
	  }
	| { readonly kind: "delete-profile"; readonly name: string }
	| { readonly kind: "delete-preset"; readonly name: string };

/** Apply a single profile/preset mutation through the canonical layering rules. */
export function applyAgentsMutation(
	mutation: AgentsMutation,
	repository?: string,
): void {
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

/** The effective parsed agents config, provenance and the conflicting
 * `[agents]` definitions the writer must refuse over. */
export function loadAgentConfig(repository?: string): {
	agents: AgentsConfig;
	provenance: ReturnType<typeof loadConfigWithProvenance>["provenance"];
	conflicts: string[];
} {
	const resolved = loadConfigWithProvenance({ repository });
	return {
		agents: parseAgentsConfig(resolved.config.agents, resolved.config),
		provenance: resolved.provenance,
		conflicts: conflictingAgentsFiles(undefined, repository ?? process.cwd()),
	};
}
