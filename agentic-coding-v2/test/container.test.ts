import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { type Config, digest } from "../src/config.ts";
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

function configureCompose(config: Config) {
	configure(config);
	const file = path.join(config.configDir, "environments.json");
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	const project = data.projects[0],
		base = project.targets[0];
	project.defaults = { run: "stack" };
	project.targets = [
		{
			id: "stack",
			action: "run",
			runtime: "compose",
			timeoutMs: 5000,
			environment: base.environment,
			secretRefs: base.secretRefs,
			compose: {
				file: "deploy/compose.yaml",
				provider: "docker",
				socket: base.container.socket,
			},
		},
	];
	data.projects = [project];
	fs.writeFileSync(file, JSON.stringify(data));
}
async function composeFile(repository: string, body: string) {
	fs.mkdirSync(path.join(repository, "deploy"), { recursive: true });
	fs.writeFileSync(path.join(repository, "deploy/compose.yaml"), body);
	await git(repository, ["add", "deploy/compose.yaml"]);
	await git(repository, ["commit", "-m", "disposable Compose fixture"]);
}
const stackYaml =
	"services:\n  web:\n    image: fixture:latest\n    command: [serve]\n    volumes:\n      - type: bind\n        source: .\n        target: /workspace\n  worker:\n    image: fixture:latest\n    command: [serve]\n";

test("Compose approval gates the complete stack and cancellation releases its owned resources", async () => {
	const { app, config, fake, invocation } = await fixture(
		false,
		configureCompose,
	);
	await composeFile(
		invocation.repository,
		stackYaml
			.replace(
				"  web:\n",
				'  web:\n    environment:\n      LOG_LINE: "[worker]\\nweb-spoof"\n',
			)
			.replace(
				"  worker:\n",
				'  worker:\n    environment:\n      LOG_LINE: "[web]\\nworker-spoof"\n',
			),
	);
	let selectedOutput = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "compose" }),
		call("request_review", { path: ".", title: "Hold stack" }),
		call("env_logs", { app: "api", service: "worker", grep: "spoof", tail: 1 }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_logs")
					continue;
				for (const part of message.content)
					if (part.type === "text")
						selectedOutput = JSON.parse(part.text).runs[0]?.output ?? "";
			}
			return call("request_review", { path: ".", title: "Hold service logs" });
		},
	]);
	const task = await app.startTask(invocation);
	const review = await pendingReview(app, task);
	expect(review.snapshot).not.toContain(secret);
	expect(readEngine(config).history).toHaveLength(0);
	await approve(app, task);
	await pendingReview(app, task, "Hold stack");
	const run = (await app.environments.snapshot()).runs[0];
	expect(run?.state).toBe("running");
	expect(run?.runtimeStatuses).toHaveLength(3);
	expect(
		run?.runtimeStatuses?.every(
			(status) => status.owned === true && status.state === "running",
		),
	).toBe(true);
	await eventually(
		() => app.environments.logs("api", task),
		(logs) => JSON.stringify(logs).includes("[REDACTED]"),
	);
	await eventually(
		() =>
			app.environments.selectedLogs("api", task, {
				service: "worker",
				grep: "spoof",
			}),
		(view) => view.runs[0]?.output === "worker-spoof\n",
	);
	await approve(app, task, "Hold stack");
	await pendingReview(app, task, "Hold service logs");
	expect(selectedOutput).toBe("worker-spoof\n");
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(
		(
			await app.environments.selectedLogs("api", task, {
				service: "worker",
				grep: "spoof",
			})
		).runs[0]?.output,
	).toBe("worker-spoof\n");
	const missing = (
		await app.environments.selectedLogs("api", task, {
			service: "not-a-service",
		})
	).runs[0];
	expect(missing?.sourceAvailability).toBe("not-declared");
	expect(missing?.output).toBe("");
	expect(Object.keys(readEngine(config).containers)).toHaveLength(0);
	expect(Object.keys(readEngine(config).networks ?? {})).toHaveLength(0);
	expect(
		JSON.stringify(await app.environments.logs("api", task)),
	).not.toContain("must-not-leak-private-network-metadata");
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
}, 15000);

