import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function fixtureGit(repo: string, args: string[]) {
	const result = Bun.spawnSync(
		[
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"maintenance.auto=false",
			...args,
		],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) throw new Error("Disposable Git fixture failed");
	return result.stdout.toString().trim();
}
async function setup(
	options: {
		failure?: boolean;
		infrastructure?: boolean;
		secondRoot?: boolean;
		targetScoped?: boolean;
	} = {},
) {
	let foreign = "",
		port = 0;
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("fixture"),
	});
	port = Number(probe.port);
	probe.stop(true);
	const endpoint = `http://127.0.0.1:${port}/`;
	const result = await fixture(true, (config) => {
		foreign = fs.realpathSync(
			fs.mkdtempSync(path.join(path.dirname(config.stateDir), "secondary-")),
		);
		fixtureGit(foreign, ["init", "-b", "main"]);
		fixtureGit(foreign, ["config", "user.name", "Fixture"]);
		fixtureGit(foreign, ["config", "user.email", "fixture@example.invalid"]);
		fs.writeFileSync(path.join(foreign, "identity.txt"), "captured-commit");
		fixtureGit(foreign, ["add", "identity.txt"]);
		fixtureGit(foreign, ["commit", "-m", "fixture"]);
		fs.writeFileSync(
			path.join(foreign, "identity.txt"),
			"developer-dirty-content",
		);
		config.repositories.push(foreign);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.chmodSync(config.stateDir, 0o700);
		const node = (source: string) =>
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
		const backend = `const fs=require('node:fs');const server=Bun.serve({hostname:'127.0.0.1',port:${port},fetch:()=>new Response(fs.readFileSync('identity.txt','utf8'))});process.on('SIGTERM',()=>{fs.writeFileSync('backend-stopped','stopped');server.stop(true);process.exit(0)});console.log('BACKEND_READY');`;
		const frontend = options.failure
			? "process.exit(2)"
			: `const fs=require('node:fs');process.on('SIGTERM',()=>{fetch('${endpoint}').then(r=>r.text()).then(s=>fs.writeFileSync('cleanup-order',s)).catch(()=>fs.writeFileSync('cleanup-order','missing')).finally(()=>process.exit(0))});fetch('${endpoint}').then(r=>r.text()).then(s=>{if(s!=='captured-commit')process.exit(3);console.log('FRONTEND_READY');setInterval(()=>{},1000)});`;
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "frontend",
						kind: "app",
						repository: config.repositories[0],
						...(options.targetScoped
							? {}
							: { prerequisites: [{ app: "backend", target: "serve" }] }),
						targets: [
							{
								id: "serve",
								runtime: "shell",
								action: "run",
								command: node(frontend),
								readyText: "FRONTEND_READY",
								timeoutMs: 2000,
								...(options.targetScoped
									? { prerequisites: [{ app: "backend", target: "serve" }] }
									: {}),
							},
							...(options.targetScoped
								? [
										{
											id: "standalone",
											runtime: "shell",
											action: "run",
											profile: "standalone",
											command: node(
												"console.log('STANDALONE_READY');setInterval(()=>{},1000)",
											),
											readyText: "STANDALONE_READY",
										},
									]
								: []),
						],
					},
					...(options.secondRoot
						? [
								{
									id: "second-frontend",
									kind: "app",
									repository: config.repositories[0],
									prerequisites: [{ app: "backend", target: "serve" }],
									targets: [
										{
											id: "serve",
											runtime: "shell",
											action: "run",
											command: node(frontend),
											readyText: "FRONTEND_READY",
											timeoutMs: 2000,
										},
									],
								},
							]
						: []),
					{
						id: "backend",
						kind: options.infrastructure ? "infrastructure" : "app",
						repository: foreign,
						targets: [
							{
								id: "serve",
								runtime: "shell",
								action: "run",
								command: node(backend),
								readyText: "BACKEND_READY",
								endpoints: { api: endpoint },
							},
						],
					},
				],
			}),
		);
	});
	return { ...result, foreign, endpoint };
}

