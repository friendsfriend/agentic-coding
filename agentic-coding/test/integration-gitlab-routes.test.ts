// Bun-served GitLab route family (`port-git-providers-and-ai-to-bun`,
// tasks 3.5-3.8, 5.1). These exercise the route layer — status codes, response
// envelopes and the branch/scope handling that lives in the Go handlers rather
// than in the client — with a scripted provider fetch.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "../src/server/integrations/git-repository.ts";
import { handleGitLabRoute } from "../src/server/integrations/gitlab-routes.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
	LEGACY_ROUTE_OWNERSHIP,
} from "../src/server/integrations/routes.ts";

const APP = {
	ident: "demo",
	repositoryPath: "https://gitlab.example.com/acme/devenv.git",
	localDirectoryPath: "/home/demo/demo",
	branch: "fix-login",
	mainWorktreeBranch: "develop",
	provider: "gl",
};

function providerStore(): ProviderStore {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitlab-routes-"));
	const providersDir = path.join(configDir, "providers");
	fs.mkdirSync(providersDir, { recursive: true });
	fs.writeFileSync(
		path.join(providersDir, "gl.json"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
		JSON.stringify({ name: "gl", type: "gitlab", token: "${GL}" }),
	);
	fs.writeFileSync(path.join(configDir, ".env"), "GL=token\n");
	const store = new ProviderStore(providersDir, path.join(configDir, ".env"));
	store.load();
	return store;
}

function services(
	fetchFn: typeof fetch,
	overrides: { app?: Record<string, unknown>; providers?: ProviderStore } = {},
): IntegrationServices {
	const app = { ...APP, ...overrides.app };
	return {
		providers: overrides.providers ?? providerStore(),
		git: new GitRepository(),
		apps: {
			getAppByIdent: (ident) => (ident === app.ident ? app : undefined),
			getApps: () => [app],
			updateAppActiveWorktree: () => {},
			loadConfig: () => {},
		},
		fetch: fetchFn,
	};
}

function stubFetch(
	routes: Record<
		string,
		{ status?: number; body: string; headers?: Record<string, string> }
	>,
): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		for (const [match, response] of Object.entries(routes)) {
			if (url.includes(match))
				return new Response(response.body, {
					status: response.status ?? 200,
					headers: response.headers ?? {},
				});
		}
		return new Response('{"message":"unexpected request"}', { status: 404 });
	}) as typeof fetch;
}

async function get(
	route: string,
	query: string,
	servicesArg: IntegrationServices,
): Promise<Response | undefined> {
	const url = new URL(`http://127.0.0.1${route}?${query}`);
	return handleLegacyRoute(servicesArg, new Request(url), url);
}

