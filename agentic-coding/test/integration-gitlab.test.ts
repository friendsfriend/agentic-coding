// Cross-runtime parity for the ported GitLab provider surface
// (`port-git-providers-and-ai-to-bun`, tasks 1.2, 3.5-3.8).
//
// Every case replays the Go-created fixture: the same canned provider
// responses through an injected fetch, asserting both the requests the Bun
// client issues and the value it produces. Regenerate the fixtures with the Go
// generators documented in `docs/integration-port.md`.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	type GitLabChangeRequestOptions,
	GitLabChangeRequests,
} from "../src/server/integrations/gitlab-changerequest.ts";
import { GitLabCi } from "../src/server/integrations/gitlab-ci.ts";
import { GitLabClient } from "../src/server/integrations/gitlab-client.ts";
import { GitLabIssues } from "../src/server/integrations/gitlab-issues.ts";
import type { IssueListOptions } from "../src/server/integrations/issues.ts";

const FIXTURES = path.join(
	import.meta.dir,
	"fixtures",
	"integrations",
	"gitlab",
);
const PROJECT = {
	host: "gitlab.example.com",
	namespace: "acme",
	project: "devenv",
};

interface FixtureResponse {
	match: string;
	status: number;
	body: string;
	headers?: Record<string, string>;
}

interface FixtureRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

interface FixtureCall {
	op: string;
	number?: number;
	body?: string;
	discussionId?: string;
	resolved?: boolean;
	username?: string;
	sourceBranch?: string;
	targetBranch?: string;
	state?: string;
	scope?: string;
	search?: string;
	labels?: string[];
	sortBy?: string;
	order?: string;
	page?: number;
	perPage?: number;
	skipDetails?: boolean;
	positioned?: boolean;
}

interface Fixture {
	case: string;
	note: string;
	responses: FixtureResponse[];
	call: FixtureCall;
	requests: FixtureRequest[] | null;
	error?: boolean;
	message?: string;
	value?: string;
}

function scriptedFetch(responses: readonly FixtureResponse[]): {
	fetchFn: typeof fetch;
	requests: FixtureRequest[];
} {
	const used = responses.map(() => false);
	const requests: FixtureRequest[] = [];
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const headers = new Headers(init?.headers);
		requests.push({
			method: init?.method ?? "GET",
			url,
			headers: {
				accept: headers.get("accept") ?? "",
				"content-type": headers.get("content-type") ?? "",
				"private-token": headers.get("private-token") ?? "",
			},
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		});
		let index = -1;
		for (let i = 0; i < responses.length; i++) {
			if (url.includes(responses[i].match) && !used[i]) {
				index = i;
				break;
			}
		}
		if (index < 0) {
			for (let i = 0; i < responses.length; i++)
				if (url.includes(responses[i].match)) index = i;
		}
		if (index < 0)
			return new Response('{"message":"no fixture response"}', { status: 404 });
		used[index] = true;
		return new Response(responses[index].body, {
			status: responses[index].status,
			headers: responses[index].headers ?? {},
		});
	}) as typeof fetch;
	return { fetchFn, requests };
}

function fixtureCases(kind: "issues" | "changerequest"): string[] {
	return fs
		.readdirSync(path.join(FIXTURES, kind))
		.filter((name) =>
			fs.existsSync(path.join(FIXTURES, kind, name, "fixture.json")),
		)
		.sort();
}

function fixture(kind: "issues" | "changerequest", name: string): Fixture {
	return JSON.parse(
		fs.readFileSync(path.join(FIXTURES, kind, name, "fixture.json"), "utf8"),
	) as Fixture;
}