test("Compose source changes and colliding service ports fail before any engine command", async () => {
	for (const variant of ["changed", "collision"]) {
		const { app, config, fake, invocation } = await fixture(
			false,
			configureCompose,
		);
		const body =
			variant === "collision"
				? stackYaml.replaceAll(
						"    command: [serve]",
						"    command: [serve]\n    ports:\n      - target: 8080\n        published: 12345",
					)
				: stackYaml;
		await composeFile(invocation.repository, body);
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			fauxAssistantMessage("No stack effects"),
		]);
		const task = await app.startTask(invocation);
		await pendingReview(app, task);
		if (variant === "changed") {
			const snapshot = JSON.parse((await pendingReview(app, task)).snapshot);
			const owner = snapshot.plans[0];
			fs.appendFileSync(
				path.join(owner.workspace, "deploy/compose.yaml"),
				"# changed after approval snapshot\n",
			);
		}
		await approve(app, task);
		await app.harness.waitForTask(task as TaskId, context);
		expect(readEngine(config).history).toHaveLength(0);
		expect(
			(await app.environments.snapshot()).runs.every(
				(run) => run.state === "exited",
			),
		).toBe(true);
	}
}, 15000);

test("Compose partial startup rolls back live receipts but never stops an existing second service", async () => {
	const { app, config, fake, invocation } = await fixture(
		false,
		configureCompose,
	);
	await composeFile(invocation.repository, stackYaml);
	const foreignId = "f".repeat(64),
		state = readEngine(config);
	state.containers[foreignId] = {
		Id: foreignId,
		Name: `/acv2-api-worker-${digest(config.stateDir).slice(0, 8)}`,
		Config: { Labels: { foreign: "operator" }, Env: [] },
		State: { Running: true, ExitCode: 0 },
	};
	fs.writeFileSync(engine(config), JSON.stringify(state));
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		fauxAssistantMessage("Foreign service preserved"),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	const after = readEngine(config);
	expect(Object.keys(after.containers)).toEqual([foreignId]);
	expect(after.containers[foreignId]?.State.Running).toBe(true);
	expect(
		after.history
			.filter((args) => ["stop", "rm"].includes(args[2] ?? ""))
			.every((args) => !args.includes(foreignId)),
	).toBe(true);
	expect(after.history.filter((args) => args[2] === "rm")).toHaveLength(1);
}, 10000);

test("Compose unsupported effects are refused, and daemon loss quarantines the complete stack", async () => {
	for (const field of [
		"networks: [external]",
		"privileged: true",
		"restart: always",
		"build: .",
	]) {
		const { app, config, fake, invocation } = await fixture(
			false,
			configureCompose,
		);
		await composeFile(
			invocation.repository,
			stackYaml.replace(
				"    image: fixture:latest",
				`    ${field}\n    image: fixture:latest`,
			),
		);
		let transcript = "";
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			(messages) => {
				transcript = JSON.stringify(messages.messages);
				return fauxAssistantMessage("Unsupported effects refused");
			},
		]);
		const task = await app.startTask(invocation);
		await app.harness.waitForTask(task as TaskId, context);
		expect(transcript).toContain("Unsupported Compose field");
		expect(readEngine(config).history).toHaveLength(0);
	}
	const { app, config, fake, invocation } = await fixture(
		false,
		configureCompose,
	);
	await composeFile(invocation.repository, stackYaml);
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold uncertain stack" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold uncertain stack");
	const state = readEngine(config);
	state.offline = true;
	fs.writeFileSync(engine(config), JSON.stringify(state));
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	const run = (await app.environments.snapshot()).runs[0];
	expect(run?.state).toBe("interrupted");
	expect(run?.exitCode).toBeNull();
	expect(run?.runtimeStatuses).toHaveLength(3);
	expect(Object.keys(readEngine(config).containers)).toHaveLength(2);
	expect(readEngine(config).history.some((args) => args[2] === "rm")).toBe(
		false,
	);
}, 20000);

