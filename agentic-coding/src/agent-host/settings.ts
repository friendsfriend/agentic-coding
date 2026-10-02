// The `agentHost` configuration section (durable-agent-configuration spec):
// run policy shared by every durable conversation, seeded once from the
// user's global pi settings and never overwritten afterwards. Pure logic
// only (no file I/O): callers pass in the already-read JSON values, so this
// module stays trivially testable and reusable from the config loader and
// from `src/agent-host/host.ts`.

export interface AgentHostSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	compaction?: {
		enabled?: boolean;
		reserveTokens?: number;
		keepRecentTokens?: number;
		backgroundTokens?: number;
	};
	retry?: { maxRetries?: number };
	/** `"all"` places every queued steer/follow-up at once instead of one per
	 * turn (pi-durable `Settings.steeringMode`/`followUpMode`). */
	steeringMode?: "one-at-a-time" | "all";
	followUpMode?: "one-at-a-time" | "all";
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