test("explicit foreign app prerequisites pin a commit, start ready first, permit only owner diagnostics and stop dependent-first without changing the source checkout", async () => {
	const { app, fake, invocation, foreign, config } = await setup();
	fake.setResponses([
		call("env_start", { apps: ["frontend"] }),
		call("request_review", { path: ".", title: "Hold cross repository" }),
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task);
	const approved = JSON.parse(review.snapshot);
	expect(approved.prerequisiteWorkspaceScope).toContain(
		"detached Git worktree",
	);
	expect(approved.plans.map((plan: { app: string }) => plan.app)).toEqual([
		"backend",
		"frontend",
	]);
	expect(
		fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
	).toBe(false);
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	await approve(app, task);
	await pendingReview(app, task, "Hold cross repository");
	const started = await app.environments.snapshot(),
		backend = started.runs.find((run) => run.plan.app === "backend"),
		frontend = started.runs.find((run) => run.plan.app === "frontend");
	if (!backend || !frontend)
		throw new Error("Missing public prerequisite receipts");
	expect(started.runs.every((run) => run.state === "running")).toBe(true);
	expect(backend.plan.workspace).not.toBe(foreign);
	expect(backend.plan.workspace).not.toBe(frontend.plan.workspace);
	expect(backend.plan.dependencyWorkspace?.ownerWorkspace).toBe(
		frontend.plan.workspace,
	);
	expect(backend.plan.dependencyWorkspace?.owner).toBe(task);
	expect(
		fixtureGit(backend.plan.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
	).toBe("HEAD");
	expect(
		fs.readFileSync(path.join(backend.plan.workspace, "identity.txt"), "utf8"),
	).toBe("captured-commit");
	expect(fs.readFileSync(path.join(foreign, "identity.txt"), "utf8")).toBe(
		"developer-dirty-content",
	);
	let observed = "";
	fake.setResponses([
		call("env_http_request", {
			app: "backend",
			endpoint: "api",
			method: "GET",
		}),
		(messages) => {
			observed = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_request",
				),
			);
			return call("request_review", {
				path: ".",
				title: "Hold foreign diagnostic",
			});
		},
	]);
	await approve(app, task, "Hold cross repository");
	await approve(app, task, "Endpoint GET: backend/api");
	await pendingReview(app, task, "Hold foreign diagnostic");
	expect(observed).toContain("captured-commit");
	fake.setResponses([
		call("env_stop", { apps: ["backend"] }),
		call("request_review", { path: ".", title: "Hold foreign stopped" }),
	]);
	await approve(app, task, "Hold foreign diagnostic");
	await pendingReview(app, task, "Hold foreign stopped");
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
	expect(
		fs.readFileSync(
			path.join(frontend.plan.workspace, "cleanup-order"),
			"utf8",
		),
	).toBe("captured-commit");
	expect(
		fs.readFileSync(
			path.join(backend.plan.workspace, "backend-stopped"),
			"utf8",
		),
	).toBe("stopped");
	expect(fs.existsSync(path.join(foreign, "backend-stopped"))).toBe(false);
	await app.cancel(task);
}, 20000);

