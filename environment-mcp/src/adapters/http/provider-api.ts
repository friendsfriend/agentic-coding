import { createHash } from "node:crypto";
import { OperationRefusal } from "../../domain/operation.ts";
import type {
	ProviderChange,
	ProviderChangeDetail,
	ProviderConfig,
	ProviderDiscussion,
	ProviderFile,
	ProviderFiles,
	ProviderIssue,
	ProviderIssueDetail,
	ProviderJob,
	ProviderPipeline,
	ProviderPort,
	ProviderProjection,
	ProviderRepository,
	ProviderType,
	ProviderVersion,
	ProviderWriteIntent,
} from "../../domain/provider.ts";
import { openProviderWriteJournal } from "../../persistence/provider-write-journal.ts";

const responseLimit = 1024 * 1024;
const logLimit = 64 * 1024;
const patchLimit = 48 * 1024;
const timeoutMs = 12_000;
const redacted = "[REDACTED]";

type TokenSource = { get(reference: string): string | undefined };

const text = (value: unknown, fallback = "") =>
	typeof value === "string" ? value : fallback;
const number = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
const labels = (value: unknown) =>
	Array.isArray(value)
		? value.flatMap((entry) => {
				if (typeof entry === "string") return [entry];
				const name =
					entry && typeof entry === "object"
						? text((entry as Record<string, unknown>).name)
						: "";
				return name ? [name] : [];
			})
		: [];

function redactString(value: string, token: string) {
	return token ? value.split(token).join(redacted) : value;
}

function redactValue(value: unknown, token: string): unknown {
	if (typeof value === "string") return redactString(value, token);
	if (Array.isArray(value))
		return value.map((entry) => redactValue(entry, token));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				redactValue(entry, token),
			]),
		);
	return value;
}

function githubGraphqlUrl(baseUrl: string) {
	const url = new URL(baseUrl);
	if (url.hostname === "api.github.com" && url.pathname === "/")
		return "https://api.github.com/graphql";
	const base = url.pathname.replace(/\/api\/v3\/?$/, "").replace(/\/$/, "");
	url.pathname = `${base}/api/graphql`;
	return url.toString();
}

function refusalForStatus(status: number) {
	if (status === 401) return new OperationRefusal("provider-unauthorized");
	if (status === 403) return new OperationRefusal("provider-forbidden");
	if (status === 404) return new OperationRefusal("provider-not-found");
	if (status === 429) return new OperationRefusal("provider-rate-limited");
	if (status === 400 || status === 422)
		return new OperationRefusal("provider-invalid");
	return new OperationRefusal("provider-unavailable");
}

async function readBounded(response: Response, limit = responseLimit) {
	if (!response.body) return { body: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (length + value.byteLength > limit) {
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			length += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body: new TextDecoder().decode(bytes), truncated };
}

function optionalNumber(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value)
		? value
		: undefined;
}

function takeTextBytes(value: string, limit: number) {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength <= limit) return value;
	return new TextDecoder().decode(bytes.subarray(0, Math.max(0, limit)));
}

function repositoryReference(provider: ProviderConfig, repository: string) {
	if (
		repository.length > 256 ||
		!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(repository) ||
		repository
			.split("/")
			.some((part) => part === "" || part === "." || part === "..") ||
		(provider.type === "github" && repository.split("/").length !== 2)
	)
		throw new OperationRefusal("provider-invalid");
	return provider.type === "github"
		? repository.split("/").map(encodeURIComponent).join("/")
		: encodeURIComponent(repository);
}

function mapRepository(
	type: ProviderType,
	raw: Record<string, unknown>,
): ProviderRepository {
	const reference =
		type === "github" ? text(raw.full_name) : text(raw.path_with_namespace);
	const name =
		text(raw.name) || reference.split("/").filter(Boolean).at(-1) || reference;
	return {
		reference,
		name,
		description: text(raw.description),
		url: type === "github" ? text(raw.html_url) : text(raw.web_url),
		...(text(raw.default_branch)
			? { defaultBranch: text(raw.default_branch) }
			: {}),
	};
}

function mapChange(
	type: ProviderType,
	raw: Record<string, unknown>,
): ProviderChange {
	const numberValue = type === "github" ? number(raw.number) : number(raw.iid);
	const author =
		type === "github"
			? text((raw.user as Record<string, unknown> | undefined)?.login)
			: text((raw.author as Record<string, unknown> | undefined)?.username);
	const state =
		type === "github"
			? raw.merged_at
				? "merged"
				: text(raw.state)
			: text(raw.state) === "opened"
				? "open"
				: text(raw.state);
	return {
		id: `${type}-change-${numberValue}`,
		number: numberValue,
		title: text(raw.title),
		state,
		sourceBranch:
			type === "github"
				? text((raw.head as Record<string, unknown> | undefined)?.ref)
				: text(raw.source_branch),
		targetBranch:
			type === "github"
				? text((raw.base as Record<string, unknown> | undefined)?.ref)
				: text(raw.target_branch),
		author,
		url: type === "github" ? text(raw.html_url) : text(raw.web_url),
	};
}

function mapIssue(
	type: ProviderType,
	raw: Record<string, unknown>,
): ProviderIssue {
	const numberValue = type === "github" ? number(raw.number) : number(raw.iid);
	return {
		id: `${type}-issue-${numberValue}`,
		number: numberValue,
		title: text(raw.title),
		state:
			type === "github"
				? text(raw.state)
				: text(raw.state) === "opened"
					? "open"
					: text(raw.state),
		author:
			type === "github"
				? text((raw.user as Record<string, unknown> | undefined)?.login)
				: text((raw.author as Record<string, unknown> | undefined)?.username),
		labels: labels(raw.labels),
		url: type === "github" ? text(raw.html_url) : text(raw.web_url),
	};
}

