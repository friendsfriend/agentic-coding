import { type Config, text } from "../../config.ts";
import type { Environments } from "../../environment/manager.ts";
import type { RepositoryGit } from "../../environment/repository-git.ts";
import { git } from "../../git.ts";
import { boundedFetch, maskSecrets } from "../../http/admission.ts";
import { Refusal } from "../../server/refusal.ts";
import {
	type ProviderConfig,
	type ProviderType,
	providerToken,
} from "../config.ts";
import { GitHubChangeRequests } from "./github-changerequest.ts";
import { extractRepoInfo, GitHubClient } from "./github-client.ts";
import { GitHubIssues } from "./github-issues.ts";
import { GitLabChangeRequests } from "./gitlab-changerequest.ts";
import { GitLabCi } from "./gitlab-ci.ts";
import { extractProjectInfo, GitLabClient } from "./gitlab-client.ts";
import { GitLabIssues } from "./gitlab-issues.ts";

/** v1 feature-branch rule: a CR list for "current" needs a feature branch. */
const defaultBranches = new Set(["develop", "master", "main", "qa", "quality"]);
const maxResponseBytes = 900_000;

export const workbenchReads = [
	"identity",
	"changes",
	"change",
	"change-files",
	"change-versions",
	"discussions",
	"change-issues",
	"issues",
	"issue",
	"issue-comments",
	"issue-changes",
	"issue-references",
	"labels",
	"collaborators",
	"jobs",
	"tests",
	"job-logs",
] as const;
export const workbenchWrites = [
	"comment-change",
	"approve-change",
	"unapprove-change",
	"toggle-approval",
	"rebase-change",
	"reply-discussion",
	"resolve-discussion",
	"close-issue",
	"reopen-issue",
	"set-issue-labels",
	"assign-issue",
	"unassign-issue",
	"comment-issue",
	"retry-job",
	"cancel-job",
] as const;
export type WorkbenchOperation =
	| (typeof workbenchReads)[number]
	| (typeof workbenchWrites)[number];

type Resolved = {
	provider: ProviderConfig;
	token: string;
	type: ProviderType;
	gitlab?: {
		changes: GitLabChangeRequests;
		issues: GitLabIssues;
		ci: GitLabCi;
		username: string;
		project: { owner: string; repo: string };
	};
	github?: {
		changes: GitHubChangeRequests;
		issues: GitHubIssues;
		repo: { owner: string; repo: string };
	};
	branch: string;
	mainBranch: string;
};

const origin = (url: string) => {
	const value = url.trim();
	if (value.startsWith("git@")) return value.slice(4).split(":")[0] ?? "";
	if (value.startsWith("ssh://")) {
		try {
			return new URL(value).hostname;
		} catch {
			return "";
		}
	}
	try {
		return new URL(value).hostname;
	} catch {
		return "";
	}
};
/** The provider whose API host serves the remote's host. GitHub's API host
 * is api.github.com for github.com remotes; GitLab hosts may prefix ssh. */
function providerFor(providers: readonly ProviderConfig[], remoteHost: string) {
	const host = remoteHost.toLowerCase();
	return providers.find((provider) => {
		const api = new URL(provider.baseUrl).hostname.toLowerCase();
		if (provider.type === "github")
			return (
				(api === "api.github.com" && host === "github.com") ||
				api === host ||
				// A loopback GitHub-compatible API host serves loopback remotes.
				(api === "127.0.0.1" && host === "127.0.0.1")
			);
		return api === host || `ssh.${api}` === host;
	});
}

/** Normalize the remote so v1's URL parsers accept it (ssh://, ports). */
function parserUrl(url: string, provider: ProviderConfig) {
	const value = url.trim();
	if (value.startsWith("ssh://")) {
		const parsed = new URL(value);
		return `https://${parsed.hostname}${parsed.pathname}`;
	}
	if (provider.type === "github" && !value.includes("github.com")) {
		// A non-github.com host (enterprise or loopback): reuse the path.
		try {
			const parsed = new URL(value);
			return `https://github.com${parsed.pathname}`;
		} catch {
			const path = value.split(":").slice(1).join(":");
			return `https://github.com/${path}`;
		}
	}
	return value;
}

