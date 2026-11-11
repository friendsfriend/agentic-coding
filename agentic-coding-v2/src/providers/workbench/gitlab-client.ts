// GitLab provider client (`port-git-providers-and-ai-to-bun`, tasks 3.5-3.8).
//
// One class carries the shared HTTP boundary for issues, merge requests,
// discussions, approvals and CI: `PRIVATE-TOKEN` authentication, the
// `namespace/project` path encoding Go's `url.QueryEscape` produced, the
// `X-Total`/`X-Total-Pages`/`X-Page` pagination headers, and an injectable
// `fetch` so the cross-runtime fixtures can replay recorded responses.
import type { ProviderSearchResult } from "./search-result.ts";

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

export interface GitLabProjectInfo {
	readonly host: string;
	readonly namespace: string;
	readonly project: string;
}

export interface GitLabClientOptions {
	readonly baseUrl: string;
	readonly token: string;
	readonly username?: string;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface GitLabResponse {
	readonly status: number;
	readonly body: string;
	readonly headers: Headers;
}

export interface GitLabRequestOptions {
	readonly body?: string;
	readonly contentType?: string;
	readonly accept?: string;
	readonly method?: string;
}

/** Pagination from GitLab's response headers. */
export interface GitLabPagination {
	readonly totalCount: number;
	readonly totalPages: number;
	readonly currentPage: number;
}

/** `url.QueryEscape` for a project path: `/` becomes `%2F`, space becomes `+`. */
export function queryEscape(value: string): string {
	return encodeURIComponent(value)
		.replace(/%20/g, "+")
		.replace(
			/[!'()*]/g,
			(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
		);
}

export function projectPath(info: GitLabProjectInfo): string {
	return queryEscape(`${info.namespace}/${info.project}`);
}

/** Extract host, namespace and project from an HTTPS or SSH GitLab URL. */
export function extractProjectInfo(gitUrl: string): GitLabProjectInfo {
	const url = gitUrl.trim();
	if (url === "") throw new Error("empty Git URL");
	let host = "";
	let project = "";
	if (url.startsWith("git@")) {
		const parts = url.split(":");
		if (parts.length < 2)
			throw new Error(`invalid SSH Git URL format: ${gitUrl}`);
		host = parts[0].replace(/^git@/, "");
		project = parts
			.slice(1)
			.join(":")
			.replace(/\.git$/, "");
	} else if (url.startsWith("https://") || url.startsWith("http://")) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`failed to parse Git URL: ${gitUrl}`);
		}
		host = parsed.hostname;
		project = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
	} else {
		throw new Error(`unsupported Git URL format: ${gitUrl}`);
	}
	if (host === "" || project === "")
		throw new Error(
			`could not extract host and project path from URL: ${gitUrl}`,
		);
	const parts = project.split("/");
	if (parts.length < 2)
		throw new Error(
			`invalid project path format (expected group/project): ${project}`,
		);
	return { host, namespace: parts[0], project: parts.slice(1).join("/") };
}

export class GitLabClient {
	readonly baseUrl: string;
	readonly token: string;
	readonly username: string;
	private readonly fetchFn: typeof fetch;
	private readonly signal?: AbortSignal;
	private readonly timeoutMs: number;

	constructor(options: GitLabClientOptions) {
		// The Go client accepted a bare host and normalized it to https.
		const withScheme =
			options.baseUrl.startsWith("http://") ||
			options.baseUrl.startsWith("https://")
				? options.baseUrl
				: `https://${options.baseUrl}`;
		this.baseUrl = withScheme.replace(/\/+$/, "");
		this.token = options.token;
		this.username = options.username ?? "";
		this.fetchFn = options.fetch ?? fetch;
		this.signal = options.signal;
		this.timeoutMs = options.timeoutMs ?? 15_000;
	}

	/** One authenticated GitLab API call. */
	async request(
		url: string,
		options: GitLabRequestOptions = {},
	): Promise<GitLabResponse> {
		const headers: Record<string, string> = {
			"PRIVATE-TOKEN": this.token,
			"User-Agent": "devenv-cli",
			Accept: options.accept ?? "application/json",
		};
		if (options.contentType) headers["Content-Type"] = options.contentType;
		const signal =
			this.signal ?? AbortSignal.timeout(Math.max(1, this.timeoutMs));
		const response = await this.fetchFn(url, {
			method: options.method ?? "GET",
			headers,
			...(options.body === undefined ? {} : { body: options.body }),
			signal,
		});
		return {
			status: response.status,
			body: await response.text(),
			headers: response.headers,
		};
	}

	/** Issue search, shared with the repository-search route. */
	async searchProjects(
		query: string,
		limit: number,
	): Promise<ProviderSearchResult[]> {
		const params = new URLSearchParams();
		params.set("membership", "true");
		params.set("order_by", "last_activity_at");
		params.set("per_page", String(clampProviderLimit(limit)));
		params.set("search", query);
		const response = await this.request(
			`${this.baseUrl}/api/v4/projects?${params.toString()}`,
		);
		if (response.status !== 200)
			throw new ProviderHttpError(
				response.status,
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
		let parsed: unknown;
		try {
			parsed = JSON.parse(response.body);
		} catch (error) {
			throw new Error(
				`failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(project): project is Record<string, unknown> =>
					typeof project === "object" && project !== null,
			)
			.map((project) => ({
				name: text(project.name),
				fullPath: text(project.path_with_namespace),
				httpUrl: text(project.http_url_to_repo),
				defaultBranch: text(project.default_branch),
			}));
	}
}

/** The provider page size both runtimes clamp to. */
export function clampProviderLimit(limit: number): number {
	if (limit <= 0) return DEFAULT_PROVIDER_LIMIT;
	if (limit > MAX_PROVIDER_LIMIT) return MAX_PROVIDER_LIMIT;
	return limit;
}

/** Read `X-Total`, `X-Total-Pages` and `X-Page`, defaulting to the request's
 * page and `-1` for an unknown total. */
export function gitLabPagination(
	headers: Headers,
	requestedPage: number,
): GitLabPagination {
	let totalCount = -1;
	let totalPages = -1;
	let currentPage = requestedPage;
	const total = headers.get("X-Total");
	if (total !== null && Number.isInteger(Number(total)))
		totalCount = Number(total);
	const totalPagesHeader = headers.get("X-Total-Pages");
	if (totalPagesHeader !== null && Number.isInteger(Number(totalPagesHeader)))
		totalPages = Number(totalPagesHeader);
	const pageHeader = headers.get("X-Page");
	if (pageHeader !== null && Number.isInteger(Number(pageHeader)))
		currentPage = Number(pageHeader);
	return { totalCount, totalPages, currentPage };
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