function mapPipeline(
	type: ProviderType,
	raw: Record<string, unknown>,
): ProviderPipeline {
	if (type === "github") {
		const id = number(raw.id);
		return {
			id,
			name: text(raw.display_title) || text(raw.name) || `run ${id}`,
			status: text(raw.status),
			...(text(raw.conclusion) ? { conclusion: text(raw.conclusion) } : {}),
			...(text(raw.head_branch) ? { ref: text(raw.head_branch) } : {}),
			url: text(raw.html_url),
			...(text(raw.updated_at) ? { updatedAt: text(raw.updated_at) } : {}),
		};
	}
	const id = number(raw.id);
	const ref = text(raw.ref);
	return {
		id,
		name: ref || `pipeline ${id}`,
		status: text(raw.status),
		...(ref ? { ref } : {}),
		url: text(raw.web_url),
		...(text(raw.updated_at) ? { updatedAt: text(raw.updated_at) } : {}),
	};
}

function mapJob(type: ProviderType, raw: Record<string, unknown>): ProviderJob {
	return {
		id: number(raw.id),
		name: text(raw.name),
		status: text(raw.status),
		...(type === "github" && text(raw.conclusion)
			? { conclusion: text(raw.conclusion) }
			: {}),
		...(type === "gitlab" && text(raw.stage) ? { stage: text(raw.stage) } : {}),
		url: type === "github" ? text(raw.html_url) : text(raw.web_url),
	};
}

function mapChangeDetail(
	type: ProviderType,
	raw: Record<string, unknown>,
): ProviderChangeDetail {
	const change = mapChange(type, raw);
	const changedFiles =
		type === "github"
			? optionalNumber(raw.changed_files)
			: (() => {
					const parsed = Number(raw.changes_count);
					return Number.isSafeInteger(parsed) && parsed >= 0
						? parsed
						: undefined;
				})();
	return {
		...change,
		body: type === "github" ? text(raw.body) : text(raw.description),
		...(type === "github" && optionalNumber(raw.additions) !== undefined
			? { additions: optionalNumber(raw.additions) }
			: {}),
		...(type === "github" && optionalNumber(raw.deletions) !== undefined
			? { deletions: optionalNumber(raw.deletions) }
			: {}),
		...(changedFiles !== undefined ? { changedFiles } : {}),
		...(text(
			type === "github"
				? (raw.head as Record<string, unknown> | undefined)?.sha
				: ((raw.diff_refs as Record<string, unknown> | undefined)?.head_sha ??
						raw.sha),
		)
			? {
					headSha: text(
						type === "github"
							? (raw.head as Record<string, unknown> | undefined)?.sha
							: ((raw.diff_refs as Record<string, unknown> | undefined)
									?.head_sha ?? raw.sha),
					),
				}
			: {}),
		...(text(raw.created_at) ? { createdAt: text(raw.created_at) } : {}),
		...(text(raw.updated_at) ? { updatedAt: text(raw.updated_at) } : {}),
		...(type === "github" && text(raw.merged_at)
			? { mergedAt: text(raw.merged_at) }
			: {}),
	};
}

function mapIssueDetail(
	type: ProviderType,
	raw: Record<string, unknown>,
): ProviderIssueDetail {
	const issue = mapIssue(type, raw);
	return {
		...issue,
		body: type === "github" ? text(raw.body) : text(raw.description),
		...(text(raw.created_at) ? { createdAt: text(raw.created_at) } : {}),
		...(text(raw.updated_at) ? { updatedAt: text(raw.updated_at) } : {}),
	};
}

function filesFrom(
	entries: readonly Record<string, unknown>[],
	read: (entry: Record<string, unknown>) => ProviderFile,
	overflow = false,
): ProviderFiles {
	let used = 0;
	let truncated = overflow;
	const files = entries.flatMap((entry) => {
		const file = read(entry);
		if (!file.path) return [];
		if (!file.patch) return [file];
		const bytes = new TextEncoder().encode(file.patch).byteLength;
		if (used >= patchLimit) {
			truncated = true;
			return [{ ...file, patch: "" }];
		}
		if (used + bytes > patchLimit) {
			truncated = true;
			const patch = takeTextBytes(file.patch, patchLimit - used);
			used = patchLimit;
			return [{ ...file, patch }];
		}
		used += bytes;
		return [file];
	});
	return {
		files,
		truncated,
		...(overflow ? { note: "overflow" as const } : {}),
	};
}

function githubFiles(raw: readonly Record<string, unknown>[]) {
	return filesFrom(raw, (entry) => ({
		path: text(entry.filename),
		status: text(entry.status) || "modified",
		...(optionalNumber(entry.additions) !== undefined
			? { additions: optionalNumber(entry.additions) }
			: {}),
		...(optionalNumber(entry.deletions) !== undefined
			? { deletions: optionalNumber(entry.deletions) }
			: {}),
		patch: text(entry.patch),
	}));
}