async function post(
	route: string,
	query: string,
	body: unknown,
	servicesArg: IntegrationServices,
): Promise<Response | undefined> {
	const url = new URL(`http://127.0.0.1${route}?${query}`);
	return handleLegacyRoute(
		servicesArg,
		new Request(url, {
			method: "POST",
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
		url,
	);
}

const mrJSON = `{"id":41,"iid":9,"title":"Fix login","description":"","source_branch":"fix-login","target_branch":"develop","state":"opened","web_url":"https://gitlab.example.com/acme/devenv/-/merge_requests/9","created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-03T03:04:05.000Z","author":{"name":"Octo","username":"octo"},"merge_status":"can_be_merged","detailed_merge_status":"mergeable","draft":false,"work_in_progress":false,"has_conflicts":false,"blocking_discussions_resolved":true,"rebase_in_progress":false,"merge_error":""}`;

const issueJSON = `{"id":11,"iid":7,"title":"Broken login","description":"Fixes #3","state":"opened","web_url":"https://gitlab.example.com/acme/devenv/-/issues/7","author":{"name":"Octo","username":"octo"},"labels":["bug"],"assignees":[],"created_at":"2026-01-02T03:04:05.000Z","updated_at":"2026-01-03T03:04:05.000Z"}`;

describe("gitlab route ownership", () => {
	test("every gitlab route is served by Bun", () => {
		const gitlab = LEGACY_ROUTE_OWNERSHIP.filter(
			(route) => route.family === "gitlab",
		);
		expect(gitlab.length).toBe(30);
		for (const route of gitlab) expect(route.owner).toBe("bun");
	});

	test("a non-GitLab path is not served by the gitlab handler", async () => {
		const url = new URL("http://127.0.0.1/api/github/issues?appIdent=demo");
		expect(
			await handleGitLabRoute(services(stubFetch({})), new Request(url), url),
		).toBeUndefined();
	});
});

describe("gitlab change-request routes", () => {
	test("a default branch is refused with the Go message", async () => {
		const response = await get(
			"/api/gitlab/merge-requests",
			"appIdent=demo",
			services(stubFetch({}), {
				app: { branch: "main", localDirectoryPath: "/home/demo/demo" },
			}),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toEqual({
			error: "Bad Request",
			message:
				"Branch 'main' is not a feature branch. No change request to show.",
			code: 400,
		});
	});

	test("a feature branch filters by source branch and target develop", async () => {
		const requested: string[] = [];
		const fetchFn = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			requested.push(url);
			return new Response(`[${mrJSON}]`, {
				status: 200,
				headers: { "X-Total": "1", "X-Total-Pages": "1", "X-Page": "1" },
			});
		}) as typeof fetch;
		const response = await get(
			"/api/gitlab/merge-requests",
			"appIdent=demo&page=1&perPage=10",
			services(fetchFn),
		);
		expect(response?.status).toBe(200);
		expect(requested[0]).toContain("source_branch=fix-login");
		expect(requested[0]).toContain("target_branch=develop");
		const body = (await response?.json()) as {
			items: { default_branch: string }[];
			totalCount: number;
		};
		// The default branch is backfilled from the app.
		expect(body.items[0].default_branch).toBe("develop");
		expect(body.totalCount).toBe(1);
	});

	test("an empty result reports the branch-to-develop message", async () => {
		const response = await get(
			"/api/gitlab/merge-requests",
			"appIdent=demo&allBranches=true",
			services(stubFetch({ "/merge_requests?": { body: "[]" } })),
		);
		expect(response?.status).toBe(404);
		expect(await response?.json()).toMatchObject({
			message: "No open change requests found for this project",
		});
	});

	test("a tokenless provider and an unknown app fail closed", async () => {
		const tokenless = await get(
			"/api/gitlab/merge-requests",
			"appIdent=demo",
			services(stubFetch({}), { app: { provider: "missing" } }),
		);
		expect(tokenless?.status).toBe(400);
		expect(await tokenless?.json()).toMatchObject({
			message: 'no token configured for provider "missing"',
		});
		const unknown = await get(
			"/api/gitlab/merge-requests",
			"appIdent=nope",
			services(stubFetch({})),
		);
		expect(unknown?.status).toBe(404);
	});

	test("approving answers with the Go success envelope", async () => {
		const response = await post(
			"/api/gitlab/cr-approve",
			"appIdent=demo&crIID=9",
			undefined,
			services(stubFetch({ "/approve": { status: 201, body: "{}" } })),
		);
		expect(await response?.json()).toEqual({
			status: "success",
			message: "Merge request approved successfully",
		});
	});

	test("toggling without a configured username is refused", async () => {
		const store = providerStore();
		// A provider without a username cannot decide who approved.
		const response = await post(
			"/api/gitlab/cr-toggle-approval",
			"appIdent=demo&crIID=9",
			undefined,
			services(stubFetch({}), { providers: store }),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			message: "GitLab username not configured",
		});
	});

	test("a discussion reply requires every field", async () => {
		const response = await post(
			"/api/gitlab/cr-discussion-reply",
			"appIdent=demo",
			{ crIID: 9, body: "thanks" },
			services(stubFetch({})),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			message: "appIdent, crIID, discussionID, and body are required",
		});
	});

	test("a comment posts the body and reports success", async () => {
		const response = await post(
			"/api/gitlab/cr-comment",
			"",
			{ appIdent: "demo", crIID: 9, body: "looks good" },
			services(
				stubFetch({ "/discussions": { status: 201, body: `{"id":"abc"}` } }),
			),
		);
		expect(await response?.json()).toEqual({
			status: "success",
			message: "Comment created successfully",
		});
	});
});

