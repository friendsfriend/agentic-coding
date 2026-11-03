import {
	type DurableSessionRecord,
	readDurableSessionRegistry,
	requireDurableSession,
	updateDurableSessionRegistry,
} from "../pi-durable-registry.ts";
import {
	type DigestCollectionSettings,
	digestSettingsRevision,
	validateDigestSettings,
} from "../scheduling/digest-settings.ts";

export { digestSettingsRevision };
export function digestSessionSettings(
	record: DurableSessionRecord,
): DigestCollectionSettings {
	return {
		gitlabHosts: record.gitlabHosts ?? [],
		...(record.gitlabToolHost ? { gitlabToolHost: record.gitlabToolHost } : {}),
		repositoryRoots: record.repositoryRoots ?? [record.cwd],
		productionSources: record.productionSources ?? [],
	};
}
export function previewDigestSessionUpdate(
	runtimeDir: string,
	id: string,
	owner: string,
	settings: unknown,
) {
	const registry = readDurableSessionRegistry(runtimeDir);
	if (!registry) throw new Error("Durable session registry unavailable.");
	const record = requireDurableSession(registry, id, owner);
	if (record.toolPolicy !== "collection" || !record.binding)
		throw new Error("Exact bound collection session required.");
	return {
		sessionId: id,
		expectedRevision: digestSettingsRevision(record),
		binding: record.binding,
		prior: digestSessionSettings(record),
		settings: validateDigestSettings(settings),
	};
}
export function digestSettingsEnvironment(
	record: DurableSessionRecord,
): Record<string, string> {
	return {
		HERDR_DIGEST_GITLAB_HOSTS: JSON.stringify(record.gitlabHosts ?? []),
		HERDR_DIGEST_GITLAB_TOOL_HOST: record.gitlabToolHost ?? "",
		HERDR_DIGEST_REPOSITORY_ROOTS: JSON.stringify(
			record.repositoryRoots ?? [record.cwd],
		),
		HERDR_DIGEST_PRODUCTION_SOURCES: JSON.stringify(
			record.productionSources ?? [],
		),
	};
}
/** Called only inside the native host's idle, serialized admission boundary. */
export function applyDigestSessionUpdate(
	runtimeDir: string,
	id: string,
	owner: string,
	expectedRevision: string,
	settings: unknown,
): DurableSessionRecord {
	const validated = validateDigestSettings(settings);
	return updateDurableSessionRegistry(runtimeDir, (registry) => {
		if (!registry) throw new Error("Durable session registry unavailable.");
		const record = requireDurableSession(registry, id, owner);
		if (
			record.toolPolicy !== "collection" ||
			!record.binding ||
			digestSettingsRevision(record) !== expectedRevision
		)
			throw new Error(
				"Collection target is stale, unbound or changed; preview again.",
			);
		const updated = {
			...record,
			...validated,
			gitlabToolHost: validated.gitlabToolHost,
			collectionRevision: (record.collectionRevision ?? 0) + 1,
		};
		return {
			registry: {
				...registry,
				sessions: registry.sessions.map((session) =>
					session.id === id ? updated : session,
				),
			},
			result: updated,
		};
	});
}
