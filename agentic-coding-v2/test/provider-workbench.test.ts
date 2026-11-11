import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../src/git.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { DevEnvClient } from "../src/tui/features/environments/core/client.ts";
import { GatewayBackend } from "../src/tui/features/environments/gateway-backend.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(() => {
	delete process.env.WORKBENCH_TOKEN;
	seen.length = 0;
	return cleanup();
});

const seen: { method: string; path: string; token: string; body: string }[] =
	[];
const issue = (state: string, labels: string[] = []) => ({
	id: 30,
	iid: 3,
	title: "Broken login",
	description: "token stub-workbench-secret leaked",
	state,
	web_url: "https://gitlab.invalid/group/api/-/issues/3",
	author: { name: "Dev", username: "dev" },
	labels,
	assignees: [],
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
});
const mergeRequest = {
	id: 70,
	iid: 7,
	title: "Feature",
	description: "",
	source_branch: "feature/login",
	target_branch: "develop",
	state: "opened",
	web_url: "https://gitlab.invalid/group/api/-/merge_requests/7",
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
	author: { name: "Dev", username: "dev" },
	head_pipeline: { id: 11, status: "failed", web_url: "https://p" },
	merge_status: "can_be_merged",
	detailed_merge_status: "mergeable",
	draft: false,
	work_in_progress: false,
	has_conflicts: false,
	blocking_discussions_resolved: true,
	rebase_in_progress: false,
	merge_error: "",
};
const stub = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = decodeURIComponent(url.pathname);
		seen.push({
			method: request.method,
			path: `${route}${url.search}`,
			token: request.headers.get("private-token") ?? "",
			body: await request.text(),
		});
		const base = "/api/v4/projects/group/api";
		if (route === "/api/v4/projects" && url.searchParams.get("search"))
			return Response.json([
				{
					name: "api",
					path_with_namespace: "group/api",
					http_url_to_repo: `http://127.0.0.1:${url.port}/group/api.git`,
					default_branch: "develop",
				},
			]);
		if (route === `${base}/repository/branches`)
			return Response.json([{ name: "develop" }, { name: "main" }]);
		if (route === `${base}/merge_requests` && request.method === "GET")
			return Response.json(
				url.searchParams.get("source_branch") === "feature/login"
					? [mergeRequest]
					: [],
				{ headers: { "X-Total": "1", "X-Total-Pages": "1", "X-Page": "1" } },
			);
		if (route === `${base}/merge_requests/7`)
			return Response.json(mergeRequest);
		if (route === `${base}/merge_requests/7/approvals`)
			return Response.json({
				approvals_required: 1,
				approvals_left: 1,
				approved_by: [],
			});
		if (route === `${base}/merge_requests/7/approve`)
			return Response.json({ id: 70 }, { status: 201 });
		if (route === `${base}/issues` && request.method === "GET")
			return Response.json([issue("opened")], {
				headers: { "X-Total": "1", "X-Total-Pages": "1", "X-Page": "1" },
			});
		if (route === `${base}/issues/3` && request.method === "PUT") {
			const body = JSON.parse(seen.at(-1)?.body ?? "{}") as {
				state_event?: string;
				labels?: string | string[];
			};
			return Response.json(
				issue(
					body.state_event === "close" ? "closed" : "opened",
					typeof body.labels === "string"
						? body.labels.split(",")
						: (body.labels ?? []),
				),
			);
		}
		if (route === `${base}/issues/3/notes` && request.method === "POST")
			return Response.json(
				{
					id: 5,
					body: "Looks good",
					author: { name: "Dev", username: "dev" },
					created_at: "2026-01-03T00:00:00Z",
					updated_at: "2026-01-03T00:00:00Z",
					system: false,
				},
				{ status: 201 },
			);
		if (route === `${base}/pipelines/11/jobs`)
			return Response.json([
				{
					id: 99,
					name: "test",
					stage: "test",
					status: "failed",
					web_url: "https://j",
					pipeline: { id: 11 },
				},
			]);
		if (route === `${base}/jobs/99/trace`)
			return new Response("step 1\nstep 2 stub-workbench-secret\n");
		if (route === `${base}/jobs/99/retry`)
			return Response.json({ id: 100 }, { status: 201 });
		return Response.json({ message: "404 Not Found" }, { status: 404 });
	},
});

