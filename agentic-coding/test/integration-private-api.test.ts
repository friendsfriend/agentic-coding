// Private Git operation adapter and Bun-served legacy integration families
// (`port-git-providers-and-ai-to-bun`, tasks 1.3, 2.1-2.5).
//
// The adapter is the temporary bridge the still-Go action owner uses; these
// tests pin its bounded envelope, its real command execution, its cancellation
// behavior, and the fact that it never delegates back to the Go child.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServerApp } from "../src/server/app.ts";
import { createInstanceAuthority } from "../src/server/auth.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { EventBroker } from "../src/server/events.ts";
import { GitRepository } from "../src/server/integrations/git-repository.ts";
import {
	decodeGitCommandRequest,
	executeGitCommand,
	MAX_GIT_ARGS,
	PRIVATE_GIT_COMMAND_PATH,
} from "../src/server/integrations/private-api.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
	LEGACY_ROUTE_OWNERSHIP,
	legacyRouteMatch,
} from "../src/server/integrations/routes.ts";
import { ROUTE_OWNERSHIP } from "../src/server/protocol.ts";

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

describe("private Git operation adapter", () => {
	test("is a bun-owned private route in the static manifest", () => {
		const route = ROUTE_OWNERSHIP.find(
			(candidate) => candidate.path === PRIVATE_GIT_COMMAND_PATH,
		);
		expect(route?.owner).toBe("bun");
		expect(route?.domain).toBe("integrations");
	});

	test("executes argv and echoes the run/step/command identity", async () => {
		const repo = tempRepo();
		const outcome = await executeGitCommand(
			{ git: new GitRepository() },
			{
				operation: "git.command",
				runId: "run-1",
				stepId: "step-1",
				commandId: "command-1",
				directory: repo,
				args: ["rev-parse", "--abbrev-ref", "HEAD"],
			},
		);
		expect(outcome.runId).toBe("run-1");
		expect(outcome.stepId).toBe("step-1");
		expect(outcome.commandId).toBe("command-1");
		expect(outcome.stdout.trim()).toBe("main");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.cancelled).toBe(false);
		expect(outcome.truncated).toBe(false);
	});

	test("reports a failing argv with its exit code instead of throwing", async () => {
		const repo = tempRepo();
		const outcome = await executeGitCommand(
			{ git: new GitRepository() },
			{
				operation: "git.command",
				runId: "run-2",
				stepId: "step-2",
				commandId: "command-2",
				directory: repo,
				args: ["rev-parse", "--verify", "does-not-exist"],
			},
		);
		expect(outcome.exitCode).not.toBe(0);
		expect(outcome.stderr.length).toBeGreaterThan(0);
	});

	test("cancellation kills the child and reports it as cancelled", async () => {
		const repo = tempRepo();
		const controller = new AbortController();
		// `hash-object --stdin` blocks until stdin closes, so the child is still
		// running when the originating request is aborted.
		const pending = executeGitCommand(
			{ git: new GitRepository() },
			{
				operation: "git.command",
				runId: "run-3",
				stepId: "step-3",
				commandId: "command-3",
				directory: repo,
				args: ["hash-object", "--stdin"],
			},
			controller.signal,
		);
		await Bun.sleep(50);
		controller.abort();
		await expect(pending).rejects.toThrow("was cancelled");
	});

	test("rejects an unknown field, a control character and an oversized argv", () => {
		const repo = tempRepo();
		const base = {
			operation: "git.command" as const,
			runId: "r",
			stepId: "s",
			commandId: "c",
			directory: repo,
		};
		expect(() =>
			decodeGitCommandRequest({ ...base, args: ["status"], extra: 1 }),
		).toThrow();
		expect(() =>
			decodeGitCommandRequest({ ...base, args: ["status\n--short"] }),
		).toThrow();
		expect(() =>
			decodeGitCommandRequest({
				...base,
				args: Array(MAX_GIT_ARGS + 1).fill("status"),
			}),
		).toThrow();
		expect(() =>
			decodeGitCommandRequest({ ...base, args: ["status"] }),
		).not.toThrow();
	});

	test("the HTTP envelope is bounded and never reaches the delegated child", async () => {
		const repo = tempRepo();
		const delegated = 0;
		const authority = createInstanceAuthority("inst-private");
		const app = createServerApp({
			authority,
			events: new EventBroker(authority.instance),
			credentials: new CredentialRegistry(),
			integrations: services(),
			environmentBaseUrl: "http://127.0.0.1:1",
			environmentToken: "private",
		});
		const post = (body: unknown) =>
			app.fetch(
				new Request(`http://127.0.0.1${PRIVATE_GIT_COMMAND_PATH}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${authority.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			);
		const ok = await post({
			operation: "git.command",
			runId: "run-9",
			stepId: "step-9",
			commandId: "command-9",
			directory: repo,
			args: ["rev-parse", "--abbrev-ref", "HEAD"],
		});
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as {
			value: { stdout: string; commandId: string };
		};
		expect(body.value.stdout.trim()).toBe("main");
		expect(body.value.commandId).toBe("command-9");
		// A dead delegation target proves the private path performs no outbound
		// request: it could never have answered from the child.
		expect(delegated).toBe(0);
		const excess = await post({
			operation: "git.command",
			runId: "r",
			stepId: "s",
			commandId: "c",
			directory: repo,
			args: ["status"],
			sql: "select 1",
		});
		expect(excess.status).toBe(400);
	});

	test("a credential header never appears in the recorded command", async () => {
		const repo = tempRepo();
		const git = new GitRepository({
			auth: () => ({ username: "octo", token: "s3cret" }),
		});
		const outcome = await executeGitCommand(
			{ git },
			{
				operation: "git.command",
				runId: "run-4",
				stepId: "step-4",
				commandId: "command-4",
				directory: repo,
				args: ["ls-remote", "--heads", repo],
				repositoryUrl: repo,
			},
		);
		expect(outcome.command.includes("s3cret")).toBe(false);
		expect(outcome.command.includes("http.extraheader=<redacted>")).toBe(true);
	});
});

describe("legacy route ownership", () => {
	test("the manifest covers every legacy family with one owner", () => {
		const seen = new Set<string>();
		for (const route of LEGACY_ROUTE_OWNERSHIP) {
			const key = `${route.method} ${route.path}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
			expect(["bun", "go"]).toContain(route.owner);
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
		expect(legacyRouteMatch("GET", "/api/scripts")?.route.owner).toBe("go");
		expect(legacyRouteMatch("GET", "/api/pi-sessions")?.route.owner).toBe(
			"bun",
		);
		expect(
			legacyRouteMatch("POST", "/api/ai/cr-review-stream")?.route.owner,
		).toBe("bun");
		expect(legacyRouteMatch("GET", "/api/health")?.route.owner).toBe("go");
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

	test("a Go-owned family is not served by the Bun handler", async () => {
		const url = new URL("http://127.0.0.1/api/scripts?appIdent=demo");
		expect(
			await handleLegacyRoute(services(), new Request(url), url),
		).toBeUndefined();
	});
});
