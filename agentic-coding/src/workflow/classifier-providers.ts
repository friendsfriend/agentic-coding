// Pluggable classifier providers (introduce-local-model-support-for-
// classification). Pure catalog: which provider ids exist, how Settings names
// them, and the transport contract each one fulfils. Everything that performs
// I/O lives in the runtime half — `classifier-runner.ts` builds the live
// providers and `laya-local.ts` owns the managed sidecar — so the agents-config
// validation can import this module without reaching the network, the
// filesystem, or a spawned process.
//
// Adding a provider is one entry here plus one live provider in the runner: the
// effect handler reads the pinned id, never a provider table of its own.

/** What one `model.classify` request needs to reach a provider: the endpoint,
 * the request headers (credentials included), and the model id to ask for. */
export interface ClassifierTarget {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly model: string;
}

/** Non-secret provider health. A local sidecar reports `starting` while it
 * spins up and `unavailable` when its model or binary is missing. */
export interface ClassifierProviderHealth {
	readonly state: "ready" | "starting" | "unavailable";
	readonly detail?: string;
}

/** A selectable classifier transport. `start`/`stop`/`health` are optional
 * because a hosted provider has no local lifecycle. */
export interface ClassifierProvider {
	/** Stable id; also the value persisted in `[agents.classifier]`. */
	readonly id: string;
	/** Human label for Settings. */
	readonly label: string;
	resolve(input: { model: string }): ClassifierTarget;
	start?(): Promise<void>;
	stop?(): Promise<void>;
	health?(): Promise<ClassifierProviderHealth>;
}

/** Catalog entry: identity plus the Settings copy. Kept separate from the live
 * provider so the pure layer holds no secret and no transport. */
export interface ClassifierProviderSpec {
	readonly id: string;
	readonly label: string;
	/** One-line description shown next to the option in Settings. */
	readonly description: string;
	/** False for a provider that must never be offered in Settings. */
	readonly selectable: boolean;
}

/** The hosted, usage-based plan that serves the Jev models. `opencode-go` is a
 * different subscription that does not carry Jev and must never appear here. */
export const OPENCODE_ZEN_PROVIDER = "opencode-zen";
/** The local, offline provider backed by the managed `laya-serve` sidecar. */
export const LAYA_LOCAL_PROVIDER = "laya-local";
/** A configuration that says nothing keeps today's endpoint. */
export const DEFAULT_CLASSIFIER_PROVIDER = OPENCODE_ZEN_PROVIDER;

/** The hosted System One endpoint. Unchanged when `opencode-zen` is selected. */
export const ROUTING_ENDPOINT = "https://opencode.ai/zen/v1/systemone";

/** The model id the managed local server is asked for. The local server ignores
 * unknown models, so this is a local id, never the hosted `opencode/…` one. */
export const LAYA_LOCAL_MODEL = "laya-system-one";

/** Every registered provider, in Settings order. */
export const CLASSIFIER_PROVIDER_SPECS: readonly ClassifierProviderSpec[] =
	Object.freeze([
		{
			id: OPENCODE_ZEN_PROVIDER,
			label: "Hosted (usage-based)",
			description: "Requires OPENCODE_API_KEY",
			selectable: true,
		},
		{
			id: LAYA_LOCAL_PROVIDER,
			label: "Offline, on this machine",
			description: "Runs a local classifier model; no API key, no network",
			selectable: true,
		},
	]);

/** Every provider id Settings may offer, in declaration order. */
export function classifierProviderIds(): string[] {
	return CLASSIFIER_PROVIDER_SPECS.filter((spec) => spec.selectable).map(
		(spec) => spec.id,
	);
}

/** The catalog entry of an id, or undefined for an unknown one. */
export function classifierProviderSpec(
	id: string,
): ClassifierProviderSpec | undefined {
	return CLASSIFIER_PROVIDER_SPECS.find((spec) => spec.id === id);
}

/** True when an id names a registered, selectable provider. Guarded so an
 * inherited prototype name (`constructor`, `toString`) can never validate. */
export function isClassifierProviderId(value: unknown): value is string {
	return typeof value === "string" && classifierProviderIds().includes(value);
}