/** The restored v1 provider workbench (change requests, issues, CI) over the
 * configured providers: each application maps to the provider serving its
 * `origin` remote. Tokens stay env references resolved per call; every string
 * is masked before it leaves; responses are bounded. Writes are the developer's
 * own direct TUI actions (the key press/confirm is the approval); agents and
 * HTTP keep the exact-digest `providers.preview/apply` path. */
export class ProviderWorkbench {
	constructor(
		private config: Config,
		private environments: Environments,
		private repositoryGit: RepositoryGit,
		private fetchImpl: typeof fetch = fetch,
	) {}
	/** Wraps fetch so v1's classes get bounded bodies, an HTTPS-only target
	 * set (loopback excepted) and no redirects with credentials. */
	private fetcher(provider: ProviderConfig): typeof fetch {
		const allowed = new URL(provider.baseUrl).origin;
		const fetchImpl = this.fetchImpl;
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input instanceof Request ? input.url : input));
			if (url.origin !== allowed)
				throw new Refusal("Provider request left its configured origin");
			const { status, headers, body } = await boundedFetch(
				fetchImpl,
				url.toString(),
				{
					...init,
					redirect: "manual",
					maxBytes: 4_000_000,
					onTooLarge: "truncate",
				},
			);
			return new Response(status === 204 || status === 304 ? null : body, {
				status,
				headers,
			});
		}) as typeof fetch;
	}
	private async resolve(app: unknown): Promise<Resolved> {
		const id = text(app, "app", 64);
		const project = this.environments.projects.find((item) => item.id === id);
		if (!project || project.kind === "infrastructure")
			throw new Refusal("Choose a configured application or library");
		const dir = await this.repositoryGit.checkout(id);
		const remote = (
			await git(dir, ["remote", "get-url", "origin"]).catch(() => "")
		).trim();
		if (!remote) throw new Refusal("Repository has no origin remote");
		const provider = providerFor(this.config.providers, origin(remote));
		if (!provider)
			throw new Refusal(
				`No configured provider serves ${origin(remote) || "this remote"}`,
			);
		const token = providerToken(provider);
		if (!token)
			throw new Refusal(`no token configured for provider "${provider.name}"`);
		const branch = (await git(dir, ["branch", "--show-current"])).trim();
		const mainBranch = (
			await git(project.repository, ["branch", "--show-current"]).catch(
				() => "",
			)
		).trim();
		const fetchFn = this.fetcher(provider);
		const url = parserUrl(remote, provider);
		if (provider.type === "github") {
			const repo = extractRepoInfo(url);
			const client = new GitHubClient({
				token,
				username: provider.username,
				baseUrl: provider.baseUrl,
				fetch: fetchFn,
			});
			const changes = new GitHubChangeRequests(client);
			return {
				provider,
				token,
				type: "github",
				github: {
					changes,
					issues: new GitHubIssues(client, repo, changes),
					repo,
				},
				branch,
				mainBranch,
			};
		}
		const info = extractProjectInfo(url);
		const client = new GitLabClient({
			baseUrl: `${provider.baseUrl}`,
			token,
			username: provider.username,
			fetch: fetchFn,
		});
		const project2 = { ...info, host: new URL(provider.baseUrl).host };
		return {
			provider,
			token,
			type: "gitlab",
			gitlab: {
				changes: new GitLabChangeRequests(client, project2),
				issues: new GitLabIssues(client, project2),
				ci: new GitLabCi(client, project2),
				username: provider.username,
				project: { owner: info.namespace, repo: info.project },
			},
			branch,
			mainBranch,
		};
	}
	/** Per-app provider identity for the table (no network). */
	async identity(app: unknown) {
		try {
			const id = text(app, "app", 64);
			const dir = await this.repositoryGit.checkout(id);
			const remote = (
				await git(dir, ["remote", "get-url", "origin"]).catch(() => "")
			).trim();
			const provider = providerFor(this.config.providers, origin(remote));
			return provider
				? { provider: provider.name, sourceType: provider.type }
				: {};
		} catch {
			return {};
		}
	}
	async identities() {
		const result: Record<string, { provider?: string; sourceType?: string }> =
			{};
		for (const project of this.environments.projects)
			if (project.kind !== "infrastructure")
				result[project.id] = await this.identity(project.id);
		return result;
	}
	async run(operation: WorkbenchOperation, input: Record<string, unknown>) {
		if (operation === "identity") return this.identities();
		const resolved = await this.resolve(input.app);
		let value: unknown;
		try {
			value = await this.dispatch(resolved, operation, input);
		} catch (error) {
			if (error instanceof Refusal) throw error;
			// v1 surfaced the provider's own diagnostic; v2 masks the token first.
			throw new Refusal(
				maskSecrets(String(error instanceof Error ? error.message : error), [
					resolved.token,
				]).slice(0, 600),
			);
		}
		const serialized = JSON.stringify(value ?? null, (_key, item: unknown) =>
			typeof item === "string" ? maskSecrets(item, [resolved.token]) : item,
		);
		if (Buffer.byteLength(serialized) > maxResponseBytes)
			throw new Refusal(
				"Provider response exceeds the gateway frame budget; open it in the provider",
			);
		return JSON.parse(serialized) as unknown;
	}
	private number(value: unknown, name: string) {
		if (!Number.isSafeInteger(value) || Number(value) < 1)
			throw new Refusal(`Invalid ${name}`);
		return Number(value);
	}
	private async dispatch(
		r: Resolved,
		operation: WorkbenchOperation,
		input: Record<string, unknown>,
	): Promise<unknown> {
		const n = () => this.number(input.number, "number");
		const s = (key: string, max = 256) =>
			typeof input[key] === "string" ? String(input[key]).slice(0, max) : "";
		const list = () => ({
			page:
				Number.isSafeInteger(input.page) && Number(input.page) > 0
					? Number(input.page)
					: 1,
			perPage:
				Number.isSafeInteger(input.perPage) && Number(input.perPage) > 0
					? Math.min(Number(input.perPage), 100)
					: 50,
			search: s("search"),
			sortBy: s("sort", 32),
			sortDirection: s("direction", 8),
			labels: Array.isArray(input.labels)
				? input.labels
						.filter((label): label is string => typeof label === "string")
						.slice(0, 32)
				: undefined,
		});
		const empty = (perPage: number) => ({
			items: [],
			totalCount: -1,
			totalPages: -1,
			currentPage: 1,
			perPage,
		});
		const gh = r.github,
			gl = r.gitlab;
		switch (operation) {
			case "changes": {
				const options = list(),
					all = input.scope === "all",
					paging = input.page !== undefined;
				if (!all && defaultBranches.has(r.branch))
					return empty(options.perPage);
				const result = gh
					? await gh.changes.getChangeRequests(gh.repo, {
							...options,
							state: s("state", 16) || "opened",
							skipDetails: paging,
							sourceBranch: all ? undefined : r.branch,
						})
					: await gl?.changes.getChangeRequestsWithOptions({
							...options,
							state: s("state", 16) || "opened",
							skipDetails: paging,
							sourceBranch: all ? undefined : r.branch,
							targetBranch: "develop",
						});
				for (const item of result?.items ?? [])
					if (!item.default_branch) item.default_branch = r.mainBranch;
				return result?.items.length ? result : empty(options.perPage);
			}
			case "change": {
				if (!gh)
					throw new Refusal(
						"Full change request detail fetch is currently only implemented for GitHub",
					);
				const pr = await gh.changes.getPullRequest(gh.repo, n());
				if (!pr.default_branch) pr.default_branch = r.mainBranch;
				return pr;
			}
			case "change-files":
				return gh
					? gh.changes.getChangeRequestChanges(gh.repo, n())
					: gl?.changes.getChangeRequestChanges(n());
			case "change-versions":
				if (!gl) throw new Refusal("Change request versions require GitLab");
				return gl.changes.getMrVersions(n());
			case "discussions":
				return gh
					? gh.changes.getDiscussions(gh.repo, n())
					: gl?.changes.getMrDiscussions(n());
			case "change-issues":
				return gh
					? gh.issues.getChangeRequestLinkedIssues(gh.repo, n())
					: gl?.issues.getChangeRequestLinkedIssues(gl.project, n());
			case "issues": {
				const options = list();
				return (gh ?? gl)?.issues.getIssues(undefined, {
					...options,
					scope: s("scope", 32),
					state: s("state", 16) || (gh ? "open" : "opened"),
				});
			}
			case "issue":
				return (gh ?? gl)?.issues.getIssue(undefined, n());
			case "issue-comments":
				return (gh ?? gl)?.issues.getIssueComments(undefined, n());
			case "issue-changes":
				return (gh ?? gl)?.issues.getIssueLinkedChangeRequests(undefined, n());
			case "issue-references":
				return (gh ?? gl)?.issues.getIssueReferencedIssues(undefined, n());
			case "labels":
				return (gh ?? gl)?.issues.getRepoLabels(undefined);
			case "collaborators":
				return (gh ?? gl)?.issues.getRepoCollaborators(undefined);
			case "jobs":
				return gh
					? gh.changes.getPipelineJobs(gh.repo, n())
					: gl?.ci.getPipelineJobs(n());
			case "tests":
				if (gh) return githubTests(gh, n());
				return gl?.ci.getTestSummary(n());
			case "job-logs": {
				const log = gh
					? await gh.changes.getJobLogs(gh.repo, n())
					: ((await gl?.ci.getJobLogs(n())) ?? "");
				// The newest output matters for a running job; keep the tail.
				return log.length > 512_000 ? log.slice(-512_000) : log;
			}
			case "comment-change": {
				const body = text(input.body, "comment body", 16000);
				const position = input.position as Record<string, unknown> | undefined;
				if (gl) {
					await gl.changes.createMrDiffComment(
						n(),
						body,
						position
							? {
									baseSha: String(position.baseSHA ?? ""),
									headSha: String(position.headSHA ?? ""),
									startSha: String(position.startSHA ?? ""),
									positionType: String(position.positionType ?? "text"),
									newPath: String(position.newPath ?? ""),
									oldPath: String(position.oldPath ?? ""),
									...(typeof position.newLine === "number"
										? { newLine: position.newLine }
										: {}),
									...(typeof position.oldLine === "number"
										? { oldLine: position.oldLine }
										: {}),
								}
							: undefined,
					);
				} else if (gh)
					await gh.changes.createDiffComment(
						gh.repo,
						n(),
						body,
						position
							? {
									headSha: String(position.headSHA ?? ""),
									newPath: String(position.newPath ?? ""),
									...(typeof position.newLine === "number"
										? { newLine: position.newLine }
										: {}),
									...(typeof position.oldLine === "number"
										? { oldLine: position.oldLine }
										: {}),
								}
							: undefined,
					);
				return { status: "success", message: "Comment created successfully" };
			}
			case "approve-change":
				if (gh) await gh.changes.approve(gh.repo, n());
				else await gl?.changes.approveChangeRequest(n());
				return { status: "success" };
			case "unapprove-change":
				if (gh) await gh.changes.unapprove(gh.repo, n());
				else await gl?.changes.unapproveChangeRequest(n());
				return { status: "success" };
			case "toggle-approval":
				if (gh) await gh.changes.toggleApproval(gh.repo, n());
				else {
					if (!gl?.username)
						throw new Refusal("GitLab username not configured");
					await gl.changes.toggleMrApproval(n(), gl.username);
				}
				return { status: "success" };
			case "rebase-change":
				if (!gl)
					throw new Refusal("server-side rebase is not supported on GitHub");
				await gl.changes.rebaseChangeRequest(n());
				return { status: "success" };
			case "reply-discussion": {
				const thread = text(input.thread, "discussion identity", 128),
					body = text(input.body, "reply body", 16000);
				if (gh) await gh.changes.replyToDiscussion(gh.repo, n(), thread, body);
				else await gl?.changes.replyToDiscussion(n(), thread, body);
				return { status: "success", message: "Reply added successfully" };
			}
			case "resolve-discussion":
				if (!gl)
					throw new Refusal("resolving discussions is not supported on GitHub");
				await gl.changes.resolveDiscussion(
					n(),
					text(input.thread, "discussion identity", 128),
					input.resolved === true,
				);
				return {
					status: "success",
					message: "Discussion resolved successfully",
				};
			case "close-issue":
				return (gh ?? gl)?.issues.closeIssue(undefined, n(), s("reason", 32));
			case "reopen-issue":
				return (gh ?? gl)?.issues.reopenIssue(undefined, n());
			case "set-issue-labels": {
				if (!Array.isArray(input.labels) || input.labels.length > 64)
					throw new Refusal("Invalid issue labels");
				return (gh ?? gl)?.issues.setLabels(
					undefined,
					n(),
					input.labels.map((label) => text(label, "label", 128)),
				);
			}
			case "assign-issue":
				return (gh ?? gl)?.issues.addAssignee(
					undefined,
					n(),
					text(input.assignee, "assignee", 128),
				);
			case "unassign-issue":
				return (gh ?? gl)?.issues.removeAssignee(undefined, n());
			case "comment-issue":
				return (gh ?? gl)?.issues.addComment(
					undefined,
					n(),
					text(input.body, "comment body", 16000),
				);
			case "retry-job":
				if (gh) await gh.changes.restartJob(gh.repo, n());
				else await gl?.ci.restartJob(n());
				return { success: true, jobId: n(), action: "retry" };
			case "cancel-job":
				if (gh) await gh.changes.cancelJob(gh.repo, n());
				else await gl?.ci.cancelJob(n());
				return { success: true, jobId: n(), action: "cancel" };
			default:
				throw new Refusal("Unsupported provider workbench operation");
		}
	}
}

