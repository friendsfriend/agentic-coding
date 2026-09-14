// Bun-served GitHub route family (`port-git-providers-and-ai-to-bun`,
// tasks 3.1-3.4, 5.1). These exercise the route layer — status codes, response
// envelopes and the aggregation that lives in the Go handler rather than in the
// client — with a scripted provider fetch.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "../src/server/integrations/git-repository.ts";
import {
	extractTestCount,
	handleGitHubRoute,
} from "../src/server/integrations/github-routes.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
	LEGACY_ROUTE_OWNERSHIP,
} from "../src/server/integrations/routes.ts";

const APP = {
	ident: "demo",
	repositoryPath: "https://github.com/acme/devenv.git",
	localDirectoryPath: "/home/demo/demo",
	branch: "main",
	mainWorktreeBranch: "main",
	provider: "gh",
};

function providerStore(): ProviderStore {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "github-routes-"));
	const providersDir = path.join(configDir, "providers");
	fs.mkdirSync(providersDir, { recursive: true });
	fs.writeFileSync(
		path.join(providersDir, "gh.json"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
		JSON.stringify({ name: "gh", type: "github", token: "${GH}" }),
	);
	fs.writeFileSync(path.join(configDir, ".env"), "GH=token\n");
	const store = new ProviderStore(providersDir, path.join(configDir, ".env"));
	store.load();
	return store;
}

/** Services with one configured app and a scripted provider fetch. */
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

/** A fetch that answers the given URL substrings with canned responses. */
function stubFetch(
	routes: Record<string, { status?: number; body: string }>,
): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		for (const [match, response] of Object.entries(routes)) {
			if (url.includes(match))
				return new Response(response.body, { status: response.status ?? 200 });
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

const issueJSON = `{"id":11,"number":7,"title":"Broken login","body":"Closes #3","state":"open","html_url":"https://github.com/acme/devenv/issues/7","user":{"login":"octo"},"labels":[{"name":"bug"}],"assignees":[],"created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-03T03:04:05Z"}`;

describe("github route ownership", () => {
	test("every github route is served by Bun", () => {
		const github = LEGACY_ROUTE_OWNERSHIP.filter(
			(route) => route.family === "github",
		);
		expect(github.length).toBe(24);
		for (const route of github) expect(route.owner).toBe("bun");
	});

	test("a gitlab path is not served by the github handler", async () => {
		const url = new URL("http://127.0.0.1/api/gitlab/issues?appIdent=demo");
		expect(
			await handleGitHubRoute(services(stubFetch({})), new Request(url), url),
		).toBeUndefined();
	});
});

describe("github issue routes", () => {
	test("lists issues with the searched page and total", async () => {
		const response = await get(
			"/api/github/issues",
			"appIdent=demo&scope=assigned-to-me&state=open&search=login&labels=bug&page=2&perPage=25",
			services(
				stubFetch({
					"/search/issues": {
						body: `{"total_count":1,"items":[${issueJSON}]}`,
					},
				}),
			),
		);
		expect(response?.status).toBe(200);
		const body = (await response?.json()) as {
			items: { iid: number; labels: string[] }[];
			totalCount: number;
			currentPage: number;
			perPage: number;
		};
		expect(body.items[0].iid).toBe(7);
		expect(body.items[0].labels).toEqual(["bug"]);
		expect(body.totalCount).toBe(1);
		expect(body.currentPage).toBe(2);
		expect(body.perPage).toBe(25);
	});

	test("a missing parameter, an unknown app and a tokenless provider fail closed", async () => {
		const missing = await get(
			"/api/github/issues",
			"",
			services(stubFetch({})),
		);
		expect(missing?.status).toBe(400);
		expect(await missing?.json()).toEqual({
			error: "Bad Request",
			message: "appIdent parameter required",
			code: 400,
		});
		const unknown = await get(
			"/api/github/issues",
			"appIdent=nope",
			services(stubFetch({})),
		);
		expect(unknown?.status).toBe(404);
		const tokenless = await get(
			"/api/github/issues",
			"appIdent=demo",
			services(stubFetch({}), { app: { provider: "missing" } }),
		);
		expect(tokenless?.status).toBe(400);
		expect(await tokenless?.json()).toEqual({
			error: "Bad Request",
			message: 'no token configured for provider "missing"',
			code: 400,
		});
	});

	test("a non-GitHub repository is rejected before any request", async () => {
		const response = await get(
			"/api/github/issues",
			"appIdent=demo",
			services(stubFetch({}), {
				app: { repositoryPath: "https://gitlab.example.com/acme/devenv.git" },
			}),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			message: expect.stringContaining("failed to extract repo info"),
		});
	});

	test("closing an issue sends the reason and returns the mapped issue", async () => {
		let body = "";
		const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			body = String(init?.body ?? "");
			return new Response(issueJSON, { status: 200 });
		}) as typeof fetch;
		const url = new URL(
			"http://127.0.0.1/api/github/issues/close?appIdent=demo&number=7",
		);
		const response = await handleLegacyRoute(
			services(fetchFn),
			new Request(url, {
				method: "POST",
				body: JSON.stringify({ reason: "not_planned" }),
			}),
			url,
		);
		expect(response?.status).toBe(200);
		expect(body).toBe('{"state":"closed","state_reason":"not_planned"}');
		expect(await response?.json()).toMatchObject({ iid: 7, state: "open" });
	});

	test("labels and collaborators are wrapped in their envelope", async () => {
		const labels = await get(
			"/api/github/labels",
			"appIdent=demo",
			services(stubFetch({ "/labels": { body: `[{"name":"bug"}]` } })),
		);
		expect(await labels?.json()).toEqual({ labels: ["bug"] });
		const collaborators = await get(
			"/api/github/collaborators",
			"appIdent=demo",
			services(stubFetch({ "/collaborators": { body: `[{"login":"octo"}]` } })),
		);
		expect(await collaborators?.json()).toEqual({ collaborators: ["octo"] });
	});

	test("a provider failure becomes the Go diagnostic", async () => {
		const response = await get(
			"/api/github/issue",
			"appIdent=demo&number=7",
			services(
				stubFetch({
					"/issues/7": { status: 404, body: `{"message":"Not Found"}` },
				}),
			),
		);
		expect(response?.status).toBe(500);
		expect(await response?.json()).toMatchObject({
			message:
				'Failed to fetch issue: GitHub API error (status 404): {"message":"Not Found"}',
		});
	});
});

