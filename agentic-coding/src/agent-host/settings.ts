// The `agentHost` configuration section (durable-agent-configuration spec):
// run policy shared by every durable conversation, seeded once from the
// user's global pi settings and never overwritten afterwards. Pure logic
// only (no file I/O): callers pass in the already-read JSON values, so this
// module stays trivially testable and reusable from the config loader and
// from `src/agent-host/host.ts`.

import type { CompactionConfig } from "../workflow/compaction.ts";

export interface LocalPiToolsSettings {
	readonly enabled: boolean;
	readonly restrictedAllow: {
		readonly readOnly: readonly string[];
	};
	readonly replaySafe: readonly string[];
}

export interface AgentHostSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	/** The hand-written escape hatch of the compaction policy: present, it wins
	 * over `[agents.compaction]` (durable-agent-configuration: "Hand-written
	 * override wins"). Its shape and defaults live in
	 * `src/workflow/compaction.ts`. */
	compaction?: CompactionConfig;
	retry?: { maxRetries?: number };
	/** `"all"` places every queued steer/follow-up at once instead of one per
	 * turn (pi-durable `Settings.steeringMode`/`followUpMode`). */
	steeringMode?: "one-at-a-time" | "all";
	followUpMode?: "one-at-a-time" | "all";
	/** Opt-in adapter for the user's global Pi extensions and MCP tools.
	 * Normalized and fail-closed by the host; never inferred from project config. */
	localPiTools?: unknown;
}

/** The subset of the global pi `settings.json` shape this module reads. Pi's
 * settings file carries many more fields; only the ones `agentHost` mirrors
 * are declared here. */
export interface GlobalPiSettings {
	defaultProvider?: unknown;
	defaultModel?: unknown;
	defaultThinkingLevel?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Validate the machine-local bridge policy without retaining malformed values. */
export function normalizeLocalPiToolsSettings(value: unknown): {
	readonly settings?: LocalPiToolsSettings;
	readonly diagnostic?: string;
} {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { diagnostic: "local Pi tool bridge configuration is invalid" };
	const record = value as Record<string, unknown>;
	if (record.enabled !== undefined && typeof record.enabled !== "boolean")
		return { diagnostic: "local Pi tool bridge configuration is invalid" };
	const enabled = record.enabled === true;
	const allowRecord =
		record.restrictedAllow === undefined
			? {}
			: record.restrictedAllow &&
					typeof record.restrictedAllow === "object" &&
					!Array.isArray(record.restrictedAllow)
				? (record.restrictedAllow as Record<string, unknown>)
				: undefined;
	if (!allowRecord)
		return { diagnostic: "local Pi tool bridge configuration is invalid" };
	const readOnly = boundedNameList(allowRecord.readOnly);
	const replaySafe = boundedNameList(record.replaySafe);
	if (!readOnly || !replaySafe)
		return { diagnostic: "local Pi tool bridge configuration is invalid" };
	return {
		settings: {
			enabled,
			restrictedAllow: { readOnly },
			replaySafe,
		},
	};
}

function boundedNameList(value: unknown): readonly string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 256) return undefined;
	const names: string[] = [];
	for (const item of value) {
		if (
			typeof item !== "string" ||
			item.trim().length === 0 ||
			item.length > 128 ||
			/[\r\n\0]/.test(item)
		)
			return undefined;
		if (!names.includes(item)) names.push(item);
	}
	return names;
}

/** Seed `agentHost` once from the matching keys of the global pi settings
 * (durable-agent-configuration: "Durable agent settings section"). Returns
 * the existing section unchanged when it is already present — seeding never
 * overwrites an owned section, however the global default later changes. An
 * absent or unreadable global settings file seeds nothing: an optional
 * convenience must never fail a durable launch. */
export function seedAgentHostSettings(
	existing: AgentHostSettings | undefined,
	global: GlobalPiSettings | undefined,
): AgentHostSettings {
	if (existing) return existing;
	if (!global) return {};
	const seeded: AgentHostSettings = {};
	if (isNonEmptyString(global.defaultProvider))
		seeded.defaultProvider = global.defaultProvider;
	if (isNonEmptyString(global.defaultModel))
		seeded.defaultModel = global.defaultModel;
	if (isNonEmptyString(global.defaultThinkingLevel))
		seeded.defaultThinkingLevel = global.defaultThinkingLevel;
	return seeded;
}
