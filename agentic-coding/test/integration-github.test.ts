// Cross-runtime parity for the ported GitHub provider surface
// (`port-git-providers-and-ai-to-bun`, tasks 1.2, 3.1, 3.3, 3.4).
//
// Every case replays the Go-created fixture: the same canned provider
// responses through an injected fetch, asserting both the requests the Bun
// client issues and the value it produces. Regenerate the fixtures with the Go
// generators documented in `docs/integration-port.md`.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	type ChangeRequestListOptions,
	GitHubChangeRequests,
} from "../src/server/integrations/github-changerequest.ts";
import { GitHubClient } from "../src/server/integrations/github-client.ts";
import { GitHubIssues } from "../src/server/integrations/github-issues.ts";
import type { IssueListOptions } from "../src/server/integrations/issues.ts";

const FIXTURES = path.join(
	import.meta.dir,
	"fixtures",
	"integrations",
	"github",
);

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
	labels?: string[];
	options?: Record<string, unknown>;
}

interface Fixture {
	case: string;
	note: string;
	responses: FixtureResponse[];
	redirectBody?: string;
	call: FixtureCall;
	requests: FixtureRequest[] | null;
	error?: boolean;
	message?: string;
	value?: string;
}

/**
 * Serve the fixture's canned responses in order. A repeated URL (a re-read
 * after a mutation) reuses the last matching response, which is what a live
 * provider would answer with again.
 */
function scriptedFetch(
	responses: readonly FixtureResponse[],
	redirectBaseUrl?: string,
): { fetchFn: typeof fetch; requests: FixtureRequest[] } {
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
				authorization: headers.get("authorization") ?? "",
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
			return new Response('{"message":"no fixture response"}', {
				status: 404,
			});
		used[index] = true;
		const headersOut = new Headers();
		for (const [name, value] of Object.entries(responses[index].headers ?? {}))
			headersOut.set(
				name,
				name.toLowerCase() === "location" && redirectBaseUrl
					? `${redirectBaseUrl}/logs`
					: value,
			);
		return new Response(responses[index].body, {
			status: responses[index].status,
			headers: headersOut,
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

async function runCase(
	kind: "issues" | "changerequest",
	fixtureCase: string,
): Promise<{
	value?: string;
	failure?: string;
	requests: FixtureRequest[];
	redirectRequests: string[];
}> {
	const fixture = JSON.parse(
		fs.readFileSync(
			path.join(FIXTURES, kind, fixtureCase, "fixture.json"),
			"utf8",
		),
	) as Fixture;
	const redirectRequests: string[] = [];
	let redirectBaseUrl: string | undefined;
	let redirectServer: ReturnType<typeof Bun.serve> | undefined;
	if (fixture.redirectBody !== undefined) {
		redirectServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				redirectRequests.push(
					`${request.method} ${new URL(request.url).pathname}`,
				);
				return new Response(fixture.redirectBody ?? "");
			},
		});
		redirectBaseUrl = `http://127.0.0.1:${redirectServer.port}`;
	}
	try {
		const { fetchFn, requests } = scriptedFetch(
			fixture.responses,
			redirectBaseUrl,
		);
		const client = new GitHubClient({
			token: "fixture-token",
			username: "octo",
			fetch: fetchFn,
		});
		const repo = { owner: "acme", repo: "devenv" };
		const changeRequests = new GitHubChangeRequests(client);
		const issues = new GitHubIssues(client, repo, changeRequests);
		const options = fixture.call.options ?? {};
		const number = fixture.call.number ?? 0;
		let value: unknown;
		try {
			switch (fixture.call.op) {
				case "getIssues":
					value = await issues.getIssues(undefined, toIssueOptions(options));
					break;
				case "getIssue":
					value = await issues.getIssue(undefined, number);
					break;
				case "getIssueComments":
					value = await issues.getIssueComments(undefined, number);
					break;
				case "closeIssue":
					value = await issues.closeIssue(
						undefined,
						number,
						fixture.call.body ?? "",
					);
					break;
				case "reopenIssue":
					value = await issues.reopenIssue(undefined, number);
					break;
				case "setLabels":
					value = await issues.setLabels(
						undefined,
						number,
						fixture.call.labels ?? [],
					);
					break;
				case "addAssignee":
					value = await issues.addAssignee(
						undefined,
						number,
						fixture.call.body ?? "",
					);
					break;
				case "removeAssignee":
					value = await issues.removeAssignee(undefined, number);
					break;
				case "addComment":
					value = await issues.addComment(
						undefined,
						number,
						fixture.call.body ?? "",
					);
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
					value = await issues.getChangeRequestLinkedIssues(repo, number);
					break;
				case "getChangeRequests":
					value = await changeRequests.getChangeRequests(
						repo,
						toChangeRequestOptions(options),
					);
					break;
				case "getPullRequest":
					value = await changeRequests.getPullRequest(repo, number);
					break;
				case "getChangeRequestChanges":
					value = await changeRequests.getChangeRequestChanges(repo, number);
					break;
				case "getDiscussions":
					value = await changeRequests.getDiscussions(repo, number);
					break;
				case "approve":
					await changeRequests.approve(repo, number);
					value = null;
					break;
				case "unapprove":
					await changeRequests.unapprove(repo, number);
					value = null;
					break;
				case "toggleApproval":
					await changeRequests.toggleApproval(repo, number);
					value = null;
					break;
				case "close":
					await changeRequests.close(repo, number);
					value = null;
					break;
				case "rebase":
					await changeRequests.rebase(repo, number);
					value = null;
					break;
				case "resolveDiscussion":
					await changeRequests.resolveDiscussion(repo, number, "1", true);
					value = null;
					break;
				case "createDiffComment":
					await changeRequests.createDiffComment(
						repo,
						number,
						fixture.call.body ?? "",
						options.positioned
							? {
									headSha: "abc123",
									newPath: "src/login.ts",
									newLine: 12,
									oldPath: "src/login.ts",
									baseSha: "def456",
									startSha: "def456",
								}
							: undefined,
					);
					value = null;
					break;
				case "replyToDiscussion":
					await changeRequests.replyToDiscussion(
						repo,
						number,
						"31",
						fixture.call.body ?? "",
					);
					value = null;
					break;
				case "getPipelineJobs":
					value = await changeRequests.getPipelineJobs(repo, number);
					break;
				case "getJobLogs":
					value = await changeRequests.getJobLogs(repo, number);
					break;
				default:
					throw new Error(`unknown fixture operation ${fixture.call.op}`);
			}
		} catch (error) {
			return {
				failure: error instanceof Error ? error.message : String(error),
				requests,
				redirectRequests,
			};
		}
		return {
			value: JSON.stringify(value),
			requests,
			redirectRequests,
		};
	} finally {
		redirectServer?.stop(true);
	}
}