test("restored v1 change requests, issues and CI act on the provider serving the app's origin through the gateway", async () => {
	const { app, config } = await fixture(false, (config) => {
		config.profiles = [];
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						targets: [],
					},
				],
			}),
		);
		config.providers.push({
			name: "gl",
			type: "gitlab",
			baseUrl: `http://127.0.0.1:${stub.port}`,
			username: "dev",
			tokenRef: "WORKBENCH_TOKEN",
		});
	});
	process.env.WORKBENCH_TOKEN = "stub-workbench-secret";
	const repository = config.repositories[0] ?? "";
	await git(repository, [
		"remote",
		"add",
		"origin",
		`http://127.0.0.1:${stub.port}/group/api.git`,
	]);
	const host = serve(app),
		connection = new ClientConnection(host.client),
		client = new DevEnvClient(new GatewayBackend(connection, () => {}));
	try {
		connection.connect();
		await eventually(
			async () => connection.state,
			(state) => state !== null,
		);
		expect((await client.getApps())[0]).toMatchObject({
			ident: "api",
			provider: "gl",
			sourceType: "gitlab",
		});
		expect(
			(await client.getProviders()).map((provider) => provider.name),
		).toEqual(["gl"]);
		// v1: "current" change requests need a feature branch.
		expect(
			(await client.getChangeRequests("api", "opened", "current", "gitlab"))
				.items,
		).toEqual([]);
		await git(repository, ["checkout", "-b", "feature/login"]);
		const changes = await client.getChangeRequests(
			"api",
			"opened",
			"current",
			"gitlab",
		);
		expect(changes.items[0]).toMatchObject({
			iid: 7,
			source_branch: "feature/login",
			default_branch: "feature/login",
			head_pipeline: { id: 11, status: "failed" },
		});
		const issues = await client.getIssues("api", "all", "gitlab");
		expect(issues.items[0]).toMatchObject({ iid: 3, state: "opened" });
		expect(JSON.stringify(issues)).not.toContain("stub-workbench-secret");
		expect(
			await client.setIssueLabels("api", 3, "gitlab", ["bug", "p1"]),
		).toMatchObject({ labels: ["bug", "p1"] });
		expect(await client.closeIssue("api", 3, "gitlab")).toMatchObject({
			state: "closed",
		});
		expect(
			await client.addIssueComment("api", 3, "gitlab", "Looks good"),
		).toMatchObject({ id: 5, body: "Looks good" });
		await client.approveChangeRequest("api", 7, "gitlab");
		const jobs = await client.getPipelineJobs("api", 11, "gitlab");
		expect(jobs[0]).toMatchObject({ id: 99, status: "failed" });
		const log = await client.getJobLogs("api", 99, "gitlab");
		expect(log).toContain("step 2 <redacted>");
		await client.retryJob("api", 99);
		await expect(client.rebaseCR("api", 404)).rejects.toThrow(
			"change request not found",
		);
		expect(seen.every((entry) => entry.token === "stub-workbench-secret")).toBe(
			true,
		);
		expect(
			seen
				.filter((entry) => entry.method !== "GET")
				.map((entry) => `${entry.method} ${entry.path}`),
		).toEqual([
			"PUT /api/v4/projects/group/api/issues/3",
			"PUT /api/v4/projects/group/api/issues/3",
			"POST /api/v4/projects/group/api/issues/3/notes",
			"POST /api/v4/projects/group/api/merge_requests/7/approve",
			"POST /api/v4/projects/group/api/jobs/99/retry",
			"PUT /api/v4/projects/group/api/merge_requests/404/rebase",
		]);
		delete process.env.WORKBENCH_TOKEN;
		await expect(client.getIssues("api", "all", "gitlab")).rejects.toThrow(
			'no token configured for provider "gl"',
		);
	} finally {
		connection.close();
		await host.stop();
	}
}, 20000);