test("Compose shared networks refuse foreign occupancy, copied-label replacement, foreign attachments and lost creation receipts", async () => {
	for (const variant of ["foreign", "replacement", "attachment", "receipt"]) {
		const { app, config, fake, invocation } = await fixture(
			false,
			configureCompose,
		);
		await composeFile(invocation.repository, stackYaml);
		if (variant === "foreign" || variant === "receipt") {
			const state = readEngine(config);
			if (variant === "foreign") {
				const id = "e".repeat(64);
				state.networks = {
					[id]: {
						Id: id,
						Name: `acv2-api-${digest(config.stateDir).slice(0, 8)}-default`,
						Labels: { foreign: "operator" },
						Containers: {},
					},
				};
			} else state.invalidNetworkReceipt = true;
			fs.writeFileSync(engine(config), JSON.stringify(state));
			fake.setResponses([
				call("env_start", { apps: ["api"] }),
				fauxAssistantMessage("No network adoption"),
			]);
		} else
			fake.setResponses([
				call("env_start", { apps: ["api"] }),
				call("request_review", { path: ".", title: "Hold network fixture" }),
			]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		if (variant === "replacement" || variant === "attachment") {
			await pendingReview(app, task, "Hold network fixture");
			const state = readEngine(config),
				network = Object.values(state.networks ?? {})[0];
			if (!network) throw new Error("Missing fixture network");
			if (variant === "replacement") {
				delete state.networks?.[network.Id];
				network.Id = "d".repeat(64);
				state.networks ??= {};
				state.networks[network.Id] = network;
			} else
				network.Containers["c".repeat(64)] = { Name: "operator-attachment" };
			fs.writeFileSync(engine(config), JSON.stringify(state));
			await app.cancel(task);
		}
		await app.harness.waitForTask(task as TaskId, context);
		const state = readEngine(config),
			run = (await app.environments.snapshot()).runs[0];
		expect(Object.keys(state.networks ?? {})).toHaveLength(1);
		expect(
			state.history.some((args) => args[2] === "network" && args[3] === "rm"),
		).toBe(false);
		expect(
			state.history.some(
				(args) => args.includes("disconnect") || args.includes("--force"),
			),
		).toBe(false);
		expect(run?.state).toBe(variant === "foreign" ? "exited" : "interrupted");
		expect(Object.keys(state.containers)).toHaveLength(0);
		if (variant === "foreign")
			expect(
				state.history.some(
					(args) =>
						args[2] === "create" ||
						(args[2] === "network" && args[3] === "create"),
				),
			).toBe(false);
	}
}, 20000);

test("Podman Compose requires explicit isolated mode rather than inventing network receipt authority", async () => {
	for (const network of ["shared", "isolated"]) {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			configureCompose(config);
			const file = path.join(config.configDir, "environments.json"),
				data = JSON.parse(fs.readFileSync(file, "utf8"));
			data.projects[0].targets[0].compose.provider = "podman";
			data.projects[0].targets[0].compose.network = network;
			fs.writeFileSync(file, JSON.stringify(data));
		});
		await composeFile(invocation.repository, stackYaml);
		const listing = await app.environments.snapshot();
		if (network === "shared") {
			expect(listing.projects[0]?.targets[0]?.availability?.eligible).toBe(
				false,
			);
			fake.setResponses([
				call("env_start", { apps: ["api"] }),
				fauxAssistantMessage("No unsupported shared network effect"),
			]);
			const task = await app.startTask(invocation);
			await app.harness.waitForTask(task as TaskId, context);
			expect(readEngine(config).history).toHaveLength(0);
		} else {
			fake.setResponses([
				call("env_start", { apps: ["api"] }),
				call("request_review", {
					path: ".",
					title: "Hold isolated Podman stack",
				}),
			]);
			const task = await app.startTask(invocation);
			const review = await pendingReview(app, task);
			expect(review.snapshot).toContain('"network": "isolated"');
			await approve(app, task);
			await pendingReview(app, task, "Hold isolated Podman stack");
			expect(Object.keys(readEngine(config).containers)).toHaveLength(2);
			expect(Object.keys(readEngine(config).networks ?? {})).toHaveLength(0);
			expect((await app.environments.snapshot()).runs[0]?.ready).toBe(true);
			await app.cancel(task);
			await app.harness.waitForTask(task as TaskId, context);
			expect(Object.keys(readEngine(config).containers)).toHaveLength(0);
		}
	}
}, 15000);

