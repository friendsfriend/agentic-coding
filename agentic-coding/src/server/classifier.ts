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

/** Start the sidecar for an already-installed local model, or stop it when the
 * provider moves away from `laya-local`. A provider switch must not leave a
 * ~324 MB `laya-serve` process and its loopback listener behind. */
export function startSelectedLocalClassifier(provider: string): void {
	const classifier = layaLocalClassifier();
	if (provider !== LAYA_LOCAL_PROVIDER) {
		void classifier.stop().catch(() => {});
		return;
	}
	void classifier.ensureStarted().catch(() => {});
}

/** Release the managed sidecar on server shutdown. */
export async function stopLocalClassifier(): Promise<void> {
	await layaLocalClassifier()
		.stop()
		.catch(() => {});
}