function gitlabFiles(raw: Record<string, unknown>) {
	const changes = raw.changes;
	if (!Array.isArray(changes)) throw new OperationRefusal("provider-invalid");
	return filesFrom(
		changes.map((entry) =>
			entry && typeof entry === "object"
				? (entry as Record<string, unknown>)
				: {},
		),
		(entry) => ({
			path: text(entry.new_path) || text(entry.old_path),
			status: entry.new_file
				? "added"
				: entry.deleted_file
					? "deleted"
					: entry.renamed_file
						? "renamed"
						: "modified",
			patch: text(entry.diff),
		}),
		raw.overflow === true,
	);
}

function githubVersions(raw: readonly Record<string, unknown>[]) {
	return raw.map((entry): ProviderVersion => {
		const commit =
			entry.commit && typeof entry.commit === "object"
				? (entry.commit as Record<string, unknown>)
				: undefined;
		const author =
			commit?.author && typeof commit.author === "object"
				? (commit.author as Record<string, unknown>)
				: undefined;
		return {
			sha: text(entry.sha),
			message: text(commit?.message),
			...(text(author?.name) ? { author: text(author?.name) } : {}),
			...(text(author?.date) ? { date: text(author?.date) } : {}),
		};
	});
}

function gitlabVersions(raw: readonly Record<string, unknown>[]) {
	return raw.map(
		(entry): ProviderVersion => ({
			sha: text(entry.head_commit_sha),
			message: "",
			...(text(entry.created_at) ? { date: text(entry.created_at) } : {}),
		}),
	);
}

function githubDiscussions(raw: readonly Record<string, unknown>[]) {
	return raw.slice(0, 50).map((entry): ProviderDiscussion => {
		const id = String(optionalNumber(entry.id) ?? text(entry.id));
		return {
			id,
			threadId: id,
			author: text((entry.user as Record<string, unknown> | undefined)?.login),
			body: text(entry.body),
			...(text(entry.html_url) ? { url: text(entry.html_url) } : {}),
			...(text(entry.created_at) ? { createdAt: text(entry.created_at) } : {}),
		};
	});
}

function githubReviewDiscussions(threads: readonly Record<string, unknown>[]) {
	const discussions: ProviderDiscussion[] = [];
	for (const thread of threads) {
		const threadId = text(thread.id);
		const resolved = thread.isResolved === true;
		const comments = (thread.comments as Record<string, unknown> | undefined)
			?.nodes;
		for (const comment of Array.isArray(comments) ? comments : []) {
			if (!comment || typeof comment !== "object") continue;
			const entry = comment as Record<string, unknown>;
			const id = String(
				optionalNumber(entry.databaseId) ?? text(entry.databaseId),
			);
			if (!id) continue;
			discussions.push({
				id,
				...(threadId ? { threadId } : {}),
				author: text(
					(entry.author as Record<string, unknown> | undefined)?.login,
				),
				body: text(entry.body),
				...(text(entry.url) ? { url: text(entry.url) } : {}),
				...(text(entry.createdAt) ? { createdAt: text(entry.createdAt) } : {}),
				resolved,
			});
			if (discussions.length >= 50) return discussions;
		}
	}
	return discussions;
}

function gitlabNotes(raw: readonly Record<string, unknown>[]) {
	return raw.slice(0, 50).map(
		(entry): ProviderDiscussion => ({
			id: String(optionalNumber(entry.id) ?? text(entry.id)),
			author: text(
				(entry.author as Record<string, unknown> | undefined)?.username,
			),
			body: text(entry.body),
			...(text(entry.created_at) ? { createdAt: text(entry.created_at) } : {}),
			...(typeof entry.resolved === "boolean"
				? { resolved: entry.resolved }
				: {}),
		}),
	);
}

function gitlabDiscussions(raw: readonly Record<string, unknown>[]) {
	const notes = raw.flatMap((discussion) => {
		const threadId = text(discussion.id);
		return Array.isArray(discussion.notes)
			? discussion.notes.flatMap((entry) =>
					entry && typeof entry === "object"
						? [{ entry: entry as Record<string, unknown>, threadId }]
						: [],
				)
			: [];
	});
	return notes.slice(0, 50).map(
		({ entry, threadId }): ProviderDiscussion => ({
			id: String(optionalNumber(entry.id) ?? text(entry.id)),
			...(threadId ? { threadId } : {}),
			author: text(
				(entry.author as Record<string, unknown> | undefined)?.username,
			),
			body: text(entry.body),
			...(text(entry.created_at) ? { createdAt: text(entry.created_at) } : {}),
			...(typeof entry.resolved === "boolean"
				? { resolved: entry.resolved }
				: {}),
		}),
	);
}

const digestOf = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

function writeCanonical(intent: ProviderWriteIntent) {
	return {
		action: intent.action,
		provider: intent.provider,
		repository: intent.repository,
		...(intent.action === "retry-pipeline" ||
		intent.action === "cancel-pipeline"
			? { pipeline: intent.pipeline }
			: intent.action === "retry-job"
				? { job: intent.job }
				: { number: intent.number }),
		...("body" in intent ? { body: intent.body } : {}),
		...("sha" in intent ? { sha: intent.sha } : {}),
		...("mergeMethod" in intent ? { mergeMethod: intent.mergeMethod } : {}),
		...("state" in intent ? { state: intent.state } : {}),
		...("scope" in intent ? { scope: intent.scope } : {}),
		...("discussionId" in intent ? { discussionId: intent.discussionId } : {}),
		...("resolved" in intent ? { resolved: intent.resolved } : {}),
		...("labels" in intent ? { labels: [...intent.labels] } : {}),
		...("assignees" in intent ? { assignees: [...intent.assignees] } : {}),
	};
}