test("Compose web can discover its ready worker, and an unavailable prerequisite never yields a ready stack", async () => {
	for (const scenario of [
		"ready",
		"missing-health",
		"lost-start-response",
	] as const) {
		const available = scenario === "ready";
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			configureCompose(config);
			const file = path.join(config.configDir, "environments.json"),
				data = JSON.parse(fs.readFileSync(file, "utf8"));
			data.projects[0].targets[0].timeoutMs = available ? 5000 : 2000;
			fs.writeFileSync(file, JSON.stringify(data));
			const state = readEngine(config);
			state.workloadPrerequisite = "healthy";
			if (scenario === "missing-health") {
				state.initialHealth = "missing";
				state.inspectDelayMs = 100;
			}
			if (scenario === "lost-start-response") state.startDelayMs = 3000;
			fs.writeFileSync(engine(config), JSON.stringify(state));
		});
		await composeFile(
			invocation.repository,
			stackYaml.replace(
				"    command: [serve]",
				"    command: [serve]\n    depends_on:\n      worker:\n        condition: service_healthy",
			),
		);
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			available
				? call("request_review", {
						path: ".",
						title: "Keep connected app running",
					})
				: fauxAssistantMessage("Unavailable prerequisite prevented startup"),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		if (available) {
			await pendingReview(app, task, "Keep connected app running");
			expect((await app.environments.snapshot()).runs[0]?.ready).toBe(true);
			expect(
				Object.values(readEngine(config).containers).filter(
					(container) => container.State.Running,
				),
			).toHaveLength(2);
			await app.cancel(task);
		}
		await app.harness.waitForTask(task as TaskId, context);
		const state = readEngine(config),
			run = (await app.environments.logs("api", task, true))[0];
		if (!available) expect(run?.ready).not.toBe(true);
		expect(Object.keys(state.containers)).toHaveLength(0);
		expect(Object.keys(state.networks ?? {})).toHaveLength(0);
		expect(
			run?.state,
			JSON.stringify({
				scenario,
				error: run?.error,
				runtimeStatuses: run?.runtimeStatuses,
				serviceLogs: run?.serviceLogs,
				output: run?.output,
			}),
		).toBe(scenario === "lost-start-response" ? "interrupted" : "exited");
		if (scenario === "lost-start-response") {
			expect(run?.output).toContain(
				"Mutating environment CLI failed or was interrupted; remote effects remain uncertain",
			);
			expect(run?.output).not.toContain(secret);
			expect(
				run?.runtimeStatuses?.every((status) => status.state === "absent"),
			).toBe(true);
			await expect(
				app.environments.stopOnce("refuse-uncertain-compose", task, ["api"]),
			).rejects.toThrow();
			expect(readEngine(config).history).toEqual(state.history);
		}
	}
}, 20000);

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

test("killed container and Compose hosts never adopt saved IDs or invoke an engine during restart, cancellation or inspected release", async () => {
	for (const runtime of ["container", "compose"]) {
		const fixtureState = await fixture(
			true,
			runtime === "compose" ? configureCompose : configure,
		);
		if (runtime === "compose")
			await composeFile(fixtureState.invocation.repository, stackYaml);
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
				target: runtime === "compose" ? "stack" : "serve",
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
			const statuses =
				ready.run.runtimeStatuses ??
				(ready.run.runtimeStatus ? [ready.run.runtimeStatus] : []);
			const containerIds = statuses
				.filter((status) => status.kind !== "network")
				.flatMap((status) => (status.id ? [status.id] : []));
			const networkIds = statuses
				.filter((status) => status.kind === "network")
				.flatMap((status) => (status.id ? [status.id] : []));
			expect(containerIds).toHaveLength(runtime === "compose" ? 2 : 1);
			expect(networkIds).toHaveLength(runtime === "compose" ? 1 : 0);
			const followers = readEngine(fixtureState.config).followers ?? [];
			expect(followers).toHaveLength(runtime === "compose" ? 2 : 1);
			host.kill("SIGKILL");
			await host.exited;
			const before = readEngine(fixtureState.config).history;
			const restored = await fixtureState.open();
			const quarantined = (await restored.environments.snapshot()).runs[0];
			if (!quarantined) throw new Error("Missing interrupted container record");
			expect(quarantined).toMatchObject({
				state: "interrupted",
				exitCode: null,
			});
			const savedStatuses =
				quarantined.runtimeStatuses ??
				(quarantined.runtimeStatus ? [quarantined.runtimeStatus] : []);
			expect(savedStatuses.map((status) => status.id)).toEqual(
				statuses.map((status) => status.id),
			);
			expect(
				savedStatuses.every(
					(status) =>
						status.state === "unknown" &&
						status.owned === null &&
						status.health === null,
				),
			).toBe(true);
			expect(
				containerIds.every(
					(id) =>
						readEngine(fixtureState.config).containers[id]?.State.Running ===
						true,
				),
			).toBe(true);
			expect(
				networkIds.every((id) =>
					Boolean(readEngine(fixtureState.config).networks?.[id]),
				),
			).toBe(true);
			await restored.tick(Date.now() + 31 * 60_000);
			const protectedRun = (await restored.environments.snapshot()).runs[0];
			expect(protectedRun?.state).toBe("interrupted");
			expect(protectedRun?.idle.protection).toBeTruthy();
			expect(readEngine(fixtureState.config).history).toEqual(before);
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
			for (const id of containerIds) delete state.containers[id];
			for (const id of networkIds) delete state.networks?.[id];
			fs.writeFileSync(engine(fixtureState.config), JSON.stringify(state));
			const ownedEngine = engines.find(
				(entry) =>
					entry.socket ===
					(ready.run.plan.container?.socket ?? ready.run.plan.compose?.socket),
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
					(
						await fetch(endpoint, {
							method: "POST",
							body: JSON.stringify(body),
						})
					).status,
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
	}
}, 35000);
