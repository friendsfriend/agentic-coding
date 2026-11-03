import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import type { EnvironmentRun } from "../src/environment/state.ts";
import { git } from "../src/git.ts";
import { serve } from "../src/server.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((server) => server.stop(true)));
	}
});
const secret = "container-fixture-secret-only";
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function engine(config: Config) {
	return path.join(config.configDir, "engine.json");
}
function readEngine(config: Config) {
	return readEngineFile(engine(config));
}
function configure(config: Config) {
	fs.mkdirSync(config.configDir);
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	const source = `#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`;
	for (const name of ["docker", "podman"])
		fs.writeFileSync(path.join(bin, name), source, { mode: 0o700 });
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		`FIXTURE_TOKEN=${secret}\n`,
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		engine(config),
		JSON.stringify({ next: 1, containers: {}, history: [] }),
	);
	const server = serveContainerFixture(engine(config));
	engines.push(server);
	const common = {
		container: {
			socket: server.socket,
			image: "fixture:latest",
			name: "v2-fixture",
			command: ["serve"],
			ports: [{ host: 12345, container: 8080 }],
			mounts: [{ source: ".", target: "/workspace" }],
			readiness: "healthy",
		},
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: server.socket,
		},
		secretRefs: { SERVICE_TOKEN: "FIXTURE_TOKEN" },
	};
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					defaults: { run: "serve", build: "image-build", test: "image-test" },
					targets: [
						{
							...common,
							id: "serve",
							runtime: "docker",
							action: "run",
							timeoutMs: 5000,
						},
						{
							...common,
							id: "podman-serve",
							runtime: "podman",
							action: "run",
							timeoutMs: 5000,
						},
						{
							...common,
							id: "image-build",
							runtime: "docker",
							action: "build",
							profile: "ci",
							timeoutMs: 5000,
						},
						{
							...common,
							id: "image-test",
							runtime: "docker",
							action: "test",
							timeoutMs: 5000,
						},
					],
				},
				{
					id: "image-alias",
					kind: "library",
					repository: config.repositories[0],
					targets: [
						{
							...common,
							id: "alias-build",
							action: "build",
							runtime: "podman",
							container: {
								...common.container,
								image: "localhost/fixture:latest",
							},
						},
					],
				},
			],
		}),
	);
}

test("native container approvals select profiles/providers, fence ownership, redact streams and return actual build/test receipts", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fs.writeFileSync(
		path.join(invocation.repository, "Dockerfile"),
		"FROM scratch\n",
	);
	await git(invocation.repository, ["add", "Dockerfile"]);
	await git(invocation.repository, [
		"commit",
		"-m",
		"disposable fixture recipe",
	]);
	const listing = await app.environments.snapshot();
	expect(listing.projects[0]?.defaultTargets.build).toEqual({
		id: "image-build",
		reason: "declared",
	});
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "podman" }),
		call("request_review", { path: ".", title: "Hold container" }),
	]);
	const id = await app.startTask(invocation);
	const review = await pendingReview(app, id);
	expect(review.snapshot).toContain('"runtime": "podman"');
	expect(review.snapshot).not.toContain(secret);
	expect(readEngine(config).history).toHaveLength(0);
	await approve(app, id);
	await pendingReview(app, id, "Hold container");
	await eventually(
		() => app.environments.logs("api", id),
		(logs) => JSON.stringify(logs).includes("[REDACTED]"),
	);
	const run = (await app.environments.snapshot()).runs[0];
	expect(run?.state).toBe("running");
	expect(run?.ready).toBe(true);
	expect(run?.pid).toBeNull();
	const history = readEngine(config).history;
	expect(
		history.every(
			(args) => args[0] === "--url" && args[1]?.startsWith("unix:///"),
		),
	).toBe(true);
	expect(
		history.some(
			(args) => args.includes("--env") && args.includes("SERVICE_TOKEN"),
		),
	).toBe(true);
	expect(JSON.stringify(history)).not.toContain(secret);
	fake.setResponses([
		call("env_stop", { apps: ["api"] }),
		fauxAssistantMessage("No foreign resource stopped"),
	]);
	const foreign = await app.startTask({
		...invocation,
		requestId: "foreign-stop",
	});
	await app.harness.waitForTask(foreign as TaskId, context);
	expect(readEngine(config).history.some((args) => args[2] === "stop")).toBe(
		false,
	);
	await app.cancel(id);
	await app.harness.waitForTask(id as TaskId, context);
	expect(Object.keys(readEngine(config).containers)).toHaveLength(0);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
	let actionTranscript = "";
	fake.setResponses([
		call("env_build", { app: "api", profile: "ci" }),
		call("env_test", { app: "api" }),
		(transcript) => {
			actionTranscript = JSON.stringify(transcript.messages);
			return fauxAssistantMessage(
				"Container image built; isolated test exit 9",
			);
		},
	]);
	const actions = await app.startTask({
		...invocation,
		requestId: "container-actions",
	});
	await approve(app, actions, "Environment build: api");
	await approve(app, actions, "Environment test: api");
	await app.harness.waitForTask(actions as TaskId, context);
	expect(actionTranscript.length).toBeGreaterThan(0);
	expect(actionTranscript).not.toContain(secret);
	expect(actionTranscript).not.toContain("must-not-leak-machine-metadata");
	const runs = (await app.environments.snapshot()).runs;
	expect(runs.find((run) => run.plan.action === "build")?.exitCode).toBe(0);
	expect(runs.find((run) => run.plan.action === "test")?.exitCode).toBe(9);
	expect(runs.every((run) => run.state === "exited")).toBe(true);
	expect(Object.keys(readEngine(config).containers)).toHaveLength(0);
	expect(
		JSON.stringify(await app.environments.logs("api", actions)),
	).not.toContain(secret);
}, 20000);

