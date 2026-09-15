// The Git command boundary and the legacy integration families this process
// serves (port-git-providers-and-ai-to-bun, tasks 2.1-2.5; bridge removal in
// retire-go-backend-and-migration-bridges task 2.3).
//
// These tests pin real argv execution through the one Git implementation, the
// credential redaction that keeps a token out of a recorded command, and the
// static manifest that names every legacy route this process answers.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "../src/server/integrations/git-repository.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
	LEGACY_ROUTE_OWNERSHIP,
	legacyRouteMatch,
} from "../src/server/integrations/routes.ts";

function tempRepo(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "integration-repo-")),
	);
	Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
	Bun.spawnSync(["git", "add", "README.md"], { cwd: dir });
	Bun.spawnSync(["git", "commit", "-q", "-m", "init"], {
		cwd: dir,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	return dir;
}

function services(
	overrides: Partial<IntegrationServices> = {},
): IntegrationServices {
	return {
		providers: new ProviderStore(
			path.join(os.tmpdir(), `providers-${crypto.randomUUID()}`),
			"",
		),
		git: new GitRepository(),
		apps: {
			getAppByIdent: () => undefined,
			getApps: () => [],
			updateAppActiveWorktree: () => {},
			loadConfig: () => {},
		},
		...overrides,
	};
}

describe("the Git command boundary", () => {
	test("an argv invocation reports its exit code and output", () => {
		const repo = tempRepo();
		const git = new GitRepository();
		const result = git.run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
		expect(result.stdout.trim()).toBe("main");
		expect(result.exitCode).toBe(0);

		const failed = git.run(repo, ["rev-parse", "--verify", "does-not-exist"]);
		expect(failed.exitCode).not.toBe(0);
		expect(failed.stderr.length).toBeGreaterThan(0);
	});

	test("a credential header never appears in the recorded command", () => {
		const repo = tempRepo();
		const git = new GitRepository({
			auth: () => ({ username: "octo", token: "s3cret" }),
		});
		// The credential header is passed to the child (that is what makes the
		// remote call work) but must never appear in the recorded command.
		const config = git.credentialConfig(repo);
		expect(config).toHaveLength(1);
		const result = git.run(repo, ["ls-remote", "--heads", repo], config);
		expect(result.command.includes("s3cret")).toBe(false);
		expect(result.command.includes("http.extraheader=<redacted>")).toBe(true);
	});
});

describe("legacy route ownership", () => {
	test("the manifest covers every legacy family with one owner", () => {
		const seen = new Set<string>();
		for (const route of LEGACY_ROUTE_OWNERSHIP) {
			const key = `${route.method} ${route.path}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
			expect(route.owner).toBe("bun");
		}
		const families = new Set(LEGACY_ROUTE_OWNERSHIP.map((r) => r.family));
		for (const family of [
			"git",
			"providers",
			"repos",
			"github",
			"gitlab",
			"ai",
		])
			expect(families.has(family)).toBe(true);
	});

	test("resolves bun and delegated families, and unknown paths stay delegated", () => {
		expect(legacyRouteMatch("GET", "/api/git/branches")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("DELETE", "/api/git/worktrees")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("GET", "/api/providers/team")?.params.name).toBe(
			"team",
		);
		expect(legacyRouteMatch("GET", "/api/github/issues")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("GET", "/api/gitlab/issues")?.route.owner).toBe(
			"bun",
		);
		// Every family belongs to this process: the action/script families and the
		// legacy event stream (`port-action-execution-to-bun`), the app, docker and
		// kubernetes families (`port-environment-runtimes-to-bun`), and the
		// identity probe that used to report the retired child.
		expect(legacyRouteMatch("GET", "/api/scripts")?.route.owner).toBe("bun");
		expect(legacyRouteMatch("GET", "/api/action-runs")?.route.owner).toBe(
			undefined,
		);
		expect(legacyRouteMatch("POST", "/api/action-runs")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("GET", "/api/actions/history")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("GET", "/api/events")?.route.owner).toBe("bun");
		expect(legacyRouteMatch("GET", "/api/apps/demo/actions")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("GET", "/api/docker/logs")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("POST", "/api/docker/restart")?.route.owner).toBe(
			"bun",
		);
		expect(
			legacyRouteMatch("GET", "/api/kubernetes/cluster")?.route.owner,
		).toBe("bun");
		expect(
			legacyRouteMatch("POST", "/api/kubernetes/cluster/refresh")?.route.owner,
		).toBe("bun");
		expect(legacyRouteMatch("GET", "/api/status")?.route.owner).toBe("bun");
		expect(legacyRouteMatch("GET", "/api/apps")?.route.owner).toBe("bun");
		expect(
			legacyRouteMatch("DELETE", "/api/apps/demo/delete")?.route.owner,
		).toBe("bun");
		expect(legacyRouteMatch("POST", "/api/example-config")?.route.owner).toBe(
			"bun",
		);
		expect(legacyRouteMatch("GET", "/api/pi-sessions")?.route.owner).toBe(
			"bun",
		);
		expect(
			legacyRouteMatch("POST", "/api/ai/cr-review-stream")?.route.owner,
		).toBe("bun");
		expect(legacyRouteMatch("GET", "/api/health")?.route.owner).toBe("bun");
		expect(legacyRouteMatch("GET", "/api/unknown")).toBeUndefined();
	});
});

describe("Bun-served integration families", () => {
	test("git branches report local, remote and current branch", async () => {
		const repo = tempRepo();
		const app = {
			ident: "demo",
			repositoryPath: repo,
			localDirectoryPath: repo,
			branch: "main",
			mainWorktreeBranch: "main",
		};
		const response = await handleLegacyRoute(
			services({
				apps: {
					getAppByIdent: () => app,
					getApps: () => [app],
					updateAppActiveWorktree: () => {},
					loadConfig: () => {},
				},
			}),
			new Request("http://127.0.0.1/api/git/branches?appIdent=demo"),
			new URL("http://127.0.0.1/api/git/branches?appIdent=demo"),
		);
		expect(response?.status).toBe(200);
		const body = (await response?.json()) as {
			appIdent: string;
			currentBranch: string;
			localBranches: string[];
			remoteBranches: string[];
			error: string;
		};
		expect(body.appIdent).toBe("demo");
		expect(body.currentBranch).toBe("main");
		expect(body.localBranches).toEqual(["main"]);
		// A local path is a valid remote for `ls-remote`, so the only branch is
		// reported on both sides — the same answer the Go client produced.
		expect(body.remoteBranches).toEqual(["main"]);
		expect(body.error).toBe("");
	});

	test("a missing app and a missing parameter use the legacy envelope", async () => {
		const missingApp = await handleLegacyRoute(
			services(),
			new Request("http://127.0.0.1/api/git/branches?appIdent=nope"),
			new URL("http://127.0.0.1/api/git/branches?appIdent=nope"),
		);
		expect(missingApp?.status).toBe(404);
		expect(await missingApp?.json()).toEqual({
			error: "Not Found",
			message: "App not found",
			code: 404,
		});
		const missingParam = await handleLegacyRoute(
			services(),
			new Request("http://127.0.0.1/api/git/branches"),
			new URL("http://127.0.0.1/api/git/branches"),
		);
		expect(missingParam?.status).toBe(400);
	});

	test("worktree removal refuses the active and primary worktree", async () => {
		const app = {
			ident: "demo",
			repositoryPath: "/repo",
			localDirectoryPath: "/home/demo/demo.feature",
			branch: "feature",
			activeWorktree: "feature",
			mainWorktreeBranch: "main",
		};
		const url = new URL(
			"http://127.0.0.1/api/git/worktrees?appIdent=demo&branch=feature",
		);
		const response = await handleLegacyRoute(
			services({
				apps: {
					getAppByIdent: () => app,
					getApps: () => [app],
					updateAppActiveWorktree: () => {},
					loadConfig: () => {},
				},
			}),
			new Request(url, { method: "DELETE" }),
			url,
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toEqual({
			error: "Bad Request",
			message: "cannot remove the active or primary worktree",
			code: 400,
		});
	});

	test("providers hide the token and surface invalid definitions", async () => {
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "integration-config-"),
		);
		const providersDir = path.join(configDir, "providers");
		fs.mkdirSync(providersDir, { recursive: true });
		fs.writeFileSync(
			path.join(providersDir, "team.json"),
			JSON.stringify({
				name: "team",
				type: "gitlab",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
				username: "${DEVENV_PROVIDER_TEAM_USERNAME}",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
				token: "${DEVENV_PROVIDER_TEAM_TOKEN}",
			}),
		);
		fs.writeFileSync(
			path.join(configDir, ".env"),
			"DEVENV_PROVIDER_TEAM_USERNAME=octo\nDEVENV_PROVIDER_TEAM_TOKEN=tok\n",
		);
		fs.writeFileSync(
			path.join(providersDir, "plain.json"),
			JSON.stringify({ name: "plain", type: "github", token: "clear" }),
		);
		const store = new ProviderStore(providersDir, path.join(configDir, ".env"));
		const url = new URL("http://127.0.0.1/api/providers");
		const response = await handleLegacyRoute(
			services({ providers: store }),
			new Request(url),
			url,
		);
		const body = (await response?.json()) as Record<string, unknown>[];
		// Loaded providers first, then the files that were rejected.
		expect(body[0]).toEqual({
			name: "team",
			type: "gitlab",
			username: "octo",
			has_token: true,
		});
		expect(body[1]).toEqual({
			name: "plain",
			type: "github",
			invalid: true,
			reason: "clear-text-credentials",
			message:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the message text is the Go diagnostic.
				"provider file plain.json contains clear-text token; move credentials to .env and use ${...} placeholders",
		});
		expect(body.some((row) => "token" in row)).toBe(false);
		expect(JSON.stringify(body)).not.toContain('"tok"');
	});

	test("repository search maps a provider response through an injected fetch", async () => {
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "integration-search-"),
		);
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
		let requested = "";
		const fetchFn = (async (input: RequestInfo | URL) => {
			requested = input.toString();
			return new Response(
				JSON.stringify({
					items: [
						{
							name: "devenv",
							full_name: "acme/devenv",
							clone_url: "https://github.com/acme/devenv.git",
							default_branch: "main",
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;
		const url = new URL("http://127.0.0.1/api/repos/search");
		const response = await handleLegacyRoute(
			services({ providers: store, fetch: fetchFn }),
			new Request(url, {
				method: "POST",
				body: JSON.stringify({ provider: "gh", query: "acme" }),
			}),
			url,
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual([
			{
				name: "devenv",
				fullPath: "acme/devenv",
				url: "https://github.com/acme/devenv.git",
				defaultBranch: "main",
			},
		]);
		expect(requested).toContain("/search/repositories?per_page=20&q=acme");
	});

	test("GitLab search requires a host and reports it as a bounded error", async () => {
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "integration-gitlab-"),
		);
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
		const url = new URL("http://127.0.0.1/api/repos/search");
		const response = await handleLegacyRoute(
			services({ providers: store }),
			new Request(url, {
				method: "POST",
				body: JSON.stringify({ provider: "gl", query: "acme" }),
			}),
			url,
		);
		expect(response?.status).toBe(400);
		expect(await response?.json()).toEqual({
			error: "Bad Request",
			message:
				"GitLab host is required for search. Provide 'host' parameter or add an app with this provider first.",
			code: 400,
		});
	});

	test("the identity probe is served by this process", async () => {
		// `/api/health` used to be delegated; the retirement moved it in-process,
		// and the app's health route answers it before the family switch runs.
		const url = new URL("http://127.0.0.1/api/health");
		expect(await handleLegacyRoute(services(), new Request(url), url)).toBe(
			undefined,
		);
	});

	test("a runtime route without an attached capability fails instead of delegating", async () => {
		const url = new URL("http://127.0.0.1/api/docker/logs?containerID=abc");
		const response = await handleLegacyRoute(services(), new Request(url), url);
		expect(response?.status).toBe(503);
	});

	test("an action route without an attached engine fails instead of delegating", async () => {
		const url = new URL("http://127.0.0.1/api/actions/history");
		const response = await handleLegacyRoute(services(), new Request(url), url);
		expect(response?.status).toBe(503);
	});
});
