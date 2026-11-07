import { queryOnly, readBody } from "../http/admission.ts";
import type { ProviderApis } from "./providers.ts";

/** Provider route table. GET reads take query parameters; POST writes take
 * bodies and reject query parameters. Returns null for non-provider paths. */
export async function providerRoute(
	apis: ProviderApis,
	method: string,
	url: URL,
	body: unknown,
): Promise<{ status: number; value: unknown } | null> {
	const match = url.pathname.match(
		/^\/api\/providers(?:\/([^/]+)(?:\/(.+))?)?$/,
	);
	if (!match) return null;
	const [, name, rest] = match;
	if (name === undefined) {
		if (method === "GET" && url.searchParams.size === 0)
			return { status: 200, value: apis.list() };
		throw new Error("Unsupported provider registry request");
	}
	if (rest === undefined) {
		queryOnly(url.searchParams, []);
		throw new Error("Provider registration is configured, not requested");
	}
	const parts = rest.split("/");
	const readQuery = (allowed: readonly string[]) =>
		queryOnly(url.searchParams, allowed);
	const writeBody = () => {
		queryOnly(url.searchParams, []);
		return readBody(body);
	};
	const changeTarget = (): [unknown, unknown] => {
		readQuery(["repo", "number"]);
		return [url.searchParams.get("repo"), changeNumber(url)];
	};
	if (parts[0] === "repos" && parts[1] === "search" && parts.length === 2) {
		if (method !== "POST") throw new Error("Unsupported provider request");
		const input = writeBody();
		if (Object.keys(input).some((key) => key !== "query"))
			throw new Error("Unsupported repository search field");
		return { status: 200, value: await apis.searchRepos(name, input.query) };
	}
	if (parts[0] === "repos" && parts.length === 2 && method === "GET") {
		readQuery(["repo"]);
		const repo = url.searchParams.get("repo");
		if (parts[1] === "labels")
			return { status: 200, value: await apis.repoLabels(name, repo) };
		if (parts[1] === "collaborators")
			return { status: 200, value: await apis.repoCollaborators(name, repo) };
	}
	if (parts[0] === "repos" && parts[1] === "branches" && parts.length === 3) {
		if (method !== "GET") throw new Error("Unsupported provider request");
		readQuery([]);
		return {
			status: 200,
			value: await apis.repoBranches(name, decodeURIComponent(parts[2])),
		};
	}
	if (parts[0] === "changes" && parts.length === 1 && method === "GET") {
		readQuery(["repo", "state"]);
		return {
			status: 200,
			value: await apis.changes(
				name,
				url.searchParams.get("repo"),
				url.searchParams.get("state") ?? undefined,
			),
		};
	}
	if (
		parts[0] === "changes" &&
		parts[1] === "files" &&
		parts.length === 2 &&
		method === "GET"
	) {
		const [repo, number] = changeTarget();
		return {
			status: 200,
			value: await apis.changeFiles(name, repo, number),
		};
	}
	if (
		parts[0] === "changes" &&
		parts[1] === "versions" &&
		parts.length === 2 &&
		method === "GET"
	) {
		const [repo, number] = changeTarget();
		return {
			status: 200,
			value: await apis.changeVersions(name, repo, number),
		};
	}
	if (parts[0] === "changes" && parts.length === 2 && method === "GET") {
		readQuery(["repo", "number"]);
		return {
			status: 200,
			value: await apis.change(
				name,
				url.searchParams.get("repo"),
				changeNumber(url),
			),
		};
	}
	if (
		parts[0] === "changes" &&
		parts[1] === "discussions" &&
		parts.length === 2 &&
		method === "GET"
	) {
		const [repo, number] = changeTarget();
		return {
			status: 200,
			value: await apis.discussions(name, repo, number),
		};
	}
	if (
		parts[0] === "changes" &&
		parts[1] === "discussions" &&
		parts[2] === "reply" &&
		parts.length === 3 &&
		method === "POST"
	)
		return {
			status: 200,
			value: await apis.replyDiscussion(name, writeBody()),
		};
	if (
		parts[0] === "changes" &&
		parts[1] === "discussions" &&
		parts[2] === "resolve" &&
		parts.length === 3 &&
		method === "POST"
	)
		return {
			status: 200,
			value: await apis.resolveDiscussion(name, writeBody()),
		};
	if (
		parts[0] === "changes" &&
		parts[1] === "comment" &&
		parts.length === 2 &&
		method === "POST"
	)
		return {
			status: 200,
			value: await apis.commentOnChange(name, writeBody()),
		};
	if (
		parts[0] === "changes" &&
		parts[1] === "approve" &&
		parts.length === 2 &&
		method === "POST"
	)
		return { status: 200, value: await apis.approveChange(name, writeBody()) };
	if (
		parts[0] === "changes" &&
		parts[1] === "unapprove" &&
		parts.length === 2 &&
		method === "POST"
	)
		return {
			status: 200,
			value: await apis.unapproveChange(name, writeBody()),
		};
	if (
		parts[0] === "changes" &&
		parts[1] === "rebase" &&
		parts.length === 2 &&
		method === "POST"
	)
		return { status: 200, value: await apis.rebaseChange(name, writeBody()) };
	if (parts[0] === "issues" && parts.length === 1 && method === "GET") {
		readQuery(["repo", "state"]);
		return {
			status: 200,
			value: await apis.issues(
				name,
				url.searchParams.get("repo"),
				url.searchParams.get("state") ?? undefined,
			),
		};
	}
	if (
		parts[0] === "issues" &&
		parts[1] === "comment" &&
		parts.length === 2 &&
		method === "POST"
	)
		return {
			status: 200,
			value: await apis.commentOnIssue(name, writeBody()),
		};
	if (
		parts[0] === "issues" &&
		parts[1] === "close" &&
		parts.length === 2 &&
		method === "POST"
	)
		return { status: 200, value: await apis.closeIssue(name, writeBody()) };
	if (
		parts[0] === "issues" &&
		parts[1] === "labels" &&
		parts.length === 2 &&
		method === "POST"
	)
		return {
			status: 200,
			value: await apis.setIssueLabels(name, writeBody()),
		};
	if (
		parts[0] === "issues" &&
		parts[1] === "assignees" &&
		parts.length === 2 &&
		method === "POST"
	)
		return {
			status: 200,
			value: await apis.setIssueAssignees(name, writeBody()),
		};
	if (
		parts[0] === "pipelines" &&
		parts[1] === "jobs" &&
		parts.length === 2 &&
		method === "GET"
	) {
		readQuery(["repo", "run"]);
		return {
			status: 200,
			value: await apis.jobs(
				name,
				url.searchParams.get("repo"),
				url.searchParams.get("run") ?? undefined,
			),
		};
	}
	if (
		parts[0] === "pipelines" &&
		parts[1] === "jobs" &&
		parts[2] === "logs" &&
		parts.length === 3 &&
		method === "GET"
	) {
		readQuery(["repo", "job"]);
		const job = url.searchParams.get("job");
		if (job === null || !/^\d+$/.test(job)) throw new Error("Invalid job ID");
		return {
			status: 200,
			value: await apis.jobLogs(
				name,
				url.searchParams.get("repo"),
				Number(job),
			),
		};
	}
	if (
		parts[0] === "pipelines" &&
		parts[1] === "retry" &&
		parts.length === 2 &&
		method === "POST"
	)
		return { status: 200, value: await apis.retryJob(name, writeBody()) };
	if (
		parts[0] === "pipelines" &&
		parts[1] === "cancel" &&
		parts.length === 2 &&
		method === "POST"
	)
		return { status: 200, value: await apis.cancelJob(name, writeBody()) };
	throw new Error("Unknown provider route");
}
function changeNumber(url: URL): number {
	const raw = url.searchParams.get("number");
	if (raw === null || !/^\d+$/.test(raw))
		throw new Error("Invalid change number");
	return Number(raw);
}