test("rejecting exact prerequisite approval creates no dependency worktree or resource", async () => {
	const { app, fake, invocation, config, foreign } = await setup();
	fake.setResponses([
		call("env_start", { apps: ["frontend"] }),
		call("request_review", { path: ".", title: "Hold rejected prerequisites" }),
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task);
	await app.decide(
		review.id,
		review.revision,
		"rejected",
		"Do not create a dependency worktree",
	);
	await pendingReview(app, task, "Hold rejected prerequisites");
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	expect(
		fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
	).toBe(false);
	expect(fs.readFileSync(path.join(foreign, "identity.txt"), "utf8")).toBe(
		"developer-dirty-content",
	);
	await app.cancel(task);
}, 15000);

test("foreign app startup failure rolls back the complete dependency batch with both workspaces retained", async () => {
	const { app, fake, invocation, foreign } = await setup({ failure: true });
	fake.setResponses([
		call("env_start", { apps: ["frontend"] }),
		call("request_review", { path: ".", title: "Hold failed foreign app" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold failed foreign app");
	const stopped = await eventually(
		() => app.environments.snapshot(),
		(state) =>
			state.runs.length === 2 &&
			state.runs.every((run) => run.state === "exited"),
	);
	const backend = stopped.runs.find((run) => run.plan.app === "backend");
	if (!backend) throw new Error("Missing backend receipt");
	expect(fs.existsSync(backend.plan.workspace)).toBe(true);
	expect(
		fs.existsSync(path.join(backend.plan.workspace, "backend-stopped")),
	).toBe(true);
	expect(fs.existsSync(path.join(foreign, "backend-stopped"))).toBe(false);
	await app.cancel(task);
}, 15000);

test("a foreign root is not authorized by merely configuring another repository", async () => {
	const { app, fake, invocation, config } = await setup();
	let result = "";
	fake.setResponses([
		call("env_start", { apps: ["backend"] }),
		(messages) => {
			result = JSON.stringify(messages.messages);
			return call("request_review", {
				path: ".",
				title: "Hold refused foreign root",
			});
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Hold refused foreign root");
	expect(result).toContain("root project must belong");
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	expect(
		fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
	).toBe(false);
	await app.cancel(task);
}, 15000);

test("application prerequisites do not silently acquire shared app-generation or independent-root authority", async () => {
	const { app, fake, invocation, config } = await setup();
	let result = "";
	fake.setResponses([
		call("env_start", {
			apps: ["frontend"],
			lifetime: "shared-prerequisites-v1",
		}),
		(messages) => {
			result = JSON.stringify(messages.messages);
			return call("request_review", {
				path: ".",
				title: "Hold refused app sharing",
			});
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Hold refused app sharing");
	expect(result).toContain(
		"Application prerequisites require the default coupled lifetime",
	);
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	expect(
		fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
	).toBe(false);
	await app.cancel(task);
}, 15000);

test("an occupied approved dependency-worktree path is quarantined, never adopted or overwritten", async () => {
	const { app, fake, invocation } = await setup();
	fake.setResponses([
		call("env_start", { apps: ["frontend"] }),
		call("request_review", {
			path: ".",
			title: "Hold occupied dependency path",
		}),
	]);
	const task = await app.startTask(invocation),
		review = await pendingReview(app, task);
	const plan = JSON.parse(review.snapshot).plans.find(
		(plan: { app: string }) => plan.app === "backend",
	);
	fs.mkdirSync(path.dirname(plan.workspace), { recursive: true, mode: 0o700 });
	fs.mkdirSync(plan.workspace);
	fs.writeFileSync(path.join(plan.workspace, "foreign-file"), "retain");
	await approve(app, task);
	await pendingReview(app, task, "Hold occupied dependency path");
	const state = await app.environments.snapshot();
	expect(state.runs.find((run) => run.plan.app === "backend")?.state).toBe(
		"interrupted",
	);
	expect(state.runs.some((run) => run.state === "running")).toBe(false);
	expect(
		fs.readFileSync(path.join(plan.workspace, "foreign-file"), "utf8"),
	).toBe("retain");
	await app.cancel(task);
}, 15000);

test("explicit foreign infrastructure retains one original generation across same-owner shared acquisitions and releases at the last root", async () => {
	const { app, fake, invocation, foreign } = await setup({
		infrastructure: true,
		secondRoot: true,
	});
	fake.setResponses([
		call("env_start", {
			apps: ["frontend"],
			lifetime: "shared-prerequisites-v1",
		}),
		call("request_review", {
			path: ".",
			title: "Hold first foreign reference",
		}),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold first foreign reference");
	const first = (await app.environments.snapshot()).runs.find(
		(run) => run.plan.app === "backend",
	);
	if (!first) throw new Error("Missing original infrastructure generation");
	fake.setResponses([
		call("env_start", {
			apps: ["second-frontend"],
			lifetime: "shared-prerequisites-v1",
		}),
		call("request_review", {
			path: ".",
			title: "Hold second foreign reference",
		}),
	]);
	await approve(app, task, "Hold first foreign reference");
	await approve(app, task);
	await pendingReview(app, task, "Hold second foreign reference");
	const attached = await app.environments.snapshot();
	expect(
		attached.runs.filter((run) => run.plan.app === "backend"),
	).toHaveLength(1);
	expect(attached.runs.every((run) => run.state === "running")).toBe(true);
	expect(attached.runs.find((run) => run.plan.app === "backend")?.id).toBe(
		first.id,
	);
	fake.setResponses([
		call("env_stop", { apps: ["frontend"] }),
		call("request_review", { path: ".", title: "Hold one foreign reference" }),
	]);
	await approve(app, task, "Hold second foreign reference");
	await pendingReview(app, task, "Hold one foreign reference");
	const retained = await app.environments.snapshot();
	expect(retained.runs.find((run) => run.plan.app === "frontend")?.state).toBe(
		"exited",
	);
	expect(
		retained.runs.find((run) => run.plan.app === "second-frontend")?.state,
	).toBe("running");
	expect(retained.runs.find((run) => run.id === first.id)?.state).toBe(
		"running",
	);
	expect(
		fs.existsSync(path.join(first.plan.workspace, "backend-stopped")),
	).toBe(false);
	fake.setResponses([
		call("env_stop", { apps: ["second-frontend"] }),
		call("request_review", { path: ".", title: "Hold no foreign references" }),
	]);
	await approve(app, task, "Hold one foreign reference");
	await pendingReview(app, task, "Hold no foreign references");
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
	expect(
		fs.existsSync(path.join(first.plan.workspace, "backend-stopped")),
	).toBe(true);
	expect(fs.existsSync(path.join(foreign, "backend-stopped"))).toBe(false);
	await app.cancel(task);
}, 20000);

test("authenticated checkout-mode operator tasks with the same root path get distinct owner-bound foreign worktrees", async () => {
	const { app, config, foreign } = await setup();
	const host = serve(app),
		url = new URL(host.url),
		token = new URLSearchParams(url.hash.slice(1)).get("token");
	const post = (route: string, input: unknown) =>
		fetch(new URL(route, url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(input),
		});
	const workspaces: string[] = [],
		owners: number[] = [];
	try {
		for (let index = 0; index < 2; index++) {
			const response = await post("/api/environments/actions", {
				apps: ["frontend"],
				action: "run",
				workspaceMode: "checkout",
				requestId: `operator-cross-repository-${index}`,
			});
			expect(response.status).toBe(200);
			const { taskId } = await response.json();
			const review = await pendingReview(app, taskId);
			expect(review.path).toBe(config.repositories[0] ?? "");
			await approve(app, taskId);
			const running = await eventually(
				() => app.environments.snapshot(),
				(state) =>
					state.runs.filter(
						(run) => run.owner === taskId && run.state === "running",
					).length === 2,
			);
			const backend = running.runs.find(
				(run) => run.owner === taskId && run.plan.app === "backend",
			);
			if (!backend) throw new Error("Missing operator prerequisite receipt");
			expect(backend.plan.dependencyWorkspace?.owner).toBe(taskId);
			workspaces.push(backend.plan.workspace);
			owners.push(taskId);
			expect((await post(`/api/tasks/${taskId}/cancel`, {})).status).toBe(200);
			await eventually(
				() => app.environments.snapshot(),
				(state) =>
					state.runs
						.filter((run) => run.owner === taskId)
						.every((run) => run.state === "exited"),
			);
		}
		expect(new Set(workspaces).size).toBe(2);
		expect(new Set(owners).size).toBe(2);
		expect(fs.readFileSync(path.join(foreign, "identity.txt"), "utf8")).toBe(
			"developer-dirty-content",
		);
	} finally {
		host.stop();
	}
}, 20000);

test("inherited Git repository selectors cannot redirect automatic native root or dependency checkout authority", async () => {
	const { app, fake, invocation, foreign } = await setup();
	const previous = {
		dir: process.env.GIT_DIR,
		tree: process.env.GIT_WORK_TREE,
		namespace: process.env.GIT_NAMESPACE,
	};
	process.env.GIT_DIR = path.join(foreign, ".git");
	process.env.GIT_WORK_TREE = foreign;
	process.env.GIT_NAMESPACE = "unrelated-fixture";
	try {
		fake.setResponses([
			call("env_start", { apps: ["frontend"] }),
			call("request_review", { path: ".", title: "Hold exact Git authority" }),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await pendingReview(app, task, "Hold exact Git authority");
		const state = await app.environments.snapshot(),
			frontend = state.runs.find((run) => run.plan.app === "frontend"),
			backend = state.runs.find((run) => run.plan.app === "backend");
		if (!frontend || !backend)
			throw new Error("Missing native checkout receipts");
		expect(
			fs.readFileSync(path.join(frontend.plan.workspace, "README.md"), "utf8"),
		).toBe("Initial\n");
		expect(
			fs.readFileSync(
				path.join(backend.plan.workspace, "identity.txt"),
				"utf8",
			),
		).toBe("captured-commit");
		expect(backend.plan.dependencyWorkspace?.repository).toBe(foreign);
		expect(backend.plan.dependencyWorkspace?.owner).toBe(task);
		await app.cancel(task);
	} finally {
		for (const [key, value] of [
			["GIT_DIR", previous.dir],
			["GIT_WORK_TREE", previous.tree],
			["GIT_NAMESPACE", previous.namespace],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}, 15000);

test("authenticated draft preflight refuses unknown prerequisite targets, cycles, duplicate edges and unauthorized repositories without granting workspace authority", async () => {
	const { app, config } = await setup();
	const host = serve(app),
		url = new URL(host.url),
		token = new URLSearchParams(url.hash.slice(1)).get("token");
	const post = (route: string, input: unknown) =>
		fetch(new URL(route, url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(input),
		});
	try {
		for (const mode of ["target", "cycle", "duplicate", "repository"]) {
			const definition = JSON.parse(
				fs.readFileSync(
					path.join(config.configDir, "environments.json"),
					"utf8",
				),
			);
			if (mode === "target")
				definition.projects[0].prerequisites[0].target = "unknown";
			if (mode === "cycle")
				definition.projects[1].prerequisites = [
					{ app: "frontend", target: "serve" },
				];
			if (mode === "duplicate")
				definition.projects[0].prerequisites.push({
					app: "backend",
					target: "serve",
				});
			if (mode === "repository")
				definition.projects[1].repository = path.join(
					config.stateDir,
					"not-authorized",
				);
			const response = await post("/api/environments/drafts", {
				requestId: `invalid-edge-${mode}`,
				content: JSON.stringify(definition),
			});
			expect(response.status).toBe(200);
			const staged = await response.json();
			const checked = await (
				await post("/api/environments/drafts/preflight", {
					requestId: `invalid-check-${mode}`,
					id: staged.id,
					revision: staged.revision,
					digest: staged.digest,
				})
			).json();
			expect(checked.completed).toBe(false);
			expect(checked.schemaAccepted).toBe(null);
		}
		expect(
			fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
		).toBe(false);
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
	} finally {
		host.stop();
	}
}, 15000);

test("target-scoped prerequisites expand only the selected run profile, not unrelated profiles of the same app", async () => {
	const { app, fake, invocation, config } = await setup({ targetScoped: true });
	fake.setResponses([
		call("env_start", { apps: ["frontend"], target: "standalone" }),
		call("request_review", { path: ".", title: "Hold unrelated profile" }),
	]);
	const task = await app.startTask(invocation),
		unrelated = await pendingReview(app, task);
	expect(JSON.parse(unrelated.snapshot).plans).toHaveLength(1);
	await approve(app, task);
	await pendingReview(app, task, "Hold unrelated profile");
	expect(
		(await app.environments.snapshot()).runs.filter(
			(run) => run.state === "running",
		),
	).toHaveLength(1);
	expect(
		fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
	).toBe(false);
	fake.setResponses([
		call("env_stop", { apps: ["frontend"] }),
		call("env_start", { apps: ["frontend"], target: "serve" }),
		call("request_review", {
			path: ".",
			title: "Hold selected prerequisite profile",
		}),
	]);
	await approve(app, task, "Hold unrelated profile");
	const selected = await pendingReview(app, task);
	expect(
		JSON.parse(selected.snapshot).plans.map(
			(plan: { app: string }) => plan.app,
		),
	).toEqual(["backend", "frontend"]);
	expect(
		fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
	).toBe(false);
	await approve(app, task);
	await pendingReview(app, task, "Hold selected prerequisite profile");
	expect(
		(await app.environments.snapshot()).runs.filter(
			(run) => run.state === "running",
		),
	).toHaveLength(2);
	await app.cancel(task);
}, 20000);