const testPatterns = {
	passed: [/(\d+)\s*passed/, /passed[:\s]+(\d+)/],
	failed: [/(\d+)\s*failed/, /failed[:\s]+(\d+)/],
	skipped: [/(\d+)\s*skipped/, /skipped[:\s]+(\d+)/],
};
const count = (value: string, pattern: RegExp) => {
	const match = pattern.exec(value);
	const parsed = Number(match?.[1] ?? 0);
	return Number.isInteger(parsed) ? parsed : 0;
};
/** v1 `actionTestSummary`: counts from the head commit's check-run summaries. */
async function githubTests(gh: NonNullable<Resolved["github"]>, run: number) {
	const empty = {
		total: 0,
		success: 0,
		failed: 0,
		skipped: 0,
		error: 0,
		test_suites: [] as { name: string; test_cases: [] }[],
	};
	let headSha = "";
	try {
		headSha =
			(await gh.changes.getWorkflowRunByID(gh.repo, run)).head_sha ?? "";
	} catch {
		return empty;
	}
	if (!headSha) return empty;
	let checks: { name: string; status: string; output: { summary: string } }[];
	try {
		checks = await gh.changes.getCheckRunsForRef(gh.repo, headSha);
	} catch {
		return empty;
	}
	const suites = new Map<string, { name: string; test_cases: [] }>();
	for (const check of checks) {
		if (check.status !== "completed" || !check.output?.summary) continue;
		const lower = check.output.summary.toLowerCase();
		let [t, f, sk] = (["passed", "failed", "skipped"] as const).map((key) =>
			count(lower, testPatterns[key][0] as RegExp),
		) as [number, number, number];
		if (!t) t = count(lower, testPatterns.passed[1] as RegExp);
		if (!f) f = count(lower, testPatterns.failed[1] as RegExp);
		if (!sk) sk = count(lower, testPatterns.skipped[1] as RegExp);
		if (!t && !f && !sk) t = count(lower, /(\d+)\s*tests?/);
		empty.total += t + f + sk;
		empty.success += t;
		empty.failed += f;
		empty.skipped += sk;
		if ((t || f || sk) && !suites.has(check.name))
			suites.set(check.name, { name: check.name, test_cases: [] });
	}
	empty.test_suites = [...suites.values()];
	return empty;
}