test("restored v1 Providers view and add-repository flow keep typed tokens out of config and resolve them from the private .env", async () => {
	const { app, config } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						targets: [],
					},
				],
			}),
		);
	});
	const repository = config.repositories[0] ?? "";
	const remote = `http://127.0.0.1:${stub.port}/group/api.git`;
	await git(repository, ["remote", "add", "origin", remote]);
	const host = serve(app),
		connection = new ClientConnection(host.client),
		client = new DevEnvClient(new GatewayBackend(connection, () => {}));
	const configFile = path.join(config.configDir, "config.json"),
		envFile = path.join(config.configDir, ".env");
	try {
		connection.connect();
		await eventually(
			async () => connection.state,
			(state) => state !== null,
		);
		expect(await client.getProviders()).toEqual([]);
		expect(
			await client.createProvider({
				name: "gl",
				type: "gitlab",
				username: "dev",
				token: "typed-'secret",
			}),
		).toEqual({ name: "gl", type: "gitlab", username: "dev", has_token: true });
		const stored = fs.readFileSync(configFile, "utf8");
		expect(stored).not.toContain("typed-");
		expect(JSON.parse(stored).providers).toEqual([
			{
				name: "gl",
				type: "gitlab",
				// v1 GitLab providers had no URL: the host comes from the apps.
				baseUrl: `http://127.0.0.1:${stub.port}`,
				username: "dev",
				tokenRef: "DEVENV_PROVIDER_GL_TOKEN",
			},
		]);
		expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
		expect((await client.getApps())[0]).toMatchObject({
			provider: "gl",
			sourceType: "gitlab",
		});
		expect(await client.searchRepos("gl", "api")).toEqual([
			{
				name: "api",
				fullPath: "group/api",
				url: remote,
				defaultBranch: "develop",
			},
		]);
		expect(await client.getRepoBranches(remote)).toEqual(["develop", "main"]);
		expect(seen.map((entry) => entry.token)).toEqual([
			"typed-'secret",
			"typed-'secret",
		]);
		await expect(
			client.createProvider({
				name: "gl",
				type: "gitlab",
				username: "",
				token: "",
			}),
		).rejects.toThrow('Provider "gl" already exists');
		expect(await client.updateProvider("gl", { username: "dev2" })).toEqual({
			name: "gl",
			type: "gitlab",
			username: "dev2",
			has_token: true,
		});
		// A `${VAR}` entry is a reference: nothing is written to .env.
		expect(
			await client.createProvider({
				name: "gh",
				type: "github",
				username: "",
				token: ["${", "UNSET_PROVIDER_REFERENCE", "}"].join(""),
			}),
		).toEqual({
			name: "gh",
			type: "github",
			username: "",
			has_token: false,
			missing_vars: ["UNSET_PROVIDER_REFERENCE"],
		});
		await client.deleteProvider("gl");
		expect(fs.readFileSync(envFile, "utf8")).toBe("");
		expect(
			(await client.getProviders()).map((provider) => provider.name),
		).toEqual(["gh"]);
		await expect(client.getRepoBranches(remote)).rejects.toThrow(
			"No configured provider serves 127.0.0.1",
		);
	} finally {
		connection.close();
		await host.stop();
	}
}, 20000);

/** Loopback smart-HTTP Git host: `git http-backend` behind a Basic challenge,
 * so a clone only succeeds with the provider token from the credential helper. */
const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-git-host-"));
const gitAuth: string[] = [];
const gitHost = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const auth = request.headers.get("authorization");
		if (!auth)
			return new Response("auth", {
				status: 401,
				headers: { "WWW-Authenticate": 'Basic realm="git"' },
			});
		gitAuth.push(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString());
		const child = Bun.spawn(["git", "http-backend"], {
			stdin: new Uint8Array(await request.arrayBuffer()),
			stdout: "pipe",
			stderr: "ignore",
			env: {
				PATH: process.env.PATH ?? "",
				GIT_PROJECT_ROOT: gitRoot,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: request.method,
				CONTENT_TYPE: request.headers.get("content-type") ?? "",
				HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
				GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
			},
		});
		const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
		const split = output.indexOf("\r\n\r\n");
		const headers = new Headers();
		let status = 200;
		for (const line of output.subarray(0, split).toString().split("\r\n")) {
			const [name, ...rest] = line.split(":");
			const value = rest.join(":").trim();
			if (name?.toLowerCase() === "status") status = Number.parseInt(value, 10);
			else if (name) headers.set(name, value);
		}
		return new Response(output.subarray(split + 4), { status, headers });
	},
});