async function runCase(
	kind: "issues" | "changerequest",
	name: string,
): Promise<{
	value?: string;
	failure?: string;
	requests: FixtureRequest[];
}> {
	const loaded = fixture(kind, name);
	const { fetchFn, requests } = scriptedFetch(loaded.responses);
	const client = new GitLabClient({
		baseUrl: "https://gitlab.example.com",
		token: "fixture-token",
		username: "octo",
		fetch: fetchFn,
	});
	const issues = new GitLabIssues(client, PROJECT);
	const changeRequests = new GitLabChangeRequests(client, PROJECT);
	const ci = new GitLabCi(client, PROJECT);
	const call = loaded.call;
	const number = call.number ?? 0;
	let value: unknown;
	try {
		switch (call.op) {
			case "getIssues":
				value = await issues.getIssues(undefined, toIssueOptions(call));
				break;
			case "getIssue":
				value = await issues.getIssue(undefined, number);
				break;
			case "getIssueComments":
				value = await issues.getIssueComments(undefined, number);
				break;
			case "closeIssue":
				value = await issues.closeIssue(undefined, number, call.body ?? "");
				break;
			case "reopenIssue":
				value = await issues.reopenIssue(undefined, number);
				break;
			case "setLabels":
				value = await issues.setLabels(undefined, number, call.labels ?? []);
				break;
			case "addAssignee":
				value = await issues.addAssignee(undefined, number, call.body ?? "");
				break;
			case "removeAssignee":
				value = await issues.removeAssignee(undefined, number);
				break;
			case "addComment":
				value = await issues.addComment(undefined, number, call.body ?? "");
				break;
			case "getRepoLabels":
				value = await issues.getRepoLabels(undefined);
				break;
			case "getRepoCollaborators":
				value = await issues.getRepoCollaborators(undefined);
				break;
			case "getIssueLinkedChangeRequests":
				value = await issues.getIssueLinkedChangeRequests(undefined, number);
				break;
			case "getIssueReferencedIssues":
				value = await issues.getIssueReferencedIssues(undefined, number);
				break;
			case "getChangeRequestLinkedIssues":
				value = await issues.getChangeRequestLinkedIssues(
					{ owner: PROJECT.namespace, repo: PROJECT.project },
					number,
				);
				break;
			case "getChangeRequestsWithOptions":
				value = await changeRequests.getChangeRequestsWithOptions(
					toChangeRequestOptions(call),
				);
				break;
			case "getChangeRequest":
				value = await changeRequests.getChangeRequest(number);
				break;
			case "getChangeRequestChanges":
				value = await changeRequests.getChangeRequestChanges(number);
				break;
			case "getMrVersions":
				value = await changeRequests.getMrVersions(number);
				break;
			case "getMrDiscussions":
				value = await changeRequests.getMrDiscussions(number);
				break;
			case "createMrDiffComment":
				await changeRequests.createMrDiffComment(
					number,
					call.body ?? "",
					call.positioned
						? {
								baseSha: "def4567890abcdef7890abcdef7890abcdef7890",
								headSha: "abc1234567890abcdef7890abcdef7890abcdef",
								startSha: "def4567890abcdef7890abcdef7890abcdef7890",
								positionType: "text",
								newPath: "src/login.ts",
								oldPath: "src/login.ts",
								newLine: 12,
							}
						: undefined,
				);
				value = null;
				break;
			case "replyToDiscussion":
				await changeRequests.replyToDiscussion(
					number,
					call.discussionId ?? "",
					call.body ?? "",
				);
				value = null;
				break;
			case "resolveDiscussion":
				await changeRequests.resolveDiscussion(
					number,
					call.discussionId ?? "",
					call.resolved === true,
				);
				value = null;
				break;
			case "approve":
				await changeRequests.approveChangeRequest(number);
				value = null;
				break;
			case "unapprove":
				await changeRequests.unapproveChangeRequest(number);
				value = null;
				break;
			case "toggleMrApproval":
				await changeRequests.toggleMrApproval(number, call.username ?? "");
				value = null;
				break;
			case "rebase":
				await changeRequests.rebaseChangeRequest(number);
				value = null;
				break;
			case "close":
				await changeRequests.closeChangeRequest(number);
				value = null;
				break;
			case "getPipelines":
				value = await ci.getPipelines(number);
				break;
			case "getPipelineJobs":
				value = await ci.getPipelineJobs(number);
				break;
			case "getJobLogs":
				value = await ci.getJobLogs(number);
				break;
			case "getTestSummary":
				value = await ci.getTestSummary(number);
				break;
			case "restartJob":
				await ci.restartJob(number);
				value = null;
				break;
			case "cancelJob":
				await ci.cancelJob(number);
				value = null;
				break;
			default:
				throw new Error(`unknown fixture operation ${call.op}`);
		}
	} catch (error) {
		return {
			failure: error instanceof Error ? error.message : String(error),
			requests,
		};
	}
	return { value: JSON.stringify(value), requests };
}

function toIssueOptions(call: FixtureCall): IssueListOptions {
	return {
		scope: call.scope,
		state: call.state,
		search: call.search,
		labels: call.labels,
		sortBy: call.sortBy,
		sortDirection: call.order,
		page: call.page,
		perPage: call.perPage,
	};
}

function toChangeRequestOptions(call: FixtureCall): GitLabChangeRequestOptions {
	return {
		state: call.state,
		page: call.page,
		perPage: call.perPage,
		sourceBranch: call.sourceBranch,
		targetBranch: call.targetBranch,
		search: call.search,
		labels: call.labels,
		sortBy: call.sortBy,
		sortDirection: call.order,
		skipDetails: call.skipDetails,
	};
}

for (const kind of ["issues", "changerequest"] as const) {
	describe(`gitlab ${kind} parity (cross-runtime fixtures)`, () => {
		for (const name of fixtureCases(kind)) {
			test(`reproduces the Go flow: ${name}`, async () => {
				const expected = fixture(kind, name);
				const result = await runCase(kind, name);
				const expectedRequests = expected.requests ?? [];
				expect(result.requests.length).toBe(expectedRequests.length);
				for (let i = 0; i < expectedRequests.length; i++) {
					const want = expectedRequests[i];
					const got = result.requests[i];
					expect(`${i} ${got.method} ${got.url}`).toBe(
						`${i} ${want.method} ${want.url}`,
					);
					expect(got.body ?? "").toBe(want.body ?? "");
					if (want.headers["private-token"] !== "")
						expect(got.headers["private-token"]).toBe(
							want.headers["private-token"],
						);
					if (want.headers["content-type"] !== "")
						expect(got.headers["content-type"]).toBe(
							want.headers["content-type"],
						);
					if (want.headers.accept !== "")
						expect(got.headers.accept).toBe(want.headers.accept);
				}
				if (expected.error) {
					expect(result.failure).toBeDefined();
					expect(result.failure).toBe(expected.message);
					return;
				}
				expect(result.failure).toBeUndefined();
				expect(JSON.parse(result.value ?? "null")).toEqual(
					JSON.parse(expected.value ?? "null"),
				);
			});
		}
	});
}
