import { boundedFetch, maskSecrets, redactSecrets } from "../http/admission.ts";
import { type ProviderConfig, providerToken } from "./config.ts";

/** Unified change (PR/MR), issue and CI job shapes. Host quirks stay in the
 * mappers; routes and the TUI see one model. */
export type Change = {
	id: string;
	number: number;
	title: string;
	state: string;
	sourceBranch: string;
	targetBranch: string;
	author: string;
	url: string;
};
export type Issue = {
	id: string;
	number: number;
	title: string;
	state: string;
	author: string;
	labels: string[];
	url: string;
};
export type Job = {
	id: string;
	name: string;
	status: string;
	url: string;
};
export type ProviderError = { error: string };
const fill = (value: unknown, fallback = "") =>
	typeof value === "string" ? value : fallback;
export function mapGitHubChange(raw: Record<string, unknown>): Change {
	return {
		id: `github-change-${String(raw.number ?? 0)}`,
		number: Number(raw.number ?? 0),
		title: fill(raw.title),
		state: fill(raw.state),
		sourceBranch: fill((raw.head as Record<string, unknown> | undefined)?.ref),
		targetBranch: fill((raw.base as Record<string, unknown> | undefined)?.ref),
		author: fill((raw.user as Record<string, unknown> | undefined)?.login),
		url: fill(raw.html_url),
	};
}
export function mapGitLabChange(raw: Record<string, unknown>): Change {
	return {
		id: `gitlab-change-${String(raw.iid ?? 0)}`,
		number: Number(raw.iid ?? 0),
		title: fill(raw.title),
		state: fill(raw.state),
		sourceBranch: fill(raw.source_branch),
		targetBranch: fill(raw.target_branch),
		author: fill((raw.author as Record<string, unknown> | undefined)?.username),
		url: fill(raw.web_url),
	};
}
export function mapGitHubIssue(raw: Record<string, unknown>): Issue {
	return {
		id: `github-issue-${String(raw.number ?? 0)}`,
		number: Number(raw.number ?? 0),
		title: fill(raw.title),
		state: fill(raw.state),
		author: fill((raw.user as Record<string, unknown> | undefined)?.login),
		labels: Array.isArray(raw.labels)
			? raw.labels.map((label) =>
					typeof label === "string"
						? label
						: fill((label as Record<string, unknown>).name),
				)
			: [],
		url: fill(raw.html_url),
	};
}
export function mapGitLabIssue(raw: Record<string, unknown>): Issue {
	return {
		id: `gitlab-issue-${String(raw.iid ?? 0)}`,
		number: Number(raw.iid ?? 0),
		title: fill(raw.title),
		state: fill(raw.state),
		author: fill((raw.author as Record<string, unknown> | undefined)?.username),
		labels: Array.isArray(raw.labels)
			? raw.labels.filter((label): label is string => typeof label === "string")
			: [],
		url: fill(raw.web_url),
	};
}
export type Client = {
	headers: Record<string, string>;
	get: (path: string) => Promise<unknown>;
	post: (path: string, body?: unknown) => Promise<unknown>;
	patch: (path: string, body?: unknown) => Promise<unknown>;
	put: (path: string, body?: unknown) => Promise<unknown>;
	raw: (
		path: string,
		init?: { redirect?: RequestRedirect; accept?: string; maxBytes?: number },
	) => Promise<{
		status: number;
		headers: Headers;
		body: string;
		truncated: boolean;
	}>;
};
/** Outbound client. Auth headers are set here; the token never leaves. */
export function providerClient(
	provider: ProviderConfig,
	fetchImpl: typeof fetch = fetch,
): Client {
	const token = providerToken(provider);
	if (!token) throw new Error("Provider has no configured token");
	const headers: Record<string, string> =
		provider.type === "github"
			? {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
				}
			: { "PRIVATE-TOKEN": token };
	const call = async (
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> => {
		if (!path.startsWith("/")) throw new Error("Invalid provider path");
		const { status, body: text } = await boundedFetch(
			fetchImpl,
			`${provider.baseUrl}${path}`,
			{
				method,
				headers: {
					...headers,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		);
		if (status < 200 || status >= 300)
			throw new Error(`Upstream provider refused the request (${status})`);
		try {
			return text
				? (JSON.parse(text, (_key, value: unknown) =>
						typeof value === "string"
							? method === "GET"
								? maskSecrets(value, [token])
								: redactSecrets(value, [token])
							: value,
					) as unknown)
				: null;
		} catch {
			throw new Error("Upstream provider returned invalid data");
		}
	};
	return {
		headers: {
			...headers,
			Authorization: "<redacted>",
			"PRIVATE-TOKEN": "<redacted>",
		},
		get: (path) => call("GET", path),
		post: (path, body) => call("POST", path, body),
		patch: (path, body) => call("PATCH", path, body),
		put: (path, body) => call("PUT", path, body),
		raw: async (path, init) => {
			if (!path.startsWith("/")) throw new Error("Invalid provider path");
			const response = await boundedFetch(
				fetchImpl,
				`${provider.baseUrl}${path}`,
				{
					headers: {
						...headers,
						...(init?.accept ? { Accept: init.accept } : {}),
					},
					redirect: init?.redirect,
					maxBytes: init?.maxBytes ?? 262144,
					onTooLarge: "truncate",
				},
			);
			return { ...response, body: redactSecrets(response.body, [token]) };
		},
	};
}
/** Redact a token-bearing value for logs and error envelopes. */
export function redact(value: string, provider: ProviderConfig): string {
	return redactSecrets(value, [providerToken(provider)]);
}