function toIssueOptions(options: Record<string, unknown>): IssueListOptions {
	return {
		scope: options.scope as string | undefined,
		state: options.state as string | undefined,
		search: options.search as string | undefined,
		labels: options.labels as string[] | undefined,
		sortBy: options.sortBy as string | undefined,
		sortDirection: options.sortDirection as string | undefined,
		page: options.page as number | undefined,
		perPage: options.perPage as number | undefined,
	};
}

function toChangeRequestOptions(
	options: Record<string, unknown>,
): ChangeRequestListOptions {
	return {
		sourceBranch: options.sourceBranch as string | undefined,
		targetBranch: options.targetBranch as string | undefined,
		state: options.state as string | undefined,
		page: options.page as number | undefined,
		perPage: options.perPage as number | undefined,
		search: options.search as string | undefined,
		labels: options.labels as string[] | undefined,
		sortBy: options.sortBy as string | undefined,
		sortDirection: options.sortDirection as string | undefined,
		skipDetails: options.skipDetails as boolean | undefined,
	};
}

function fixture(
	caseKind: "issues" | "changerequest",
	fixtureCase: string,
): Fixture {
	return JSON.parse(
		fs.readFileSync(
			path.join(FIXTURES, caseKind, fixtureCase, "fixture.json"),
			"utf8",
		),
	) as Fixture;
}

for (const kind of ["issues", "changerequest"] as const) {
	describe(`github ${kind} parity (cross-runtime fixtures)`, () => {
		for (const fixtureCase of fixtureCases(kind)) {
			test(`reproduces the Go flow: ${fixtureCase}`, async () => {
				const expected = fixture(kind, fixtureCase);
				const result = await runCase(kind, fixtureCase);
				// The same requests, in the same order, with the same bodies.
				const expectedRequests = expected.requests ?? [];
				expect(result.requests.length).toBe(expectedRequests.length);
				for (let i = 0; i < expectedRequests.length; i++) {
					const want = expectedRequests[i];
					const got = result.requests[i];
					expect(`${i} ${got.method} ${got.url}`).toBe(
						`${i} ${want.method} ${want.url}`,
					);
					expect(got.body ?? "").toBe(want.body ?? "");
					if (want.headers.authorization !== "")
						expect(got.headers.authorization).toBe(want.headers.authorization);
					if (want.headers["content-type"] !== "")
						expect(got.headers["content-type"]).toBe(
							want.headers["content-type"],
						);
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
				if (expected.redirectBody !== undefined) {
					// The log redirect is followed without the API credential.
					expect(result.redirectRequests).toEqual(["GET /logs"]);
				}
			});
		}
	});
}