test("metadata-only availability skips a missing client without probing engines or silently replacing declared defaults", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configure(config);
		const file = path.join(config.configDir, "environments.json");
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		const project = data.projects[0];
		delete project.defaults.run;
		project.targets = project.targets.filter(
			(target: { runtime: string }) => target.runtime !== "podman",
		);
		for (const target of project.targets)
			target.environment.PATH = path.join(config.configDir, "bin");
		project.targets.push({
			id: "shell-fallback",
			runtime: "shell",
			action: "run",
			command: "printf READY; exec /bin/sleep 30",
			readyText: "READY",
			environment: { HOME: config.stateDir },
		});
		fs.unlinkSync(path.join(config.configDir, "bin/docker"));
		fs.writeFileSync(file, JSON.stringify(data));
	});
	const listing = await app.environments.snapshot();
	expect(listing.projects[0]?.defaultTargets.run.id).toBe("shell-fallback");
	expect(listing.projects[0]?.defaultTargets.build.id).toBeNull();
	expect(listing.projects[0]?.defaultTargets.build.reason).toContain(
		"unavailable",
	);
	expect(
		listing.projects[0]?.targets.find((target) => target.id === "serve")
			?.availability,
	).toMatchObject({ eligible: false, probe: "not-performed" });
	expect(readEngine(config).history).toHaveLength(0);
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "docker" }),
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold fallback" }),
	]);
	const task = await app.startTask(invocation);
	const review = await pendingReview(app, task);
	expect(review.snapshot).toContain("shell-fallback");
	expect(readEngine(config).history).toHaveLength(0);
	await approve(app, task);
	await pendingReview(app, task, "Hold fallback");
	expect((await app.environments.snapshot()).runs[0]?.plan.runtime).toBe(
		"shell",
	);
	expect(readEngine(config).history).toHaveLength(0);
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
}, 10000);

test("redacted presentation cannot invent a shell readiness marker", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		configure(config);
		const file = path.join(config.configDir, "environments.json");
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		data.projects[0].defaults = { run: "marker" };
		data.projects[0].targets = [
			{
				id: "marker",
				runtime: "shell",
				action: "run",
				timeoutMs: 150,
				readyText: "[REDACTED]",
				command: "printf '%s\\n' \"$SERVICE_TOKEN\"; exec /bin/sleep 30",
				environment: { HOME: config.stateDir },
				secretRefs: { SERVICE_TOKEN: "FIXTURE_TOKEN" },
			},
		];
		fs.writeFileSync(file, JSON.stringify(data));
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		fauxAssistantMessage("No readiness was granted"),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	const run = (await app.environments.snapshot()).runs[0];
	expect(run?.state).toBe("exited");
	expect(run?.ready).not.toBe(true);
	const logs = JSON.stringify(await app.environments.logs("api", task));
	expect(logs).toContain("[REDACTED]");
	expect(logs).not.toContain(secret);
	expect(readEngine(config).history).toHaveLength(0);
}, 10000);

