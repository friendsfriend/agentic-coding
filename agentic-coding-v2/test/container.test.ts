import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { git } from "../src/git.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		for (const server of engines.splice(0)) server.stop(true);
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
			socket: path.join(config.configDir, "disposable-fixture.sock"),
			image: "fixture:latest",
			name: "v2-fixture",
			command: ["serve"],
			ports: [{ host: 12345, container: 8080 }],
			mounts: [{ source: ".", target: "/workspace" }],
			readiness: "healthy",
		},
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_URL: `http://127.0.0.1:${server.port}`,
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
							runtime: "docker",
							container: {
								...common.container,
								image: "index.docker.io/library/fixture",
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
	fake.setResponses([
		call("env_build", { app: "api", profile: "ci" }),
		call("env_test", { app: "api" }),
		(transcript) => {
			const messages = JSON.stringify(transcript.messages);
			expect(messages).not.toContain(secret);
			expect(messages).not.toContain("must-not-leak-machine-metadata");
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
	const runs = (await app.environments.snapshot()).runs;
	expect(runs.find((run) => run.plan.action === "build")?.exitCode).toBe(0);
	expect(runs.find((run) => run.plan.action === "test")?.exitCode).toBe(9);
	expect(runs.every((run) => run.state === "exited")).toBe(true);
	expect(Object.keys(readEngine(config).containers)).toHaveLength(0);
	expect(
		JSON.stringify(await app.environments.logs("api", actions)),
	).not.toContain(secret);
}, 20000);

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

test("an interrupted image writer quarantines the daemon-global tag across task workspaces without inventing an exit result", async () => {
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
	fake.setResponses([
		call("env_build", { app: "image-alias" }),
		(transcript) => {
			expect(JSON.stringify(transcript.messages)).toContain(
				"container image tag",
			);
			return fauxAssistantMessage("No competing image writer started");
		},
	]);
	const successor = await app.startTask({
		...invocation,
		requestId: "competing-image-writer",
	});
	await approve(app, successor);
	await app.harness.waitForTask(successor as TaskId, context);
	expect(
		readEngine(config).history.filter((args) => args[2] === "build"),
	).toHaveLength(1);
	expect((await app.environments.snapshot()).runs).toHaveLength(1);
});