describe("gitlab issue routes", () => {
	test("lists issues with the searched page and totals", async () => {
		const response = await get(
			"/api/gitlab/issues",
			"appIdent=demo&scope=assigned-to-me&state=open&labels=bug&page=2&perPage=25",
			services(
				stubFetch({
					"/issues?": {
						body: `[${issueJSON}]`,
						headers: { "X-Total": "12", "X-Total-Pages": "3", "X-Page": "2" },
					},
				}),
			),
		);
		expect(response?.status).toBe(200);
		const body = (await response?.json()) as {
			items: { iid: number; labels: string[] }[];
			totalCount: number;
			currentPage: number;
		};
		expect(body.items[0].iid).toBe(7);
		expect(body.items[0].labels).toEqual(["bug"]);
		expect(body.totalCount).toBe(12);
		expect(body.currentPage).toBe(2);
	});

	test("closing an issue reports the Go diagnostic on failure", async () => {
		const response = await post(
			"/api/gitlab/issues/close",
			"appIdent=demo&number=7",
			{ reason: "completed" },
			services(
				stubFetch({
					"/issues/7": { status: 403, body: `{"message":"403 Forbidden"}` },
				}),
			),
		);
		expect(response?.status).toBe(500);
		expect(await response?.json()).toMatchObject({
			message:
				'Failed to close issue: GitLab API error (status 403): {"message":"403 Forbidden"}',
		});
	});

	test("labels and collaborators are wrapped in their envelope", async () => {
		const labels = await get(
			"/api/gitlab/labels",
			"appIdent=demo",
			services(stubFetch({ "/labels": { body: `[{"name":"bug"}]` } })),
		);
		expect(await labels?.json()).toEqual({ labels: ["bug"] });
		const collaborators = await get(
			"/api/gitlab/collaborators",
			"appIdent=demo",
			services(
				stubFetch({
					"/members": { body: `[{"name":"Octo","username":"octo"}]` },
				}),
			),
		);
		expect(await collaborators?.json()).toEqual({ collaborators: ["octo"] });
	});

	test("a missing number parameter is rejected before any request", async () => {
		const response = await get(
			"/api/gitlab/issue",
			"appIdent=demo",
			services(stubFetch({})),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			message: "appIdent and number parameters required",
		});
	});
});

describe("gitlab CI routes", () => {
	test("pipeline jobs and job logs answer in the provider shapes", async () => {
		const jobs = await get(
			"/api/gitlab/jobs",
			"appIdent=demo&pipelineId=77",
			services(
				stubFetch({
					"/pipelines/77/jobs": {
						body: `[{"id":101,"name":"build","stage":"build","status":"success","web_url":"https://gitlab.example.com/jobs/101","created_at":"2026-01-02T03:04:05.000Z","pipeline":{"id":77}}]`,
					},
				}),
			),
		);
		expect(jobs?.status).toBe(200);
		expect(await jobs?.json()).toEqual([
			{
				id: 101,
				name: "build",
				stage: "build",
				status: "success",
				web_url: "https://gitlab.example.com/jobs/101",
				created_at: "2026-01-02T03:04:05Z",
				pipeline: { id: 77 },
			},
		]);

		const logs = await get(
			"/api/gitlab/job-logs",
			"appIdent=demo&jobId=101",
			services(
				stubFetch({ "/jobs/101/trace": { body: "line one\nline two\n" } }),
			),
		);
		expect(logs?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(await logs?.text()).toBe("line one\nline two\n");
	});

	test("a pipeline without a test report answers null", async () => {
		const response = await get(
			"/api/gitlab/test-summary",
			"appIdent=demo&pipelineId=77",
			services(
				stubFetch({
					"/test_report": { status: 404, body: `{"message":"404 Not Found"}` },
				}),
			),
		);
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("null");
	});

	test("retry and cancel answer with the job envelope", async () => {
		const retry = await post(
			"/api/gitlab/job-retry",
			"appIdent=demo&jobId=101",
			undefined,
			services(stubFetch({ "/retry": { status: 201, body: "{}" } })),
		);
		expect(await retry?.json()).toEqual({
			success: true,
			jobId: 101,
			action: "retry",
		});
		const cancel = await post(
			"/api/gitlab/job-cancel",
			"appIdent=demo&jobId=101",
			undefined,
			services(stubFetch({ "/cancel": { status: 201, body: "{}" } })),
		);
		expect(await cancel?.json()).toEqual({
			success: true,
			jobId: 101,
			action: "cancel",
		});
	});

	test("a non-cancellable job reports the Go diagnostic", async () => {
		const response = await post(
			"/api/gitlab/job-cancel",
			"appIdent=demo&jobId=101",
			undefined,
			services(stubFetch({ "/cancel": { status: 400, body: "{}" } })),
		);
		expect(response?.status).toBe(500);
		expect(await response?.json()).toMatchObject({
			message:
				"Failed to cancel job: job cannot be cancelled (may already be finished or in a non-cancellable state)",
		});
	});

	test("a pipeline id is required", async () => {
		const response = await get(
			"/api/gitlab/test-summary",
			"appIdent=demo",
			services(stubFetch({})),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			message: "appIdent and pipelineId parameters required",
		});
	});
});
