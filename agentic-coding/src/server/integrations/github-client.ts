// GitHub provider client (`port-git-providers-and-ai-to-bun`, tasks 2.1,
// 3.1-3.4): repository search, issues, change requests, discussions, approvals
// and Actions/CI.
//
// The client is constructed with an injectable `fetch` and `baseUrl` so the
// cross-runtime fixtures under `test/fixtures/integrations/github` can replay
// recorded provider responses and assert both the request that is issued and
// the parsed value, without ever calling a live provider.
import type { ProviderSearchResult } from "./search-result.ts";

export const GITHUB_DEFAULT_BASE_URL = "https://api.github.com";
export const DEFAULT_PROVIDER_LIMIT = 20;
export const MAX_PROVIDER_LIMIT = 100;

export class ProviderHttpError extends Error {
	readonly code = "provider-http";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ProviderHttpError";
	}
}

export interface GitHubClientOptions {
	readonly token: string;
	readonly username?: string;
	readonly baseUrl?: string;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface GitHubResponse {
	readonly status: number;
	readonly body: string;
	readonly headers: Headers;
}

/** Owner/repository pair extracted from a GitHub URL. */
export interface GitHubRepoInfo {
	readonly owner: string;
	readonly repo: string;
}

/** The provider page size both runtimes clamp to for search endpoints. */
export function clampProviderLimit(limit: number): number {
	if (limit <= 0) return DEFAULT_PROVIDER_LIMIT;
	if (limit > MAX_PROVIDER_LIMIT) return MAX_PROVIDER_LIMIT;
	return limit;
}

/**
 * Query parameters in the order the Go client's `url.Values.Encode()` produced
 * them (alphabetical by key), so a recorded fixture URL matches byte for byte.
 */
export function sortedParams(
	entries: Readonly<Record<string, string>>,
): string {
	const params = new URLSearchParams();
	for (const key of Object.keys(entries).sort()) params.set(key, entries[key]);
	return params.toString();
}

/** Extract owner/repo from an HTTPS or SSH GitHub URL. */
export function extractRepoInfo(gitUrl: string): GitHubRepoInfo {
	const url = gitUrl.trim();
	if (url === "") throw new Error("empty Git URL");
	let ownerRepo: string;
	if (url.startsWith("git@github.com:")) {
		ownerRepo = url.slice("git@github.com:".length).replace(/\.git$/, "");
	} else if (
		url.startsWith("https://github.com/") ||
		url.startsWith("http://github.com/")
	) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`failed to parse GitHub URL: ${url}`);
		}
		ownerRepo = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
	} else {
		throw new Error(`not a GitHub URL: ${gitUrl}`);
	}
	const parts = ownerRepo.split("/");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "")
		throw new Error(
			`invalid GitHub URL format (expected owner/repo): ${gitUrl}`,
		);
	return { owner: parts[0], repo: parts[1] };
}

/**
 * Pagination from a GitHub `Link` header. `totalPages` is `-1` when unknown; a
 * header without a `next` link means the current page is the last one, and a
 * `last` link always wins.
 */
export function parseLinkHeaderForPagination(
	linkHeader: string,
	currentPage: number,
): { page: number; totalPages: number } {
	const page = currentPage;
	if (linkHeader === "") return { page, totalPages: currentPage };
	let hasNext = false;
	let lastPageNum = -1;
	for (const rawLink of linkHeader.split(",")) {
		const parts = rawLink.trim().split(";");
		if (parts.length < 2) continue;
		const relMatch = /rel="([^"]+)"/.exec(parts[1].trim());
		if (!relMatch) continue;
		const pageMatch = /[?&]page=(\d+)/.exec(parts[0].trim());
		if (!pageMatch) continue;
		const pageNum = Number(pageMatch[1]);
		if (relMatch[1] === "next") hasNext = true;
		if (relMatch[1] === "last") lastPageNum = pageNum;
	}
	let totalPages = -1;
	if (!hasNext) totalPages = currentPage;
	if (lastPageNum > 0) totalPages = lastPageNum;
	return { page, totalPages };
}

export class GitHubClient {
	readonly token: string;
	readonly username: string;
	readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly signal?: AbortSignal;
	private readonly timeoutMs: number;

	constructor(options: GitHubClientOptions) {
		this.token = options.token;
		this.username = options.username ?? "";
		this.baseUrl = options.baseUrl ?? GITHUB_DEFAULT_BASE_URL;
		this.fetchFn = options.fetch ?? fetch;
		this.signal = options.signal;
		this.timeoutMs = options.timeoutMs ?? 15_000;
	}

	/** One authenticated GitHub API call. `Content-Type` is only sent with a
	 * body, matching the Go client. */
	async request(
		method: string,
		url: string,
		body?: string,
		options: { readonly redirect?: "manual" } = {},
	): Promise<GitHubResponse> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "devenv-cli",
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const signal =
			this.signal ?? AbortSignal.timeout(Math.max(1, this.timeoutMs));
		const response = await this.fetchFn(url, {
			method,
			headers,
			...(body === undefined ? {} : { body }),
			signal,
			...(options.redirect ? { redirect: options.redirect } : {}),
		});
		return {
			status: response.status,
			body: await response.text(),
			headers: response.headers,
		};
	}

	/** Search repositories. Query parameters are emitted in the same sorted
	 * order the Go client's `url.Values.Encode()` produced. */
	async search(query: string, limit: number): Promise<ProviderSearchResult[]> {
		const params = sortedParams({
			per_page: String(clampProviderLimit(limit)),
			q: query,
			sort: "updated",
		});
		const response = await this.request(
			"GET",
			`${this.baseUrl}/search/repositories?${params}`,
		);
		if (response.status !== 200)
			throw new ProviderHttpError(
				response.status,
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		let parsed: unknown;
		try {
			parsed = JSON.parse(response.body);
		} catch (error) {
			throw new Error(
				`failed to parse search response: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return itemsOf(parsed).map((item) => ({
			name: text(item.name),
			fullPath: text(item.full_name),
			httpUrl: text(item.clone_url),
			defaultBranch: text(item.default_branch),
		}));
	}
}

function itemsOf(parsed: unknown): Record<string, unknown>[] {
	if (typeof parsed !== "object" || parsed === null) return [];
	const items = (parsed as { items?: unknown }).items;
	if (!Array.isArray(items)) return [];
	return items.filter(
		(item): item is Record<string, unknown> =>
			typeof item === "object" && item !== null,
	);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
