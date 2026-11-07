import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { type Config, digest, object, text } from "../config.ts";
import { boundedFetch } from "../http/admission.ts";
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
	redact,
} from "./clients.ts";
import {
	findProvider,
	type ProviderConfig,
	providerProjection,
	providerToken,
} from "./config.ts";
import {
	ProviderWrites,
	recordWrite,
	replayWrite,
	writeKey,
} from "./receipts.ts";

export type FileChange = {
	path: string;
	additions: number | null;
	deletions: number | null;
	patch: string;
};
export type Version = { id: string; sha: string; message: string };

type Store = () => Harness;
const isList = (value: unknown): value is Record<string, unknown>[] =>
	Array.isArray(value);
const pick = (raw: Record<string, unknown> | null, keys: readonly string[]) => {
	const out: Record<string, unknown> = {};
	for (const key of keys)
		if (raw && Object.hasOwn(raw, key)) out[key] = raw[key];
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
		const n = typeof value === "number" ? value : Number(value);
		if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`);
		return n;
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
	async jobs(provider: string, repo: unknown, run: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo));
		if (resolved.type === "github") {
			if (run === undefined || run === null)
				throw new Error("GitHub job listing requires a run ID");
			const raw = await client.get(
				`/repos/${reference}/actions/runs/${this.num(run, "run ID")}/jobs?per_page=30`,
			);
			const items = (raw as Record<string, unknown>).jobs as unknown;
			if (!isList(items))
				throw new Error("Upstream provider returned invalid data");
			return items.map(
				(item): Job => ({
					id: `github-job-${String(item.id ?? 0)}`,
					name: typeof item.name === "string" ? item.name : "",
					status: typeof item.status === "string" ? item.status : "",
					url: typeof item.html_url === "string" ? item.html_url : "",
				}),
			);
		}
		const raw = await client.get(
			`/projects/${reference}/pipelines?per_page=30`,
		);
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map(
			(item): Job => ({
				id: `gitlab-pipeline-${String(item.id ?? 0)}`,
				name: typeof item.ref === "string" ? item.ref : "",
				status: typeof item.status === "string" ? item.status : "",
				url: typeof item.web_url === "string" ? item.web_url : "",
			}),
		);
	}
	async jobLogs(provider: string, repo: unknown, job: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			id = this.num(job, "job ID");
		if (resolved.type === "github") {
			const first = await client.raw(
				`/repos/${reference}/actions/jobs/${id}/logs`,
				{ redirect: "manual" },
			);
			if (first.status === 301 || first.status === 302) {
				const location = first.headers.get("location") ?? "";
				if (!location.startsWith("https://") && !location.startsWith("http://"))
					throw new Error("Upstream provider returned an invalid log location");
				// Signed artifact URL: fetched without credentials.
				const { status, body, truncated } = await boundedFetch(
					fetch,
					location,
					{
						redirect: "follow",
						headers: { Accept: "text/plain" },
						maxBytes: 262144,
						onTooLarge: "truncate",
					},
				);
				if (status < 200 || status >= 300)
					throw new Error(`Upstream provider refused the request (${status})`);
				return { log: body, truncated };
			}
			if (first.status < 200 || first.status >= 300)
				throw new Error(
					`Upstream provider refused the request (${first.status})`,
				);
			return { log: first.body, truncated: first.truncated };
		}
		const result = await client.raw(`/projects/${reference}/jobs/${id}/trace`, {
			accept: "text/plain",
		});
		if (result.status < 200 || result.status >= 300)
			throw new Error(
				`Upstream provider refused the request (${result.status})`,
			);
		return { log: result.body, truncated: result.truncated };
	}
	async changeFiles(
		provider: string,
		repo: unknown,
		number: unknown,
	): Promise<FileChange[]> {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			n = this.num(number, "change number");
		if (resolved.type === "github") {
			const raw = await client.get(
				`/repos/${reference}/pulls/${n}/files?per_page=100`,
			);
			if (!isList(raw))
				throw new Error("Upstream provider returned invalid data");
			return raw.map(
				(item): FileChange => ({
					path: typeof item.filename === "string" ? item.filename : "",
					additions: typeof item.additions === "number" ? item.additions : null,
					deletions: typeof item.deletions === "number" ? item.deletions : null,
					patch: typeof item.patch === "string" ? item.patch : "",
				}),
			);
		}
		const raw = (await client.get(
			`/projects/${reference}/merge_requests/${n}/changes`,
		)) as Record<string, unknown>;
		const items = raw.changes as unknown;
		if (!isList(items))
			throw new Error("Upstream provider returned invalid data");
		return items.map(
			(item): FileChange => ({
				path: typeof item.new_path === "string" ? item.new_path : "",
				additions: null,
				deletions: null,
				patch: typeof item.diff === "string" ? item.diff : "",
			}),
		);
	}
	async changeVersions(
		provider: string,
		repo: unknown,
		number: unknown,
	): Promise<Version[]> {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo)),
			n = this.num(number, "change number");
		if (resolved.type === "github") {
			const raw = await client.get(
				`/repos/${reference}/pulls/${n}/commits?per_page=100`,
			);
			if (!isList(raw))
				throw new Error("Upstream provider returned invalid data");
			return raw.map(
				(item): Version => ({
					id: `github-commit-${typeof item.sha === "string" ? item.sha.slice(0, 12) : "0"}`,
					sha: typeof item.sha === "string" ? item.sha : "",
					message:
						typeof (item.commit as Record<string, unknown> | undefined)
							?.message === "string"
							? ((item.commit as Record<string, unknown>).message as string)
							: "",
				}),
			);
		}
		const raw = await client.get(
			`/projects/${reference}/merge_requests/${n}/versions?per_page=100`,
		);
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map(
			(item): Version => ({
				id: `gitlab-version-${String(item.id ?? 0)}`,
				sha:
					typeof item.head_commit_sha === "string" ? item.head_commit_sha : "",
				message: "",
			}),
		);
	}
	async repoLabels(provider: string, repo: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo));
		const raw =
			resolved.type === "github"
				? await client.get(`/repos/${reference}/labels?per_page=100`)
				: await client.get(`/projects/${reference}/labels?per_page=100`);
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map((item) => pick(item, ["name", "color"]));
	}
	async repoCollaborators(provider: string, repo: unknown) {
		const resolved = this.resolve(provider),
			client = this.client(resolved),
			reference = this.ref(String(repo));
		const raw =
			resolved.type === "github"
				? await client.get(`/repos/${reference}/collaborators?per_page=100`)
				: await client.get(`/projects/${reference}/members?per_page=100`);
		if (!isList(raw))
			throw new Error("Upstream provider returned invalid data");
		return raw.map((item) =>
			resolved.type === "github"
				? pick(item, ["login", "role_name"])
				: pick(item, ["username", "access_level"]),
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
			const safe = JSON.parse(
				JSON.stringify(result, (_key, value: unknown) =>
					typeof value === "string" ? redact(value, resolved) : value,
				),
			) as unknown;
			recordWrite(doc, key, request, safe);
			return safe;
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
	/** Explicit immutable-head approval for native UI; does not replace the existing HTTP method. */
	async approveExactChange(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"approve-exact-change",
			async (provider, client, target, payload) => {
				const [repo, number] = this.splitTarget(target),
					sha = text(payload.sha, "reviewed head SHA", 40).toLowerCase();
				if (!/^[a-f0-9]{40}$/.test(sha))
					throw new Error("Full reviewed head SHA required");
				const raw = (await client.get(
					provider.type === "github"
						? `/repos/${repo}/pulls/${number}`
						: `/projects/${repo}/merge_requests/${number}`,
				)) as Record<string, unknown>;
				const head =
					provider.type === "github"
						? (raw.head as Record<string, unknown> | undefined)?.sha
						: ((raw.diff_refs as Record<string, unknown> | undefined)
								?.head_sha ?? raw.sha);
				if (head !== sha)
					throw new Error("Reviewed head changed or is unavailable");
				return pick(
					(await client.post(
						provider.type === "github"
							? `/repos/${repo}/pulls/${number}/reviews`
							: `/projects/${repo}/merge_requests/${number}/approve`,
						provider.type === "github"
							? { event: "APPROVE", commit_id: sha }
							: { sha },
					)) as Record<string, unknown> | null,
					["id", "state", "commit_id"],
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
					(await client.put(`/projects/${repo}/issues/${number}`, {
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
							`/repos/${repo}/actions/runs/${id}/rerun`,
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
	private splitThread(target: string): [string, string, string] {
		const [repo, number] = this.splitTarget(target),
			hash = number.indexOf("#");
		if (hash < 1 || hash === number.length - 1)
			throw new Error("Invalid write target");
		return [repo, number.slice(0, hash), number.slice(hash + 1)];
	}
	async cancelJob(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"cancel-job",
			async (provider, client, target) => {
				const [repo, id] = this.splitTarget(target);
				if (provider.type === "github")
					return pick(
						(await client.post(
							`/repos/${repo}/actions/runs/${id}/cancel`,
						)) as Record<string, unknown>,
						["id", "status"],
					);
				return pick(
					(await client.post(`/projects/${repo}/jobs/${id}/cancel`)) as Record<
						string,
						unknown
					>,
					["id", "status"],
				);
			},
		);
	}
	async unapproveChange(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"unapprove-change",
			async (provider, client, target) => {
				const [repo, number] = this.splitTarget(target);
				if (provider.type === "github") {
					const who = (await client.get("/user")) as Record<string, unknown>;
					if (!provider.username || who.login !== provider.username)
						throw new Error(
							"Configured provider username does not match the authenticated account",
						);
					const reviews = await client.get(
						`/repos/${repo}/pulls/${number}/reviews?per_page=100`,
					);
					if (!isList(reviews))
						throw new Error("Upstream provider returned invalid data");
					const mine = reviews.find(
						(review) =>
							review.state === "APPROVED" &&
							(review.user as Record<string, unknown> | undefined)?.login ===
								provider.username,
					);
					if (!mine || typeof mine.id !== "number")
						throw new Error("No approval by this provider user to dismiss");
					return pick(
						(await client.put(
							`/repos/${repo}/pulls/${number}/reviews/${mine.id}/dismissals`,
							{ message: "dismissed" },
						)) as Record<string, unknown>,
						["id", "state"],
					);
				}
				return pick(
					(await client.post(
						`/projects/${repo}/merge_requests/${number}/unapprove`,
					)) as Record<string, unknown>,
					["id", "title"],
				);
			},
		);
	}
	async rebaseChange(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"rebase-change",
			async (provider, client, target) => {
				if (provider.type !== "gitlab")
					throw new Error("Rebase is unsupported for this provider type");
				const [repo, number] = this.splitTarget(target);
				return pick(
					(await client.post(
						`/projects/${repo}/merge_requests/${number}/rebase`,
					)) as Record<string, unknown>,
					["id", "rebase_in_progress"],
				);
			},
		);
	}
	async replyDiscussion(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"reply-discussion",
			async (provider, client, target, payload) => {
				const [repo, change, thread] = this.splitThread(target),
					comment = text(payload.body, "comment body", 65536);
				if (provider.type === "github")
					return pick(
						(await client.post(`/repos/${repo}/pulls/${change}/comments`, {
							body: comment,
							in_reply_to: Number(thread),
						})) as Record<string, unknown>,
						["id", "html_url"],
					);
				return pick(
					(await client.post(
						`/projects/${repo}/merge_requests/${change}/discussions/${thread}/notes`,
						{ body: comment },
					)) as Record<string, unknown>,
					["id", "body"],
				);
			},
		);
	}
	async resolveDiscussion(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"resolve-discussion",
			async (provider, client, target, payload) => {
				if (provider.type !== "gitlab")
					throw new Error(
						"Discussion resolution is unsupported for this provider type",
					);
				const [repo, change, thread] = this.splitThread(target),
					resolved = payload.resolved !== false;
				return pick(
					(await client.put(
						`/projects/${repo}/merge_requests/${change}/discussions/${thread}`,
						{ resolved },
					)) as Record<string, unknown>,
					["id", "resolved"],
				);
			},
		);
	}
	async setIssueLabels(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"set-issue-labels",
			async (provider, client, target, payload) => {
				const [repo, number] = this.splitTarget(target);
				if (!Array.isArray(payload.labels))
					throw new Error("Issue labels must be an array");
				const labels = payload.labels.map((label) =>
					text(label, "issue label", 64),
				);
				if (provider.type === "github")
					return pick(
						(await client.patch(`/repos/${repo}/issues/${number}`, {
							labels,
						})) as Record<string, unknown>,
						["id", "labels"],
					);
				return pick(
					(await client.put(`/projects/${repo}/issues/${number}`, {
						labels: labels.join(","),
					})) as Record<string, unknown>,
					["id", "labels"],
				);
			},
		);
	}
	async setIssueAssignees(name: unknown, body: Record<string, unknown>) {
		return this.write(
			name,
			body,
			"set-issue-assignees",
			async (provider, client, target, payload) => {
				const [repo, number] = this.splitTarget(target);
				if (!Array.isArray(payload.assignees))
					throw new Error("Issue assignees must be an array");
				if (provider.type === "github") {
					const assignees = payload.assignees.map((login) =>
						text(login, "assignee login", 128),
					);
					return pick(
						(await client.patch(`/repos/${repo}/issues/${number}`, {
							assignees,
						})) as Record<string, unknown>,
						["id", "assignees"],
					);
				}
				const assignee_ids = payload.assignees.map((id) =>
					this.num(id, "assignee ID"),
				);
				return pick(
					(await client.put(`/projects/${repo}/issues/${number}`, {
						assignee_ids,
					})) as Record<string, unknown>,
					["id", "assignees"],
				);
			},
		);
	}
}
