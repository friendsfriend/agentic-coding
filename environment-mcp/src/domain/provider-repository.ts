import type { ProviderType } from "./provider.ts";

export type ProviderRemote = {
	name: string;
	type: ProviderType;
	baseUrl: string;
};

export type ProviderRepositoryMatch = {
	provider: string;
	type: ProviderType;
	reference: string;
	host: string;
	url: string;
};

function remoteParts(value: string) {
	if (value.includes("://")) {
		try {
			const url = new URL(value);
			if (!url.hostname) return undefined;
			return {
				host: url.hostname.toLowerCase(),
				path: decodeURIComponent(url.pathname),
			};
		} catch {
			return undefined;
		}
	}
	const match = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(value);
	if (!match?.[1] || !match[2]) return undefined;
	return { host: match[1].toLowerCase(), path: match[2] };
}

function webHost(provider: ProviderRemote) {
	let host: string;
	try {
		host = new URL(provider.baseUrl).hostname.toLowerCase();
	} catch {
		return [];
	}
	const hosts = new Set([host]);
	if (provider.type === "github") {
		if (host === "api.github.com") hosts.add("github.com");
		if (host.startsWith("api.")) hosts.add(host.slice(4));
	}
	return [...hosts];
}

export function providerRepositoryMatches(
	providers: readonly ProviderRemote[],
	remoteUrl: string,
): ProviderRepositoryMatch[] {
	const parts = remoteParts(remoteUrl.trim());
	if (!parts) return [];
	const reference = parts.path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	if (!reference) return [];
	const segments = reference.split("/");
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				!/^[A-Za-z0-9_.-]+$/.test(segment),
		)
	)
		return [];
	const matches = providers.flatMap((provider): ProviderRepositoryMatch[] => {
		if (!webHost(provider).includes(parts.host)) return [];
		if (provider.type === "github" && segments.length !== 2) return [];
		return [
			{
				provider: provider.name,
				type: provider.type,
				reference,
				host: parts.host,
				url: `https://${parts.host}/${reference}`,
			},
		];
	});
	return matches
		.filter(
			(match, index) =>
				matches.findIndex(
					(candidate) =>
						candidate.provider === match.provider &&
						candidate.reference === match.reference,
				) === index,
		)
		.sort(
			(left, right) =>
				left.provider.localeCompare(right.provider) ||
				left.reference.localeCompare(right.reference),
		);
}