test("restored v1 add-repository clones under DEVENV_HOME, registers the app and remove refuses unsafe deletes", async () => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-devenv-home-")),
	);
	const source = path.join(home, "source");
	fs.mkdirSync(source);
	await git(source, ["init", "-b", "develop"]);
	await git(source, ["config", "user.name", "Test"]);
	await git(source, ["config", "user.email", "test@example.invalid"]);
	fs.writeFileSync(path.join(source, "README.md"), "service\n");
	await git(source, ["add", "README.md"]);
	await git(source, ["commit", "-m", "initial"]);
	fs.mkdirSync(path.join(gitRoot, "group"), { recursive: true });
	await git(gitRoot, [
		"clone",
		"--bare",
		source,
		path.join(gitRoot, "group", "service.git"),
	]);
	const previousHome = process.env.DEVENV_HOME;
	process.env.DEVENV_HOME = home;
	process.env.WORKBENCH_TOKEN = "clone-secret";
	const { app, config } = await fixture(false, (config) => {
		config.providers.push({
			name: "gl",
			type: "gitlab",
			baseUrl: `http://127.0.0.1:${gitHost.port}`,
			username: "dev",
			tokenRef: "WORKBENCH_TOKEN",
		});
	});
	const host = serve(app),
		connection = new ClientConnection(host.client),
		client = new DevEnvClient(new GatewayBackend(connection, () => {}));
	const remote = `http://127.0.0.1:${gitHost.port}/group/service.git`;
	const checkout = path.join(home, "new-service", "new-service");
	try {
		connection.connect();
		await eventually(
			async () => connection.state,
			(state) => state !== null,
		);
		const created = await client.createApp({
			displayName: "New Service",
			repositoryURL: remote,
			branch: "develop",
			provider: "gl",
			definitionLocation: "apps",
		});
		expect(created).toMatchObject({
			ident: "new-service",
			localDirectoryPath: checkout,
			provider: "gl",
			sourceType: "gitlab",
		});
		const apps = await eventually(
			() => client.getApps(),
			(list) =>
				list.some(
					(item) =>
						item.ident === "new-service" &&
						item.branch === "develop" &&
						!item.operationStatus,
				),
		);
		expect(apps.find((item) => item.ident === "new-service")).toMatchObject({
			provider: "gl",
			appType: "APP",
		});
		expect(gitAuth).toContain("oauth2:clone-secret");
		expect(
			fs.readFileSync(path.join(checkout, ".git", "config"), "utf8"),
		).not.toContain("clone-secret");
		const configFile = JSON.parse(
			fs.readFileSync(path.join(config.configDir, "config.json"), "utf8"),
		);
		expect(configFile.repositories).toContain(checkout);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(config.configDir, "environments.json"),
					"utf8",
				),
			).projects,
		).toEqual([
			{ id: "new-service", kind: "app", repository: checkout, targets: [] },
		]);
		await expect(
			client.createApp({
				displayName: "new service",
				repositoryURL: remote,
				branch: "develop",
				provider: "gl",
				definitionLocation: "apps",
			}),
		).rejects.toThrow('app with ident "new-service" already exists');
		fs.writeFileSync(path.join(checkout, "scratch.txt"), "local work\n");
		await expect(client.deleteApp("new-service")).rejects.toThrow(
			"uncommitted changes",
		);
		fs.rmSync(path.join(checkout, "scratch.txt"));
		await client.deleteApp("new-service");
		expect(fs.existsSync(path.join(home, "new-service"))).toBe(false);
		expect(
			JSON.parse(
				fs.readFileSync(path.join(config.configDir, "config.json"), "utf8"),
			).repositories,
		).not.toContain(checkout);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(config.configDir, "environments.json"),
					"utf8",
				),
			).projects,
		).toEqual([]);
	} finally {
		connection.close();
		await host.stop();
		if (previousHome === undefined) delete process.env.DEVENV_HOME;
		else process.env.DEVENV_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 30000);