test("foreign containers are never adopted or removed and private machine metadata never becomes model output", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	const state = readEngine(config),
		id = "f".repeat(64);
	state.containers[id] = {
		Id: id,
		Name: "/v2-fixture",
		Config: {
			Labels: { foreign: "operator" },
			Env: ["TOKEN=must-not-leak-machine-metadata"],
		},
		State: { Running: true, ExitCode: 0 },
	};
	fs.writeFileSync(engine(config), JSON.stringify(state));
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		(transcript) => {
			expect(JSON.stringify(transcript.messages)).not.toContain(
				"must-not-leak-machine-metadata",
			);
			return fauxAssistantMessage("Foreign container not adopted");
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(readEngine(config).containers[id]?.State.Running).toBe(true);
	expect(
		readEngine(config).history.some((args) =>
			["create", "start", "stop", "rm"].includes(args[2] ?? ""),
		),
	).toBe(false);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
	expect(
		JSON.stringify(await app.environments.logs("api", task)),
	).not.toContain("must-not-leak-machine-metadata");
});

test("observation loss and changed ownership quarantine container slots rather than mutating replacements or claiming cleanup", async () => {
	for (const failure of [
		"offline",
		"replaceAfterStop",
		"replaceWithCopiedLabels",
	] as const) {
		const { app, config, fake, invocation } = await fixture(false, configure);
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("request_review", { path: ".", title: "Hold uncertain container" }),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await pendingReview(app, task, "Hold uncertain container");
		const state = readEngine(config);
		state[failure] = true;
		fs.writeFileSync(engine(config), JSON.stringify(state));
		await app.cancel(task);
		await app.harness.waitForTask(task as TaskId, context);
		const run = (await app.environments.snapshot()).runs[0];
		expect(run?.state).toBe("interrupted");
		expect(run?.exitCode).toBeNull();
		expect(run?.runtimeStatus?.state).toBe(
			failure === "offline" ? "unknown" : "stopped",
		);
		expect(run?.error).toContain("cleanup");
		expect(Object.keys(readEngine(config).containers)).toHaveLength(1);
		expect(readEngine(config).history.some((args) => args[2] === "rm")).toBe(
			false,
		);
		expect(
			JSON.stringify(await app.environments.logs("api", task)),
		).not.toContain(secret);
	}
}, 15000);

test("missing and unhealthy engine health never become readiness, and startup failure cleans only the live-created ID", async () => {
	for (const initialHealth of ["missing", "unhealthy"] as const) {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			configure(config);
			const file = path.join(config.configDir, "environments.json");
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			data.projects[0].targets[0].timeoutMs = 1000;
			fs.writeFileSync(file, JSON.stringify(data));
			const state = readEngine(config);
			state.initialHealth = initialHealth;
			fs.writeFileSync(engine(config), JSON.stringify(state));
		});
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			fauxAssistantMessage("Startup failed without granting readiness"),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await app.harness.waitForTask(task as TaskId, context);
		const run = (await app.environments.snapshot()).runs[0];
		expect(run?.ready).not.toBe(true);
		expect(run?.state).toBe("exited");
		expect(run?.runtimeStatus?.state).toBe("absent");
		expect(Object.keys(readEngine(config).containers)).toHaveLength(0);
		const logs = JSON.stringify(await app.environments.logs("api", task));
		expect(logs).toContain(
			initialHealth === "missing" ? "timed out" : "unhealthy",
		);
		expect(logs).not.toContain("must-not-leak-machine-metadata");
	}
}, 10000);

test("an interrupted image writer quarantines the shared daemon across providers, aliases and workspaces without inventing an exit result", async () => {
	const { app, config, fake, invocation } = await fixture(false, configure);
	fs.writeFileSync(
		path.join(invocation.repository, "Dockerfile"),
		"FROM scratch\n",
	);
	await git(invocation.repository, ["add", "Dockerfile"]);
	await git(invocation.repository, [
		"commit",
		"-m",
		"disposable build fixture",
	]);
	const state = readEngine(config);
	state.buildDelayMs = 1500;
	fs.writeFileSync(engine(config), JSON.stringify(state));
	fake.setResponses([call("env_build", { app: "api" })]);
	const first = await app.startTask(invocation);
	await approve(app, first);
	await eventually(
		async () => readEngine(config),
		(state) => state.history.some((args) => args[2] === "build"),
	);
	await app.cancel(first);
	await app.harness.waitForTask(first as TaskId, context);
	const interrupted = (await app.environments.snapshot()).runs[0];
	expect(interrupted?.state).toBe("interrupted");
	expect(interrupted?.exitCode).toBeNull();
	let successorTranscript = "";
	fake.setResponses([
		call("env_build", { app: "image-alias" }),
		(transcript) => {
			successorTranscript = JSON.stringify(transcript.messages);
			return fauxAssistantMessage("No competing image writer started");
		},
	]);
	const successor = await app.startTask({
		...invocation,
		requestId: "competing-image-writer",
	});
	await approve(app, successor);
	await app.harness.waitForTask(successor as TaskId, context);
	expect(successorTranscript).toContain("daemon image writer");
	expect(
		readEngine(config).history.filter((args) => args[2] === "build"),
	).toHaveLength(1);
	expect((await app.environments.snapshot()).runs).toHaveLength(1);
});

