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
import { isClassifierProviderId } from "../workflow/classifier-providers.ts";
import {
	COMPACTION_DEFAULTS,
	type CompactionConfig,
	type CompactionField,
	type CompactionFieldError,
	type CompactionPolicy,
	type CompactionSource,
	compactionConfigIsEmpty,
	resolveCompactionPolicy,
	resolveCompactionSection,
	validateCompactionConfig,
	validateCompactionField,
} from "../workflow/compaction.ts";
import {
	conflictingAgentsFiles,
	loadConfigWithProvenance,
	saveAgentsSection,
} from "../workflow/effects.ts";
import {
	type AgentsConfig,
	isOrchestratorMonitorMode,
	ORCHESTRATOR_MONITOR_MODES,
	type OrchestratorLimits,
	orchestratorLaunchLimits,
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
	| { readonly kind: "delete-preset"; readonly name: string }
	| {
			readonly kind: "set-classifier";
			readonly classifier: {
				readonly provider: string;
				readonly options?: Record<string, unknown>;
			};
	  }
	| {
			readonly kind: "set-orchestrator";
			/** Absent fields are removed: the durable host default applies, and an
			 * absent `monitor` means the default `wake` mode. */
			readonly orchestrator: {
				readonly model?: string;
				readonly thinking?: string;
				readonly monitor?: string;
			};
	  }
	| {
			readonly kind: "set-compaction";
			/** One edited field of the compaction policy: the numeric editor (and
			 * the on/off row) edits one value at a time, so a rejected value can name
			 * exactly what to fix without losing the other values. */
			readonly field: CompactionField;
			readonly value: boolean | number | string;
	  };

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
 * revision was read is refused before any write. A compaction edit is written
 * user-scoped, so a project overlay can neither capture nor shadow it. */
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
	saveAgentsSection(
		(section) => {
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
				case "set-classifier": {
					if (!isClassifierProviderId(mutation.classifier.provider))
						throw new Error(
							`unknown classifier provider: ${mutation.classifier.provider}`,
						);
					const options = mutation.classifier.options;
					if (
						options !== undefined &&
						(!options || typeof options !== "object" || Array.isArray(options))
					)
						// Refused before `saveAgentsSection` runs: one malformed write would
						// otherwise make the whole `[agents]` section permanently unloadable.
						throw new Error("agents.classifier.options must be a table");
					// Merge instead of replace: a provider switch must not silently drop a
					// hand-tuned `options` table (or any unknown key) from the layered
					// config, exactly as every other agents mutation preserves its siblings.
					const existing =
						section.classifier &&
						typeof section.classifier === "object" &&
						!Array.isArray(section.classifier)
							? (section.classifier as Record<string, unknown>)
							: {};
					section.classifier = {
						...existing,
						provider: mutation.classifier.provider,
						...(mutation.classifier.options !== undefined
							? { options: mutation.classifier.options }
							: {}),
					};
					return;
				}
				case "set-orchestrator": {
					// The file-only bounds (`limits`, `stall_minutes`,
					// `reconcile_seconds`, `event_burst_limit`,
					// `event_burst_window_seconds`) have no editor here, so a session edit
					// preserves whatever the developer wrote instead of dropping it with
					// the rest of the table.
					const existing = section.orchestrator;
					const next: Record<string, unknown> = {};
					if (
						existing &&
						typeof existing === "object" &&
						!Array.isArray(existing)
					)
						for (const key of [
							"limits",
							"stall_minutes",
							"reconcile_seconds",
							"event_burst_limit",
							"event_burst_window_seconds",
						] as const)
							if (Object.hasOwn(existing, key))
								next[key] = (existing as Record<string, unknown>)[key];
					for (const key of ["model", "thinking"] as const) {
						const value = mutation.orchestrator[key];
						if (value === undefined || value === "") continue;
						if (typeof value !== "string" || !value.trim())
							throw new Error(`agents.orchestrator.${key} must be a string`);
						next[key] = value.trim();
					}
					const monitor = mutation.orchestrator.monitor;
					if (monitor !== undefined && monitor !== "") {
						if (!isOrchestratorMonitorMode(monitor))
							throw new Error(
								`agents.orchestrator.monitor must be one of ${ORCHESTRATOR_MONITOR_MODES.join(", ")}`,
							);
						next.monitor = monitor;
					}
					if (Object.keys(next).length) section.orchestrator = next;
					else delete section.orchestrator;
					return;
				}
				case "set-compaction": {
					// Validated with the pure rules the host resolves with, so a value
					// the editor accepts is exactly a value durable runs can use. Every
					// other key of the section (and of `[agents]`) is preserved.
					const problem =
						mutation.field === "enabled"
							? typeof mutation.value === "boolean"
								? undefined
								: "enabled must be true or false"
							: validateCompactionField(mutation.field, mutation.value);
					if (problem) throw new Error(problem);
					const current =
						section.compaction &&
						typeof section.compaction === "object" &&
						!Array.isArray(section.compaction)
							? (section.compaction as Record<string, unknown>)
							: {};
					section.compaction = {
						...current,
						[mutation.field]: mutation.value,
					};
					return;
				}
			}
		},
		repository,
		mutation.kind === "set-compaction" ? { userScope: true } : {},
	);
}