describe("github change-request routes", () => {
	const pullJSON = `{"id":41,"number":9,"title":"Fix login","body":"","state":"open","html_url":"https://github.com/acme/devenv/pull/9","user":{"login":"octo"},"head":{"ref":"fix-login","sha":"abc123"},"base":{"ref":"main","sha":"def456"},"mergeable":true,"mergeable_state":"clean","created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-03T03:04:05Z"}`;

	test("an empty result reports the branch-specific Go message", async () => {
		const response = await get(
			"/api/github/pull-requests",
			"appIdent=demo&state=opened",
			services(stubFetch({ "/pulls?": { body: "[]" } }), {
				app: {
					branch: "feature-x",
					localDirectoryPath: "/home/demo/demo.feature-x",
				},
			}),
		);
		expect(response?.status).toBe(404);
		expect(await response?.json()).toEqual({
			error: "Not Found",
			message: "No open pull request found for branch 'feature-x'",
			code: 404,
		});
	});

	test("a page parameter switches to the skip-details path", async () => {
		const requested: string[] = [];
		const fetchFn = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			requested.push(url);
			return new Response(`[${pullJSON}]`, { status: 200 });
		}) as typeof fetch;
		const response = await get(
			"/api/github/pull-requests",
			"appIdent=demo&page=1&perPage=10",
			services(fetchFn),
		);
		expect(response?.status).toBe(200);
		// Only the list endpoint is read: no per-item approvals or workflow run.
		expect(requested.length).toBe(1);
		expect(requested[0]).toContain("/pulls?");
		const body = (await response?.json()) as {
			items: { default_branch: string }[];
		};
		expect(body.items[0].default_branch).toBe("main");
	});

	test("approving answers with the Go success envelope", async () => {
		let body = "";
		const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			body = String(init?.body ?? "");
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const url = new URL(
			"http://127.0.0.1/api/github/pr-approve?appIdent=demo&crIID=9",
		);
		const response = await handleLegacyRoute(
			services(fetchFn),
			new Request(url, { method: "POST" }),
			url,
		);
		expect(await response?.json()).toEqual({
			status: "success",
			message: "Pull request approved successfully",
		});
		expect(body).toBe('{"event":"APPROVE"}');
	});

	test("an invalid crIID is rejected before any request", async () => {
		const response = await get(
			"/api/github/pr-changes",
			"appIdent=demo&crIID=abc",
			services(stubFetch({})),
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			message: "appIdent and crIID parameters required",
		});
	});
});

