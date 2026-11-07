import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { type Config, digest, object, text } from "../config.ts";
import {
	type Change,
	type Client,
	type Issue,
	type Job,
	mapGitHubChange,
	mapGitHubIssue,
	mapGitLabChange,
	mapGitLabIssue,
	providerClient,
} from "./clients.ts";
import {
	findProvider,
	type ProviderConfig,
	providerProjection,
	providerToken,
	readProviders,
} from "./config.ts";
import {
	ProviderWrites,
	recordWrite,
	replayWrite,
	writeKey,
} from "./receipts.ts";

export type { ProviderConfig };
export { readProviders };

type Store = () => Harness;
const isList = (value: unknown): value is Record<string, unknown>[] =>
	Array.isArray(value);
const pick = (raw: Record<string, unknown>, keys: readonly string[]) => {
	const out: Record<string, unknown> = {};
	for (const key of keys) out[key] = raw[key];
	return out;
};
/** Provider APIs: registry in config, live reads stateless, writes gated by an
 * explicit approval digest of the exact payload and recorded replay-safe. */
export class ProviderApis {
	constructor(
		private config: Config,
		private store: Store,
	) {}
	list() {
		return this.config.providers.map(providerProjection);
	}
	private resolve(name: unknown): ProviderConfig {
		return findProvider(this.config.providers, text(name, "provider name", 64));
	}
	private client(provider: ProviderConfig): Client {
		if (providerToken(provider) === "")
			throw new Error("Provider has no configured token");
		return providerClient(provider);
	}
	private ref(path: string): string {
		return encodeURIComponent(text(path, "repository reference", 256));
	}
	private num(value: unknown, name: string): number {
		if (!Number.isSafeInteger(value) || Number(value) < 1)
			throw new Error(`Invalid ${name}`);
		return Number(value);
	}
	async searchRepos(provider: string, query: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			q = text(query, "search query", 256);
		const raw =
			resolved.type === "github"
				? await client.get(
						`/search/repositories?q=${encodeURIComponent(q)}&per_page=20`,
					)
				: await client.get(
						`/projects?search=${encodeURIComponent(q)}&per_page=20`,
					);
		const items = (
			resolved.type === "github" ? (raw as Record<string, unknown>).items : raw
		) as unknown;
		if (!isList(items))
			throw new Error("Upstream provider returned invalid data");
		return items.map((item) =>
			resolved.type === "github"
				? pick(item, ["full_name", "description", "html_url"])
				: pick(item, ["path_with_namespace", "description", "web_url"]),
		);
	}
	async repoBranches(provider: string, repo: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo));
		const raw =
			resolved.type === "github"
				? await client.get(`/repos/${reference}/branches?per_page=100`)
				: await client.get(
						`/projects/${reference}/repository/branches?per_page=100`,
					);
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map((branch) =>
			resolved.type === "github"
				? pick(branch, ["name"])
				: pick(branch, ["name", "default"]),
		);
	}
	async changes(provider: string, repo: unknown, state: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			filter = state === undefined ? "open" : text(state, "change state", 16);
		if (!["open", "closed", "all"].includes(filter))
			throw new Error("Invalid change state");
		const raw =
			resolved.type === "github"
				? await client.get(
						`/repos/${reference}/pulls?state=${filter}&per_page=50`,
					)
				: await client.get(
						`/projects/${reference}/merge_requests?state=${filter === "all" ? "all" : filter === "open" ? "opened" : "closed"}&per_page=50`,
					);
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map((item) =>
			resolved.type === "github"
				? mapGitHubChange(item)
				: mapGitLabChange(item),
		);
	}
	async change(
		provider: string,
		repo: unknown,
		number: unknown,
	): Promise<Change> {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			n = this.num(number, "change number");
		const raw = (await (resolved.type === "github"
			? client.get(`/repos/${reference}/pulls/${n}`)
			: client.get(`/projects/${reference}/merge_requests/${n}`))) as Record<
			string,
			unknown
		>;
		return resolved.type === "github"
			? mapGitHubChange(raw)
			: mapGitLabChange(raw);
	}
	async discussions(provider: string, repo: unknown, number: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			n = this.num(number, "change number");
		const raw = await (resolved.type === "github"
			? client.get(`/repos/${reference}/pulls/${n}/comments?per_page=50`)
			: client.get(
					`/projects/${reference}/merge_requests/${n}/discussions?per_page=50`,
				));
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map((item) =>
			resolved.type === "github"
				? pick(item, ["id", "body", "user", "html_url"])
				: pick(item, ["id", "notes"]),
		);
	}
	async issues(provider: string, repo: unknown, state: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			filter = state === undefined ? "open" : text(state, "issue state", 16);
		if (!["open", "closed", "all"].includes(filter))
			throw new Error("Invalid issue state");
		const raw =
			resolved.type === "github"
				? await client.get(
						`/repos/${reference}/issues?state=${filter}&per_page=50`,
					)
				: await client.get(
						`/projects/${reference}/issues?state=${filter === "all" ? "all" : filter === "open" ? "opened" : "closed"}&per_page=50`,
					);
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map((item) =>
			resolved.type === "github" ? mapGitHubIssue(item) : mapGitLabIssue(item),
		);
	}
	async issue(
		provider: string,
		repo: unknown,
		number: unknown,
	): Promise<Issue> {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			n = this.num(number, "issue number");
		const raw = (await (resolved.type === "github"
			? client.get(`/repos/${reference}/issues/${n}`)
			: client.get(`/projects/${reference}/issues/${n}`))) as Record<
			string,
			unknown
		>;
		return resolved.type === "github"
			? mapGitHubIssue(raw)
			: mapGitLabIssue(raw);
	}
	async jobs(provider: string, repo: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo));
		const raw =
			resolved.type === "github"
				? await client.get(`/repos/${reference}/actions/runs?per_page=30`)
				: await client.get(`/projects/${reference}/pipelines?per_page=30`);
		const items = (
			resolved.type === "github"
				? (raw as Record<string, unknown>).workflow_runs
				: raw
		) as unknown;
		if (!isList(items))
			throw new Error("Upstream provider returned invalid data");
		return items.map(
			(item): Job =>
				resolved.type === "github"
					? {
							id: `github-run-${String(item.id ?? 0)}`,
							name: typeof item.name === "string" ? item.name : "",
							status: typeof item.status === "string" ? item.status : "",
							url: typeof item.html_url === "string" ? item.html_url : "",
						}
					: {
							id: `gitlab-pipeline-${String(item.id ?? 0)}`,
							name: typeof item.ref === "string" ? item.ref : "",
							status: typeof item.status === "string" ? item.status : "",
							url: typeof item.web_url === "string" ? item.web_url : "",
						},
		);
	}
	private approval(body: Record<string, unknown>): {
		requestId: string;
		op: string;
		target: string;
		payload: Record<string, unknown>;
	} {
		const requestId = text(body.requestId, "write request ID", 128),
			approve = text(body.approve, "approved write digest", 64);
		const op = text(body.op, "write operation", 32),
			target = text(body.target, "write target", 256),
			payload = object(body.payload);
		const expected = digest(JSON.stringify({ op, target, payload }));
		if (approve !== expected)
			throw new Error("Write requires approval of the exact payload digest");
		return { requestId, op, target, payload };
	}
	private async write(
		name: unknown,
		body: Record<string, unknown>,
		op: string,
		call: (
			provider: ProviderConfig,
			client: Client,
			target: string,
			payload: Record<string, unknown>,
		) => Promise<unknown>,
	): Promise<unknown> {
		if (text(body.op, "write operation", 32) !== op)
			throw new Error("Invalid write operation");
		const resolved = this.resolve(name),
			{ requestId, target, payload } = this.approval(body),
			key = writeKey(`${resolved.name}:${requestId}`),
			request = digest(JSON.stringify({ op, target, payload }));
		return this.store().commit(async (tx) => {
			const doc = await tx.doc(ProviderWrites),
				replayed = replayWrite(doc, key, request);
			if (replayed) return replayed.result;
			const result = await call(
				resolved,
				this.client(resolved),
				target,
				payload,
			);
			recordWrite(doc, key, request, result);
			return result;
		}, background);
	}
	private splitTarget(target: string): [string, string] {
		const hash = target.indexOf("#");
		if (hash < 1 || hash === target.length - 1)
			throw new Error("Invalid write target");
		return [encodeURIComponent(target.slice(0, hash)), target.slice(hash + 1)];
	}
	async commentOnChange(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"comment-change",
			async (provider, client, target, payload) => {
				const [repo, number] = this.splitTarget(target);
				if (provider.type === "github")
					return pick(
						(await client.post(`/repos/${repo}/issues/${number}/comments`, {
							body: text(payload.body, "comment body", 65536),
						})) as Record<string, unknown>,
						["id", "html_url"],
					);
				return pick(
					(await client.post(
						`/projects/${repo}/merge_requests/${number}/notes`,
						{ body: text(payload.body, "comment body", 65536) },
					)) as Record<string, unknown>,
					["id", "body"],
				);
			},
		);
	}
	async approveChange(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"approve-change",
			async (provider, client, target) => {
				const [repo, number] = this.splitTarget(target);
				if (provider.type === "github") {
					const reviews = (await client.post(
						`/repos/${repo}/pulls/${number}/reviews`,
						{ event: "APPROVE" },
					)) as Record<string, unknown>;
					return pick(reviews, ["id", "state"]);
				}
				return pick(
					(await client.post(
						`/projects/${repo}/merge_requests/${number}/approve`,
					)) as Record<string, unknown>,
					["id", "title"],
				);
			},
		);
	}
	async commentOnIssue(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"comment-issue",
			async (provider, client, target, payload) => {
				const [repo, number] = this.splitTarget(target);
				if (provider.type === "github")
					return pick(
						(await client.post(`/repos/${repo}/issues/${number}/comments`, {
							body: text(payload.body, "comment body", 65536),
						})) as Record<string, unknown>,
						["id", "html_url"],
					);
				return pick(
					(await client.post(`/projects/${repo}/issues/${number}/notes`, {
						body: text(payload.body, "comment body", 65536),
					})) as Record<string, unknown>,
					["id", "body"],
				);
			},
		);
	}
	async closeIssue(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"close-issue",
			async (provider, client, target) => {
				const [repo, number] = this.splitTarget(target);
				if (provider.type === "github")
					return pick(
						(await client.patch(`/repos/${repo}/issues/${number}`, {
							state: "closed",
						})) as Record<string, unknown>,
						["id", "state"],
					);
				return pick(
					(await client.post(`/projects/${repo}/issues/${number}`, {
						state_event: "close",
					})) as Record<string, unknown>,
					["id", "state"],
				);
			},
		);
	}
	async retryJob(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"retry-job",
			async (provider, client, target) => {
				const [repo, id] = this.splitTarget(target);
				if (provider.type === "github")
					return pick(
						(await client.post(
							`/repos/${repo}/actions/runs/${id}/retry`,
						)) as Record<string, unknown>,
						["id", "status"],
					);
				return pick(
					(await client.post(`/projects/${repo}/jobs/${id}/retry`)) as Record<
						string,
						unknown
					>,
					["id", "status"],
				);
			},
		);
	}
}