test("a killed container host never adopts saved IDs or invokes an engine during restart, cancellation or inspected release", async () => {
	const fixtureState = await fixture(true, configure);
	await fixtureState.app.close();
	apps.splice(apps.indexOf(fixtureState.app), 1);
	const inputFile = path.join(
			fixtureState.config.stateDir,
			"container-host-input.json",
		),
		readyFile = path.join(
			fixtureState.config.stateDir,
			"container-host-ready.json",
		);
	fs.writeFileSync(
		inputFile,
		JSON.stringify({
			config: fixtureState.config,
			invocation: fixtureState.invocation,
			readyFile,
		}),
	);
	const host = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/environment-host.ts"),
			inputFile,
		],
		{
			cwd: fixtureState.invocation.repository,
			env: { PATH: process.env.PATH, HOME: fixtureState.config.stateDir },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	try {
		await eventually(async () => fs.existsSync(readyFile), Boolean);
		const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
			id: number;
			run: EnvironmentRun;
		};
		const containerId = ready.run.runtimeStatus?.id;
		if (!containerId) throw new Error("Missing live creation receipt");
		const followers = readEngine(fixtureState.config).followers ?? [];
		expect(followers).toHaveLength(1);
		host.kill("SIGKILL");
		await host.exited;
		const before = readEngine(fixtureState.config).history;
		const restored = await fixtureState.open();
		const quarantined = (await restored.environments.snapshot()).runs[0];
		if (!quarantined) throw new Error("Missing interrupted container record");
		expect(quarantined).toMatchObject({
			state: "interrupted",
			exitCode: null,
			runtimeStatus: { id: containerId },
		});
		expect(
			readEngine(fixtureState.config).containers[containerId]?.State.Running,
		).toBe(true);
		await expect(
			restored.environments.stopOnce("crash-stop", ready.id, ["api"]),
		).rejects.toThrow("saved PID");
		await restored.cancel(ready.id);
		const cancelled = await restored.harness.waitForTask(
			ready.id as TaskId,
			context,
		);
		expect(cancelled.state.outcome).toMatchObject({
			status: "aborted",
			reason: expect.stringContaining("Resources remain quarantined"),
		});
		expect(readEngine(fixtureState.config).history).toEqual(before);
		// The test operator removes only this isolated engine's synthetic object and
		// closes that engine, which terminates its orphaned fixture log client.
		const state = readEngine(fixtureState.config);
		delete state.containers[containerId];
		fs.writeFileSync(engine(fixtureState.config), JSON.stringify(state));
		const ownedEngine = engines.find(
			(entry) => entry.socket === ready.run.plan.container?.socket,
		);
		if (!ownedEngine) throw new Error("Missing disposable engine handle");
		await ownedEngine.stop(true);
		await eventually(
			async () =>
				followers.every((pid) =>
					fs.existsSync(
						path.join(
							fixtureState.config.configDir,
							`fixture-client-${pid}.exited`,
						),
					),
				),
			Boolean,
		);
		const server = serve(restored);
		try {
			const url = new URL(server.url),
				endpoint = `${url.origin}/api/environments/release`;
			const headers = {
				Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			};
			const body = {
				id: quarantined.id,
				revision: quarantined.revision,
				inspectionConfirmed: true,
			};
			expect(
				(await fetch(endpoint, { method: "POST", body: JSON.stringify(body) }))
					.status,
			).toBe(401);
			expect(
				(
					await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify({ ...body, revision: body.revision - 1 }),
					})
				).status,
			).toBe(400);
			expect(
				(
					await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
			expect((await restored.environments.snapshot()).runs[0]).toMatchObject({
				state: "exited",
				exitCode: null,
				inspection: { revision: quarantined.revision },
			});
			expect(readEngine(fixtureState.config).history).toEqual(before);
		} finally {
			await server.stop();
		}
	} finally {
		if (host.exitCode === null) {
			host.kill("SIGTERM");
			await host.exited;
		}
	}
}, 20000);