/**
 * The effective compaction settings for the Settings section and the durable
 * host. Read user-scope (`repositoryIndependent`): a project overlay's
 * `[agents]` section can neither change how a workflow's own runs compact nor
 * capture an edit, so the section and the host read the same document. A
 * present, non-empty `agentHost.compaction` is the hand-written override and
 * wins (durable-agent-configuration: "Hand-written override wins").
 *
 * `effective` is resolved with no reference window, which is the documented
 * behavior of a percentage when no run's model window is known: it falls back
 * to the field's absolute default. The host resolves the same section against
 * the smallest window its tracked runs use; the section names that rule rather
 * than inventing a window this process cannot see.
 */
export function loadCompactionSettings(): CompactionSettingsRead {
	const resolved = loadConfigWithProvenance({
		repositoryIndependent: true,
	});
	const config = resolved.config as unknown as Record<string, unknown>;
	const agents = config.agents;
	const agentsCompaction =
		agents && typeof agents === "object" && !Array.isArray(agents)
			? (agents as Record<string, unknown>).compaction
			: undefined;
	const agentHost = config.agentHost;
	const agentHostCompaction =
		agentHost && typeof agentHost === "object" && !Array.isArray(agentHost)
			? (agentHost as Record<string, unknown>).compaction
			: undefined;
	const { config: effectiveSection, source } = resolveCompactionSection(
		agentsCompaction,
		agentHostCompaction,
	);
	return {
		configured: effectiveSection,
		configuredIsDefault: compactionConfigIsEmpty(effectiveSection),
		effective: resolveCompactionPolicy(effectiveSection),
		source,
		validation: validateCompactionConfig(agentsCompaction ?? {}),
		defaults: COMPACTION_DEFAULTS,
	};
}

/** What Settings renders and the write path validates against. `configured` is
 * the section as written (the `agentHost` override included, which is what the
 * host actually uses), and `effective` is that section resolved with no
 * reference window. */
export interface CompactionSettingsRead {
	readonly configured: CompactionConfig;
	/** True when nothing is configured anywhere and the defaults apply. */
	readonly configuredIsDefault: boolean;
	readonly effective: CompactionPolicy;
	readonly source: CompactionSource;
	/** Per-field errors of the written `[agents.compaction]` section, if any. */
	readonly validation: CompactionFieldError[];
	readonly defaults: CompactionPolicy;
}

/** The effective parsed agents config, provenance, the conflicting `[agents]`
 * definitions the writer must refuse over, and the revision of the effective
 * agents section. `repositoryIndependent` skips the project overlay entirely, so
 * a caller can read the user-level table that no repository can loosen. */
/** The server-enforced orchestrator launch ceiling, resolved from the
 * user-level configuration with no project overlay, and whether the developer
 * actually set a bound. One resolver for the guard and for the Settings read, so
 * the displayed value is the enforced one. */
export function orchestratorLaunchCeiling(): {
	limits: OrchestratorLimits;
	configured: boolean;
} {
	const agents = loadAgentConfig(undefined, {
		repositoryIndependent: true,
	}).agents;
	const raw = agents.orchestrator?.limits;
	return {
		limits: orchestratorLaunchLimits(agents),
		configured:
			raw?.max_active !== undefined || raw?.max_starts_per_day !== undefined,
	};
}

export function loadAgentConfig(
	repository?: string,
	options: { repositoryIndependent?: boolean } = {},
): {
	agents: AgentsConfig;
	provenance: ReturnType<typeof loadConfigWithProvenance>["provenance"];
	conflicts: string[];
	revision: string;
} {
	const resolved = loadConfigWithProvenance({
		repository,
		...(options.repositoryIndependent ? { repositoryIndependent: true } : {}),
	});
	return {
		agents: parseAgentsConfig(
			resolved.config.agents,
			resolved.provenance.files.join(", ") || undefined,
		),
		provenance: resolved.provenance,
		conflicts: options.repositoryIndependent
			? []
			: conflictingAgentsFiles(undefined, repository ?? process.cwd()),
		revision: options.repositoryIndependent
			? ""
			: agentConfigRevision(repository),
	};
}