describe("github actions test summary", () => {
	test("counts tests out of check-run summaries and ignores unfinished checks", async () => {
		const response = await get(
			"/api/github/actions-test-summary",
			"appIdent=demo&runId=77",
			services(
				stubFetch({
					"/actions/runs/77": {
						body: `{"id":77,"status":"completed","conclusion":"success","head_sha":"abc123"}`,
					},
					"/check-runs": {
						body:
							`{"check_runs":[` +
							`{"name":"test","status":"completed","output":{"summary":"12 passed, 2 failed, 1 skipped"}},` +
							`{"name":"e2e","status":"completed","output":{"summary":"passed: 3 failed: 1"}},` +
							`{"name":"lint","status":"completed","output":{"summary":"5 tests"}},` +
							`{"name":"deploy","status":"in_progress","output":{"summary":"9 passed"}}]}`,
					},
				}),
			),
		);
		expect(response?.status).toBe(200);
		// `"passed: 3 failed: 1"` is counted as 3 passed and 3 failed: the first
		// pattern also matches the digits in front of "failed". That is the Go
		// behavior (pinned by TestExtractTestCountPatterns) and is preserved.
		expect(await response?.json()).toEqual({
			total: 26,
			success: 20,
			failed: 5,
			skipped: 1,
			error: 0,
			test_suites: [
				{ name: "test", test_cases: [] },
				{ name: "e2e", test_cases: [] },
				{ name: "lint", test_cases: [] },
			],
		});
	});

	test("a missing run or unreadable check runs answer with an empty summary", async () => {
		const response = await get(
			"/api/github/actions-test-summary",
			"appIdent=demo&runId=77",
			services(
				stubFetch({
					"/actions/runs/77": { status: 404, body: `{"message":"Not Found"}` },
				}),
			),
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			total: 0,
			success: 0,
			failed: 0,
			skipped: 0,
			error: 0,
			test_suites: [],
		});
	});

	test("the summary extractor reproduces the Go regex order", () => {
		// The first pattern wins; the "name: count" form is the fallback and the
		// bare "N tests" form only applies when nothing else matched.
		expect(
			extractTestCount("12 passed, 2 failed, 1 skipped", /(\d+)\s*passed/),
		).toBe(12);
		expect(
			extractTestCount("12 passed, 2 failed, 1 skipped", /(\d+)\s*failed/),
		).toBe(2);
		expect(
			extractTestCount("12 passed, 2 failed, 1 skipped", /(\d+)\s*skipped/),
		).toBe(1);
		expect(extractTestCount("passed: 3 failed: 1", /(\d+)\s*passed/)).toBe(0);
		expect(extractTestCount("passed: 3 failed: 1", /passed[:\s]+(\d+)/)).toBe(
			3,
		);
		expect(extractTestCount("passed: 3 failed: 1", /(\d+)\s*failed/)).toBe(3);
		expect(extractTestCount("5 tests", /(\d+)\s*tests?/)).toBe(5);
		expect(extractTestCount("no counts here", /(\d+)\s*passed/)).toBe(0);
	});
});
