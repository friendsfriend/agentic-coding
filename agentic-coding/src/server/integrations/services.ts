// Composition for the Bun-served integration families: the provider store, the
// Git capability and the app lookup the routes resolve an ident through
// (`port-git-providers-and-ai-to-bun`, tasks 2.1-2.5).
//
// Credentials are resolved here, on the Bun side, so a Git operation never
// carries a token across the private adapter boundary.
import path from "node:path";
import type { App } from "../environment/config.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import { GitRepository } from "./git-repository.ts";
import {
	PROVIDER_TYPE_GITHUB,
	PROVIDER_TYPE_GITLAB,
	ProviderStore,
} from "./provider-store.ts";
import type { IntegrationServices } from "./routes.ts";

export interface IntegrationServicesOptions {
	readonly manager: EnvironmentManager;
	readonly configDir: string;
	readonly fetch?: typeof fetch;
	readonly logger?: (message: string) => void;
}

/**
 * Build the integration services over the Bun-owned environment authority.
 *
 * Credential routing matches the Go `multiAuthProvider`: an app that names a
 * provider wins, otherwise the first provider whose type matches the host is
 * used, so GitHub and GitLab credentials never leak into each other.
 */
export function createIntegrationServices(
	options: IntegrationServicesOptions,
): IntegrationServices {
	const providers = new ProviderStore(
		path.join(options.configDir, "providers"),
		path.join(options.configDir, ".env"),
	);
	try {
		providers.load();
	} catch (error) {
		options.logger?.(
			`[WARN] providers: initial load failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const git = new GitRepository({
		auth: (repositoryUrl) =>
			credentialsFor(providers, options.manager, repositoryUrl),
		logger: options.logger,
	});
	return {
		providers,
		git,
		apps: {
			getAppByIdent: (ident) => options.manager.getAppByIdent(ident),
			getApps: () => options.manager.getApps(),
			updateAppActiveWorktree: (ident, branch) =>
				options.manager.updateAppActiveWorktree(ident, branch),
			loadConfig: () => options.manager.loadConfig(),
		},
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	};
}

/** Per-URL credential resolution; an unknown URL resolves to no credentials. */
export function credentialsFor(
	providers: ProviderStore,
	manager: Pick<EnvironmentManager, "getApps">,
	repositoryUrl: string,
): { username: string; token: string } {
	for (const app of manager.getApps() as App[]) {
		if (app.repositoryPath !== repositoryUrl) continue;
		if (!app.provider) continue;
		return providers.credentialsFor(app.provider);
	}
	for (const provider of providers.list()) {
		if (provider.username === "" || provider.token === "") continue;
		const isGitHub = repositoryUrl.includes("github.com");
		if (provider.type === PROVIDER_TYPE_GITHUB && isGitHub)
			return { username: provider.username, token: provider.token };
		if (provider.type === PROVIDER_TYPE_GITLAB && !isGitHub)
			return { username: provider.username, token: provider.token };
	}
	return { username: "", token: "" };
}
