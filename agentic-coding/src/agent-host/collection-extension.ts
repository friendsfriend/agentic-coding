import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { boundGitLabProjects } from "./collection-policy.ts";
import { discoverLocalGitLabProjects } from "./digest-repositories.ts";
import type { DurableRunContext, RunContextLookup } from "./tools.ts";
export async function collectionRepositories(run: DurableRunContext) {
	if (run.toolPolicy !== "collection")
		throw new Error("Collection profile required.");
	const hosts: unknown = JSON.parse(run.env.HERDR_DIGEST_GITLAB_HOSTS ?? "[]");
	if (
		!Array.isArray(hosts) ||
		hosts.some((host: unknown) => typeof host !== "string")
	)
		throw new Error("Invalid pinned GitLab hosts.");
	const roots: unknown = JSON.parse(
		run.env.HERDR_DIGEST_REPOSITORY_ROOTS ?? JSON.stringify([run.cwd]),
	);
	if (
		!Array.isArray(roots) ||
		roots.some((root: unknown) => typeof root !== "string")
	)
		throw new Error("Invalid pinned repository roots.");
	const result = await discoverLocalGitLabProjects({ roots, hosts });
	const toolHost = run.env.HERDR_DIGEST_GITLAB_TOOL_HOST;
	return {
		...result,
		queryableProjects: boundGitLabProjects(result.projects, toolHost),
		toolHost: toolHost || null,
		diagnostics: [
			...result.diagnostics,
			...(!toolHost ? ["gitlab-tool-host-binding-unconfigured"] : []),
		],
	};
}
export function collectionExtension(lookup: RunContextLookup) {
	return defineExtension({
		name: "agentic.collection",
		tools: [
			defineTool({
				name: "digest_repositories",
				description:
					"Read-only bounded discovery of actual local GitLab remotes under this collection session's pinned repository/workspace root. Returns deduplicated host/project identities, diagnostics and truncation. No arbitrary path arguments, network fetch, checkout, shell, credentials, or guessed repositories. Empty configured host coverage is explicitly incomplete.",
				replay: "safe",
				parameters: Type.Object({}),
				async execute(_args, api) {
					const run = lookup(api.conversationId);
					if (run?.toolPolicy !== "collection")
						return {
							output: [
								{ type: "text" as const, text: "Collection session required." },
							],
							isError: true,
						};
					const result = await collectionRepositories(run);
					return {
						output: [
							{
								type: "text" as const,
								text: JSON.stringify({
									...result,
									root: run.cwd,
									configuredHosts: JSON.parse(
										run.env.HERDR_DIGEST_GITLAB_HOSTS ?? "[]",
									),
									coverage:
										"Only pinned workspace roots are scanned. GitLab calls are limited to queryableProjects on the explicitly pinned configured integration host; absent host binding fails closed. Inaccessible roots and unsupported host bindings are not empty results.",
								}),
							},
						],
					};
				},
			}),
		],
	});
}
