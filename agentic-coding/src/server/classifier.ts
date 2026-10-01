// Server-owned classifier provider + local-model operations
// (introduce-local-model-support-for-classification). The Settings view never
// downloads or starts anything: it reads status and asks the server to install,
// cancel, or select. Persisting the provider stays on the agents-mutation path;
// this module only reads state and drives the managed sidecar.
import type { ClassifierStatusResponse } from "../contracts/gateway.ts";
import {
	CLASSIFIER_PROVIDER_SPECS,
	DEFAULT_CLASSIFIER_PROVIDER,
	LAYA_LOCAL_PROVIDER,
} from "../workflow/classifier-providers.ts";
import { loadConfigWithProvenance } from "../workflow/effects.ts";
import { layaLocalClassifier } from "../workflow/laya-local.ts";
import {
	parseAgentsConfig,
	resolveClassifierProvider,
} from "../workflow/profiles.ts";

/** The effective selected provider. An unreadable or absent configuration
 * falls back to the default hosted provider, exactly like the classifier
 * effect handler does, so the picker never shows a value the engine would not
 * use. */
export function selectedClassifierProvider(repository?: string): string {
	try {
		const loaded = loadConfigWithProvenance({ repository });
		const agents = parseAgentsConfig(
			loaded.config.agents,
			loaded.config,
			loaded.provenance.files.join(", ") || undefined,
		);
		return resolveClassifierProvider(agents);
	} catch {
		return DEFAULT_CLASSIFIER_PROVIDER;
	}
}

/** Current classifier selection plus local-model status. The liveness probe is
 * awaited so a killed `laya-serve` is reported as `running: false` (with the
 * failure as `error`) rather than as a healthy handle nobody answers. */
export async function classifierStatus(
	repository?: string,
): Promise<ClassifierStatusResponse> {
	const classifier = layaLocalClassifier();
	const status = classifier.status();
	const health = await classifier.health();
	return {
		provider: selectedClassifierProvider(repository),
		providers: CLASSIFIER_PROVIDER_SPECS.filter((spec) => spec.selectable).map(
			(spec) => ({ id: spec.id, label: spec.label }),
		),
		local: {
			...status,
			running: health.state === "ready",
			...(health.detail && !status.error ? { error: health.detail } : {}),
		},
	};
}

/** Start (or resume) the local acquisition. Idempotent and non-blocking: the
 * returned status carries the job the view polls. */
export async function installLocalClassifier(
	repository?: string,
): Promise<ClassifierStatusResponse> {
	void layaLocalClassifier()
		.install()
		.catch(() => {});
	return await classifierStatus(repository);
}

/** Cancel an in-flight acquisition and clean its temp files. */
export async function cancelLocalClassifierInstall(
	repository?: string,
): Promise<ClassifierStatusResponse> {
	await layaLocalClassifier().cancel();
	return await classifierStatus(repository);
}

/** Start the standalone sidecar for an already-installed local model. Called
 * when the local provider is selected and when a server starts with it already
 * selected: the UI spawns the sidecar at startup and it then *keeps running*,
 * so a pane whose engine exited still reaches it and a later engine adopts the
 * same process instead of loading the model again. Nothing here stops it — a
 * switch away from `laya-local` leaves the service warm for the panes that
 * already hold its endpoint. Never blocks the caller and never acquires: only
 * an explicit install downloads the model. */
export async function startSelectedLocalClassifier(
	provider: string,
): Promise<void> {
	if (provider !== LAYA_LOCAL_PROVIDER) return;
	// Never rejects: a missing model or a dead binary is reported by
	// `classifierStatus`/Settings, it must not fail a caller whose only job was
	// to warm the classifier. Awaitable so a caller that *shows* the start (the
	// shell's splash) can hold its step until the model is actually serving.
	await layaLocalClassifier()
		.ensureStarted()
		.catch(() => {});
}