function writeTarget(intent: ProviderWriteIntent) {
	if (intent.action === "merge-change")
		return `${intent.repository}:${intent.number} (${intent.mergeMethod})`;
	if (intent.action === "retry-pipeline" || intent.action === "cancel-pipeline")
		return `${intent.repository}:${intent.pipeline}`;
	if (intent.action === "retry-job")
		return `${intent.repository}:job:${intent.job}`;
	if ("discussionId" in intent)
		return `${intent.repository}:${intent.number}:${intent.discussionId}`;
	return `${intent.repository}:${intent.number}`;
}

function pickResult(value: unknown, keys: readonly string[]) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	return Object.fromEntries(
		keys.flatMap((key) =>
			Object.hasOwn(raw, key) &&
			(typeof raw[key] === "string" ||
				typeof raw[key] === "number" ||
				typeof raw[key] === "boolean")
				? [[key, raw[key]]]
				: [],
		),
	);
}

export function createProviderApi(
	configs: readonly ProviderConfig[],
	tokens: TokenSource,
	fetchImpl: typeof fetch = fetch,
	options: { stateDir?: string } = {},
): ProviderPort {
	const writes = options.stateDir
		? openProviderWriteJournal(options.stateDir)
		: undefined;
	const resolve = (name: string) => {
		const provider = configs.find((entry) => entry.name === name);
		if (!provider) throw new OperationRefusal("provider-not-configured");
		return provider;
	};
	const tokenFor = (provider: ProviderConfig) => {
		const token = provider.tokenRef ? tokens.get(provider.tokenRef) : "";
		if (!token || token.length > 4096 || token.includes("\0"))
			throw new OperationRefusal("provider-token-unavailable");
		return token;
	};
	const withTimeout = async <T>(
		signal: AbortSignal,
		run: (timeoutSignal: AbortSignal) => Promise<T>,
	) => {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), timeoutMs);
		timer.unref?.();
		const abort = () => timeout.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			return await run(timeout.signal);
		} catch (error) {
			if (error instanceof OperationRefusal) throw error;
			if (signal.aborted) throw error;
			throw new OperationRefusal("provider-unavailable");
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
	};
	const authHeaders = (
		provider: ProviderConfig,
		token: string,
		accept?: string,
	): Record<string, string> => {
		if (provider.type === "github")
			return {
				Authorization: `Bearer ${token}`,
				Accept: accept ?? "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			};
		return {
			"PRIVATE-TOKEN": token,
			...(accept ? { Accept: accept } : {}),
		};
	};
	const get = async (
		provider: ProviderConfig,
		path: string,
		signal: AbortSignal,
	) => {
		const token = tokenFor(provider);
		return await withTimeout(signal, async (timeoutSignal) => {
			const response = await fetchImpl(`${provider.baseUrl}${path}`, {
				headers: authHeaders(provider, token),
				redirect: "error",
				signal: timeoutSignal,
			});
			if (!response.ok) throw refusalForStatus(response.status);
			const body = await readBounded(response);
			if (body.truncated)
				throw new OperationRefusal("provider-response-too-large");
			if (!body.body) return null;
			try {
				return redactValue(JSON.parse(body.body), token);
			} catch {
				throw new OperationRefusal("provider-invalid");
			}
		});
	};
	const getText = async (
		provider: ProviderConfig,
		path: string,
		signal: AbortSignal,
		accept = "text/plain",
	) => {
		const token = tokenFor(provider);
		return await withTimeout(signal, async (timeoutSignal) => {
			const response = await fetchImpl(`${provider.baseUrl}${path}`, {
				headers: authHeaders(provider, token, accept),
				redirect: "error",
				signal: timeoutSignal,
			});
			if (!response.ok) throw refusalForStatus(response.status);
			const body = await readBounded(response, logLimit);
			return {
				output: redactString(body.body, token),
				truncated: body.truncated,
			};
		});
	};
	const send = async (
		provider: ProviderConfig,
		method: "POST" | "PUT" | "PATCH",
		path: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	) => {
		const token = tokenFor(provider);
		return await withTimeout(signal, async (timeoutSignal) => {
			const response = await fetchImpl(`${provider.baseUrl}${path}`, {
				method,
				headers: {
					...authHeaders(provider, token),
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				redirect: "error",
				signal: timeoutSignal,
			});
			if (!response.ok) throw refusalForStatus(response.status);
			const payload = await readBounded(response);
			if (payload.truncated)
				throw new OperationRefusal("provider-response-too-large");
			if (!payload.body) return null;
			try {
				return redactValue(JSON.parse(payload.body), token);
			} catch {
				throw new OperationRefusal("provider-invalid");
			}
		});
	};
	const post = (
		provider: ProviderConfig,
		path: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	) => send(provider, "POST", path, body, signal);
	const put = (
		provider: ProviderConfig,
		path: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	) => send(provider, "PUT", path, body, signal);
	const patch = (
		provider: ProviderConfig,
		path: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	) => send(provider, "PATCH", path, body, signal);
	const records = (value: unknown) => {
		if (!Array.isArray(value)) throw new OperationRefusal("provider-invalid");
		return value.map((entry) =>
			entry && typeof entry === "object"
				? (entry as Record<string, unknown>)
				: {},
		);
	};
	const single = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new OperationRefusal("provider-invalid");
		return value as Record<string, unknown>;
	};
	const graphql = async (
		provider: ProviderConfig,
		query: string,
		variables: Record<string, unknown>,
		signal: AbortSignal,
	) => {
		if (provider.type !== "github")
			throw new OperationRefusal("provider-invalid");
		const token = tokenFor(provider);
		return await withTimeout(signal, async (timeoutSignal) => {
			const response = await fetchImpl(githubGraphqlUrl(provider.baseUrl), {
				method: "POST",
				headers: {
					...authHeaders(provider, token, "application/json"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ query, variables }),
				redirect: "error",
				signal: timeoutSignal,
			});
			if (!response.ok) throw refusalForStatus(response.status);
			const body = await readBounded(response);
			if (body.truncated)
				throw new OperationRefusal("provider-response-too-large");
			let parsed: unknown;
			try {
				parsed = JSON.parse(body.body);
			} catch {
				throw new OperationRefusal("provider-invalid");
			}
			const raw = single(parsed);
			if (Array.isArray(raw.errors) && raw.errors.length)
				throw new OperationRefusal("provider-invalid");
			return single(redactValue(raw, token));
		});
	};
	const githubReviewThreads = async (
		provider: ProviderConfig,
		repository: string,
		number: number,
		signal: AbortSignal,
	) => {
		const [owner, name, extra] = repository.split("/");
		if (!owner || !name || extra)
			throw new OperationRefusal("provider-invalid");
		const data = await graphql(
			provider,
			`query ReviewThreads($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					pullRequest(number: $number) {
						reviewThreads(first: 100) {
							nodes {
								id
								isResolved
								comments(first: 100) {
									nodes { databaseId body author { login } createdAt url }
								}
							}
						}
					}
				}
			}`,
			{ owner, name, number },
			signal,
		);
		const root = single(data.data);
		const repo = single(root.repository);
		const pull = single(repo.pullRequest);
		return records(single(pull.reviewThreads).nodes);
	};

	return {
		list() {
			return configs.map(
				(provider): ProviderProjection => ({
					name: provider.name,
					type: provider.type,
					baseUrl: provider.baseUrl,
					username: provider.username,
					hasToken: Boolean(provider.tokenRef && tokens.get(provider.tokenRef)),
				}),
			);
		},
		async repositories(providerName, query, signal) {
			const provider = resolve(providerName);
			const search = query.trim();
			if (!search) throw new OperationRefusal("provider-invalid");
			const raw = await get(
				provider,
				provider.type === "github"
					? `/search/repositories?q=${encodeURIComponent(search)}&per_page=20`
					: `/api/v4/projects?search=${encodeURIComponent(search)}&per_page=20&simple=true&order_by=last_activity_at`,
				signal,
			);
			const items =
				provider.type === "github"
					? (raw as Record<string, unknown> | null)?.items
					: raw;
			return records(items)
				.map((item) => mapRepository(provider.type, item))
				.filter((item) => item.reference);
		},
		async changes(providerName, repository, state, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			const filter =
				provider.type === "github"
					? state
					: state === "open"
						? "opened"
						: state;
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/pulls?state=${filter}&per_page=50`
					: `/api/v4/projects/${reference}/merge_requests?state=${filter}&per_page=50`,
				signal,
			);
			return records(raw).map((item) => mapChange(provider.type, item));
		},
		async issues(providerName, repository, state, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			const filter =
				provider.type === "github"
					? state
					: state === "open"
						? "opened"
						: state;
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/issues?state=${filter}&per_page=50`
					: `/api/v4/projects/${reference}/issues?state=${filter}&per_page=50`,
				signal,
			);
			return records(raw)
				.filter(
					(item) =>
						provider.type !== "github" || item.pull_request === undefined,
				)
				.map((item) => mapIssue(provider.type, item));
		},
		async pipelines(providerName, repository, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/actions/runs?per_page=30`
					: `/api/v4/projects/${reference}/pipelines?per_page=30`,
				signal,
			);
			const items =
				provider.type === "github"
					? (raw as Record<string, unknown> | null)?.workflow_runs
					: raw;
			return records(items).map((item) => mapPipeline(provider.type, item));
		},
		async jobs(providerName, repository, pipeline, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(pipeline) || pipeline < 1)
				throw new OperationRefusal("provider-invalid");
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/actions/runs/${pipeline}/jobs?per_page=30`
					: `/api/v4/projects/${reference}/pipelines/${pipeline}/jobs?per_page=30`,
				signal,
			);
			const items =
				provider.type === "github"
					? (raw as Record<string, unknown> | null)?.jobs
					: raw;
			return records(items).map((item) => mapJob(provider.type, item));
		},
		async change(providerName, repository, number, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(number) || number < 1)
				throw new OperationRefusal("provider-invalid");
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/pulls/${number}`
					: `/api/v4/projects/${reference}/merge_requests/${number}`,
				signal,
			);
			return mapChangeDetail(provider.type, single(raw));
		},
		async changeFiles(providerName, repository, number, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(number) || number < 1)
				throw new OperationRefusal("provider-invalid");
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/pulls/${number}/files?per_page=100`
					: `/api/v4/projects/${reference}/merge_requests/${number}/changes`,
				signal,
			);
			return provider.type === "github"
				? githubFiles(records(raw))
				: gitlabFiles(single(raw));
		},
		async changeVersions(providerName, repository, number, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(number) || number < 1)
				throw new OperationRefusal("provider-invalid");
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/pulls/${number}/commits?per_page=100`
					: `/api/v4/projects/${reference}/merge_requests/${number}/versions?per_page=100`,
				signal,
			);
			const items = records(raw);
			return provider.type === "github"
				? githubVersions(items)
				: gitlabVersions(items);
		},
		async issue(providerName, repository, number, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(number) || number < 1)
				throw new OperationRefusal("provider-invalid");
			const raw = single(
				await get(
					provider,
					provider.type === "github"
						? `/repos/${reference}/issues/${number}`
						: `/api/v4/projects/${reference}/issues/${number}`,
					signal,
				),
			);
			if (provider.type === "github" && raw.pull_request !== undefined)
				throw new OperationRefusal("provider-invalid");
			return mapIssueDetail(provider.type, raw);
		},
		async discussions(providerName, repository, number, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(number) || number < 1)
				throw new OperationRefusal("provider-invalid");
			if (provider.type === "github")
				return githubReviewDiscussions(
					await githubReviewThreads(provider, reference, number, signal),
				);
			const raw = await get(
				provider,
				`/api/v4/projects/${reference}/merge_requests/${number}/discussions?per_page=50`,
				signal,
			);
			return gitlabDiscussions(records(raw));
		},
		async issueComments(providerName, repository, number, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(number) || number < 1)
				throw new OperationRefusal("provider-invalid");
			const raw = await get(
				provider,
				provider.type === "github"
					? `/repos/${reference}/issues/${number}/comments?per_page=50`
					: `/api/v4/projects/${reference}/issues/${number}/notes?per_page=50&sort=asc&order_by=created_at`,
				signal,
			);
			const items = records(raw);
			return provider.type === "github"
				? githubDiscussions(items)
				: gitlabNotes(items);
		},
		async jobLogs(providerName, repository, job, signal) {
			const provider = resolve(providerName);
			const reference = repositoryReference(provider, repository);
			if (!Number.isSafeInteger(job) || job < 1)
				throw new OperationRefusal("provider-invalid");
			if (provider.type === "gitlab")
				return await getText(
					provider,
					`/api/v4/projects/${reference}/jobs/${job}/trace`,
					signal,
				);
			const token = tokenFor(provider);
			return await withTimeout(signal, async (timeoutSignal) => {
				const first = await fetchImpl(
					`${provider.baseUrl}/repos/${reference}/actions/jobs/${job}/logs`,
					{
						headers: authHeaders(provider, token, "text/plain"),
						redirect: "manual",
						signal: timeoutSignal,
					},
				);
				if (first.status === 301 || first.status === 302) {
					const location = first.headers.get("location") ?? "";
					let target: URL;
					try {
						target = new URL(location);
					} catch {
						throw new OperationRefusal("provider-invalid");
					}
					if (target.protocol !== "https:" && target.protocol !== "http:")
						throw new OperationRefusal("provider-invalid");
					// Signed artifact URL: fetched without credentials.
					const signed = await fetchImpl(target.toString(), {
						headers: { Accept: "text/plain" },
						redirect: "follow",
						signal: timeoutSignal,
					});
					if (!signed.ok) throw refusalForStatus(signed.status);
					const body = await readBounded(signed, logLimit);
					return {
						output: redactString(body.body, token),
						truncated: body.truncated,
					};
				}
				if (!first.ok) throw refusalForStatus(first.status);
				const body = await readBounded(first, logLimit);
				return {
					output: redactString(body.body, token),
					truncated: body.truncated,
				};
			});
		},
		async write(intent, signal) {
			const provider = resolve(intent.provider);
			const repository = repositoryReference(provider, intent.repository);
			if (!/^[A-Za-z0-9_-]{1,128}$/.test(intent.requestId))
				throw new OperationRefusal("provider-invalid");
			const number =
				intent.action === "retry-pipeline" ||
				intent.action === "cancel-pipeline"
					? intent.pipeline
					: intent.action === "retry-job"
						? intent.job
						: intent.number;
			if (!Number.isSafeInteger(number) || number < 1)
				throw new OperationRefusal("provider-invalid");
			if ("body" in intent) {
				if (!intent.body.trim() || intent.body.length > 16_000)
					throw new OperationRefusal("provider-invalid");
			}
			if ("sha" in intent && !/^[a-f0-9]{40}$/.test(intent.sha))
				throw new OperationRefusal("provider-invalid");
			if (
				intent.action === "merge-change" &&
				!["merge", "squash", "rebase"].includes(intent.mergeMethod)
			)
				throw new OperationRefusal("provider-invalid");
			if (
				intent.action === "set-issue-state" &&
				intent.state !== "open" &&
				intent.state !== "closed"
			)
				throw new OperationRefusal("provider-invalid");
			if (
				"scope" in intent &&
				intent.scope !== "change" &&
				intent.scope !== "issue"
			)
				throw new OperationRefusal("provider-invalid");
			if (
				"discussionId" in intent &&
				!/^[A-Za-z0-9_-]{1,128}$/.test(intent.discussionId)
			)
				throw new OperationRefusal("provider-invalid");
			if ("labels" in intent) {
				if (intent.labels.length < 1 || intent.labels.length > 50)
					throw new OperationRefusal("provider-invalid");
				if (
					intent.labels.some(
						(label) =>
							typeof label !== "string" ||
							!label.trim() ||
							label.length > 100 ||
							label.includes(","),
					)
				)
					throw new OperationRefusal("provider-invalid");
			}
			if ("assignees" in intent) {
				if (intent.assignees.length < 1 || intent.assignees.length > 10)
					throw new OperationRefusal("provider-invalid");
				if (
					intent.assignees.some(
						(assignee) =>
							typeof assignee !== "string" ||
							!/^[A-Za-z0-9_.-]{1,100}$/.test(assignee),
					)
				)
					throw new OperationRefusal("provider-invalid");
			}
			if ("resolved" in intent && typeof intent.resolved !== "boolean")
				throw new OperationRefusal("provider-invalid");
			const digest = digestOf(writeCanonical(intent));
			if (intent.confirm !== digest)
				return {
					status: "confirmation-required",
					digest,
					intent: {
						provider: provider.name,
						action: intent.action,
						target: writeTarget(intent),
					},
				};
			if (!writes) throw new OperationRefusal("provider-write-unavailable");
			const claim = writes.claim({
				requestId: intent.requestId,
				provider: provider.name,
				action: intent.action,
				target: writeTarget(intent),
				digest,
			});
			if (claim.replay)
				return {
					status: "replayed",
					digest,
					receipt: claim.receipt,
				};
			try {
				let result: Record<string, unknown>;
				if (
					intent.action === "comment-change" ||
					intent.action === "comment-issue"
				) {
					const path =
						provider.type === "github"
							? `/repos/${repository}/issues/${number}/comments`
							: intent.action === "comment-change"
								? `/api/v4/projects/${repository}/merge_requests/${number}/notes`
								: `/api/v4/projects/${repository}/issues/${number}/notes`;
					result = pickResult(
						await post(provider, path, { body: intent.body.trim() }, signal),
						["id", "html_url", "web_url"],
					);
				} else if (intent.action === "merge-change") {
					const raw = single(
						await get(
							provider,
							provider.type === "github"
								? `/repos/${repository}/pulls/${number}`
								: `/api/v4/projects/${repository}/merge_requests/${number}`,
							signal,
						),
					);
					const head =
						provider.type === "github"
							? text((raw.head as Record<string, unknown> | undefined)?.sha)
							: text(
									(raw.diff_refs as Record<string, unknown> | undefined)
										?.head_sha,
								) || text(raw.sha);
					if (head !== intent.sha)
						throw new OperationRefusal("provider-head-changed");
					result = pickResult(
						provider.type === "github"
							? await put(
									provider,
									`/repos/${repository}/pulls/${number}/merge`,
									{
										merge_method: intent.mergeMethod,
										sha: intent.sha,
									},
									signal,
								)
							: await put(
									provider,
									`/api/v4/projects/${repository}/merge_requests/${number}/merge`,
									{ sha: intent.sha },
									signal,
								),
						["sha", "merged", "state", "message"],
					);
				} else if (intent.action === "set-issue-state") {
					result = pickResult(
						provider.type === "github"
							? await patch(
									provider,
									`/repos/${repository}/issues/${number}`,
									{ state: intent.state },
									signal,
								)
							: await put(
									provider,
									`/api/v4/projects/${repository}/issues/${number}`,
									{
										state_event: intent.state === "closed" ? "close" : "reopen",
									},
									signal,
								),
						["id", "state"],
					);
				} else if (intent.action === "rebase-change") {
					if (provider.type !== "gitlab")
						throw new OperationRefusal("provider-invalid");
					result = pickResult(
						await post(
							provider,
							`/api/v4/projects/${repository}/merge_requests/${number}/rebase`,
							{},
							signal,
						),
						["id", "rebase_in_progress"],
					);
				} else if (intent.action === "unapprove-change") {
					const raw = single(
						await get(
							provider,
							provider.type === "github"
								? `/repos/${repository}/pulls/${number}`
								: `/api/v4/projects/${repository}/merge_requests/${number}`,
							signal,
						),
					);
					const head =
						provider.type === "github"
							? text((raw.head as Record<string, unknown> | undefined)?.sha)
							: text(
									(raw.diff_refs as Record<string, unknown> | undefined)
										?.head_sha,
								) || text(raw.sha);
					if (head !== intent.sha)
						throw new OperationRefusal("provider-head-changed");
					if (provider.type === "github") {
						const user = single(await get(provider, "/user", signal));
						const login = text(user.login);
						const reviews = records(
							await get(
								provider,
								`/repos/${repository}/pulls/${number}/reviews?per_page=100`,
								signal,
							),
						);
						const review = [...reviews]
							.reverse()
							.find(
								(entry) =>
									text(
										(entry.user as Record<string, unknown> | undefined)?.login,
									) === login && text(entry.state) === "APPROVED",
							);
						const reviewId = String(optionalNumber(review?.id) ?? "");
						if (!reviewId) throw new OperationRefusal("provider-invalid");
						result = pickResult(
							await put(
								provider,
								`/repos/${repository}/pulls/${number}/reviews/${reviewId}/dismissals`,
								{ message: "Approval withdrawn from Environment panel." },
								signal,
							),
							["id", "state"],
						);
					} else {
						result = pickResult(
							await post(
								provider,
								`/api/v4/projects/${repository}/merge_requests/${number}/unapprove`,
								{ sha: intent.sha },
								signal,
							),
							["id", "state"],
						);
					}
				} else if (intent.action === "reply-discussion") {
					const path =
						provider.type === "github"
							? intent.scope === "issue"
								? `/repos/${repository}/issues/${number}/comments`
								: `/repos/${repository}/pulls/${number}/comments/${intent.discussionId}/replies`
							: intent.scope === "issue"
								? `/api/v4/projects/${repository}/issues/${number}/notes`
								: `/api/v4/projects/${repository}/merge_requests/${number}/discussions/${intent.discussionId}/notes`;
					result = pickResult(
						await post(provider, path, { body: intent.body.trim() }, signal),
						["id", "html_url", "web_url"],
					);
				} else if (intent.action === "set-discussion-resolved") {
					if (provider.type === "gitlab") {
						result = pickResult(
							await put(
								provider,
								`/api/v4/projects/${repository}/merge_requests/${number}/discussions/${intent.discussionId}?resolved=${intent.resolved}`,
								{},
								signal,
							),
							["id", "resolved"],
						);
					} else {
						const threads = await githubReviewThreads(
							provider,
							repository,
							number,
							signal,
						);
						const thread = threads.find((entry) =>
							records(
								(entry.comments as Record<string, unknown> | undefined)?.nodes,
							).some(
								(comment) =>
									String(comment.databaseId ?? "") === intent.discussionId,
							),
						);
						const threadId = text(thread?.id);
						if (!threadId) throw new OperationRefusal("provider-invalid");
						const current = thread?.isResolved === true;
						if (current === intent.resolved) {
							result = { id: threadId, isResolved: current };
						} else {
							const data = await graphql(
								provider,
								intent.resolved
									? `mutation ResolveThread($threadId: ID!) {
											resolveReviewThread(input: { threadId: $threadId }) {
												thread { id isResolved }
											}
										}`
									: `mutation UnresolveThread($threadId: ID!) {
											unresolveReviewThread(input: { threadId: $threadId }) {
												thread { id isResolved }
											}
										}`,
								{ threadId },
								signal,
							);
							const root = single(data.data);
							const payload = single(
								root[
									intent.resolved
										? "resolveReviewThread"
										: "unresolveReviewThread"
								],
							);
							result = pickResult(single(payload.thread), ["id", "isResolved"]);
							if (Object.keys(result).length === 0)
								result = { id: threadId, isResolved: intent.resolved };
						}
					}
				} else if (intent.action === "add-labels") {
					const labels = intent.labels.map((label) => label.trim());
					if (provider.type === "github") {
						await post(
							provider,
							`/repos/${repository}/issues/${number}/labels`,
							{ labels },
							signal,
						);
					} else {
						await put(
							provider,
							`/api/v4/projects/${repository}/${intent.scope === "change" ? "merge_requests" : "issues"}/${number}`,
							{ add_labels: labels.join(",") },
							signal,
						);
					}
					result = { labels };
				} else if (intent.action === "set-assignees") {
					if (provider.type === "github") {
						await patch(
							provider,
							`/repos/${repository}/issues/${number}`,
							{ assignees: [...intent.assignees] },
							signal,
						);
					} else {
						const ids: number[] = [];
						for (const username of intent.assignees) {
							const users = records(
								await get(
									provider,
									`/users?username=${encodeURIComponent(username)}`,
									signal,
								),
							);
							const id = optionalNumber(users[0]?.id);
							if (!id) throw new OperationRefusal("provider-invalid");
							ids.push(id);
						}
						await put(
							provider,
							`/api/v4/projects/${repository}/${intent.scope === "change" ? "merge_requests" : "issues"}/${number}`,
							{ assignee_ids: ids },
							signal,
						);
					}
					result = { assignees: [...intent.assignees] };
				} else if (intent.action === "retry-job") {
					result = pickResult(
						await post(
							provider,
							provider.type === "github"
								? `/repos/${repository}/actions/jobs/${number}/rerun`
								: `/api/v4/projects/${repository}/jobs/${number}/retry`,
							{},
							signal,
						),
						["id", "status", "state"],
					);
				} else if (intent.action === "approve-change") {
					const raw = single(
						await get(
							provider,
							provider.type === "github"
								? `/repos/${repository}/pulls/${number}`
								: `/api/v4/projects/${repository}/merge_requests/${number}`,
							signal,
						),
					);
					const head =
						provider.type === "github"
							? text((raw.head as Record<string, unknown> | undefined)?.sha)
							: text(
									(raw.diff_refs as Record<string, unknown> | undefined)
										?.head_sha,
								) || text(raw.sha);
					if (head !== intent.sha)
						throw new OperationRefusal("provider-head-changed");
					result = pickResult(
						await post(
							provider,
							provider.type === "github"
								? `/repos/${repository}/pulls/${number}/reviews`
								: `/api/v4/projects/${repository}/merge_requests/${number}/approve`,
							provider.type === "github"
								? { event: "APPROVE", commit_id: intent.sha }
								: { sha: intent.sha },
							signal,
						),
						["id", "state", "commit_id", "sha"],
					);
				} else {
					const action =
						intent.action === "retry-pipeline" ? "retry" : "cancel";
					result = pickResult(
						await post(
							provider,
							provider.type === "github"
								? `/repos/${repository}/actions/runs/${number}/${action === "retry" ? "rerun" : "cancel"}`
								: `/api/v4/projects/${repository}/pipelines/${number}/${action}`,
							{},
							signal,
						),
						["id", "status", "state"],
					);
				}
				if (Object.keys(result).length === 0) result = { status: "requested" };
				const receipt = writes.complete(claim.key, { result });
				return {
					status: "completed",
					digest,
					receipt,
				};
			} catch (error) {
				const code =
					error instanceof OperationRefusal
						? error.code
						: "provider-write-unavailable";
				try {
					writes.complete(claim.key, { error: code });
				} catch {
					/* The receipt remains attempting and is marked interrupted on restart. */
				}
				throw error instanceof OperationRefusal
					? error
					: new OperationRefusal("provider-write-unavailable");
			}
		},
		writes(provider) {
			return writes?.list(provider) ?? [];
		},
	};
}
