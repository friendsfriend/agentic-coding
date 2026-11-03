import { createHash } from "node:crypto";
import { posix } from "node:path";
export type DigestLogProvider = "azure-monitor" | "new-relic";
export function digestSettingsRevision(record: unknown): string {
	return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
export function digestEnvironmentRevision(
	env: Readonly<Record<string, string>>,
): string {
	return digestSettingsRevision([
		env.HERDR_DIGEST_GITLAB_HOSTS,
		env.HERDR_DIGEST_GITLAB_TOOL_HOST,
		env.HERDR_DIGEST_REPOSITORY_ROOTS,
		env.HERDR_DIGEST_PRODUCTION_SOURCES,
	]);
}
export interface DigestProductionSource {
	readonly provider: DigestLogProvider;
	readonly environment: "production";
	readonly environmentField:
		| "environment"
		| "deployment.environment"
		| "deployment.environment.name";
	readonly environmentValue: string;
	readonly services: readonly string[];
	/** Trusted operator's configuration/evidence reference, never provider text. */
	readonly provenance: string;
}
export interface DigestCollectionSettings {
	readonly gitlabHosts: readonly string[];
	readonly gitlabToolHost?: string;
	readonly repositoryRoots: readonly string[];
	readonly productionSources: readonly DigestProductionSource[];
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid digest settings object.");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error(
			"Unknown digest setting; credentials and arbitrary queries are not settings.",
		);
}
function literal(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@ -]{0,199}$/.test(value) ||
		/token|password|credential|secret|bearer/i.test(value)
	)
		throw new Error("Invalid nonsecret digest selector/reference.");
	return value;
}
export function validateProductionSources(
	input: unknown,
): readonly DigestProductionSource[] {
	if (!Array.isArray(input) || input.length > 2)
		throw new Error("Invalid production source settings.");
	const providers = new Set<string>();
	return input.map((raw) => {
		const entry = object(raw);
		keys(entry, [
			"provider",
			"environment",
			"environmentField",
			"environmentValue",
			"services",
			"provenance",
		]);
		if (
			(entry.provider !== "azure-monitor" && entry.provider !== "new-relic") ||
			providers.has(entry.provider) ||
			entry.environment !== "production" ||
			(entry.environmentField !== "environment" &&
				entry.environmentField !== "deployment.environment" &&
				entry.environmentField !== "deployment.environment.name") ||
			(typeof entry.environmentValue === "string" &&
				/^(?:qa|test|testing|dev|development|stage|staging)(?:$|[-_ /])/i.test(
					entry.environmentValue,
				))
		)
			throw new Error("Ambiguous production selector.");
		providers.add(entry.provider);
		if (
			!Array.isArray(entry.services) ||
			!entry.services.length ||
			entry.services.length > 30
		)
			throw new Error("Explicit production services required.");
		return {
			provider: entry.provider,
			environment: "production",
			environmentField: entry.environmentField,
			environmentValue: literal(entry.environmentValue),
			services: [...new Set(entry.services.map(literal))],
			provenance: literal(entry.provenance),
		};
	});
}
export function validateDigestSettings(
	input: unknown,
): DigestCollectionSettings {
	const entry = object(input);
	keys(entry, [
		"gitlabHosts",
		"gitlabToolHost",
		"repositoryRoots",
		"productionSources",
	]);
	if (
		!Array.isArray(entry.gitlabHosts) ||
		entry.gitlabHosts.length > 30 ||
		entry.gitlabHosts.some(
			(host) =>
				typeof host !== "string" ||
				!/^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$/.test(host),
		)
	)
		throw new Error("Invalid pinned GitLab hosts.");
	if (
		entry.gitlabToolHost !== undefined &&
		(typeof entry.gitlabToolHost !== "string" ||
			!entry.gitlabHosts.includes(entry.gitlabToolHost))
	)
		throw new Error(
			"Integration host must match an explicitly verified configured host.",
		);
	if (
		!Array.isArray(entry.repositoryRoots) ||
		!entry.repositoryRoots.length ||
		entry.repositoryRoots.length > 30 ||
		entry.repositoryRoots.some(
			(root) =>
				typeof root !== "string" ||
				!root.startsWith("/") ||
				posix.normalize(root) === "/" ||
				root
					.split("/")
					.some((segment) => segment === ".." || segment === ".") ||
				root.includes("\0") ||
				root.includes("\n") ||
				root.includes("\r") ||
				root.length > 4096,
		)
	)
		throw new Error("Invalid pinned repository roots.");
	return {
		gitlabHosts: entry.gitlabHosts as string[],
		...(entry.gitlabToolHost
			? { gitlabToolHost: entry.gitlabToolHost as string }
			: {}),
		repositoryRoots: entry.repositoryRoots as string[],
		productionSources: validateProductionSources(entry.productionSources),
	};
}
