// Runtime-general lifetimes and last-reference release across acquisitions,
// observed through the synthetic container/Compose engine and fixture shell roots.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { git } from "../src/git.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((engine) => engine.stop(true)));
	}
});
type Subject = Awaited<ReturnType<typeof fixture>>;
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const starts = (config: Config) =>
	fs.existsSync(path.join(config.configDir, "starts"))
		? fs
				.readFileSync(path.join(config.configDir, "starts"), "utf8")
				.trim()
				.split("\n")
		: [];
const history = (config: Config) =>
	readEngineFile(path.join(config.configDir, "engine.json")).history;
const verbs = (config: Config, verb: string) =>
	history(config).filter(
		(argv) =>
			argv.includes(verb) &&
			!argv.includes("network") &&
			(verb !== "create" || argv.includes("--name")),
	).length;
const texts = (value: unknown, tool: string) =>
	(value as { messages: { role: string; toolName?: string }[] }).messages
		.filter(
			(message) => message.role === "toolResult" && message.toolName === tool,
		)
		.map((message) =>
			(message as unknown as { content: { text?: string }[] }).content
				.map((block) => block.text ?? "")
				.join(""),
		);
const snapshot = (subject: Subject) => subject.app.environments.snapshot();
const running = async (subject: Subject) =>
	(await snapshot(subject)).runs
		.filter((run) => run.state === "running")
		.map((run) => run.plan.app)
		.sort();
const settled = async (subject: Subject) =>
	(await snapshot(subject)).runs.every((run) => run.state === "exited");
type Options = { requires: string[]; composeCommand?: string[] };
/** One shell root per app declaration plus the declared prerequisite each names. */
async function configure(config: Config, options: Options) {
	fs.mkdirSync(config.configDir, { recursive: true });
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	for (const name of ["docker", "podman"])
		fs.writeFileSync(
			path.join(bin, name),
			`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`,
			{ mode: 0o700 },
		);
	const state = path.join(config.configDir, "engine.json");
	fs.writeFileSync(
		state,
		JSON.stringify({ next: 1, containers: {}, history: [] }),
	);
	const engine = serveContainerFixture(state);
	engines.push(engine);
	writeDefinition(config, engine.socket, bin, options);
	return config;
}
/** Stack content is compiled into the approved plan from the task workspace, so
 * rewriting it there changes the plan a later acquisition approves. */
function writeCompose(directory: string, command: string[]) {
	fs.writeFileSync(
		path.join(directory, "compose.yaml"),
		Bun.YAML.stringify({
			services: { web: { image: "fixture:latest", command } },
		}),
	);
}
async function commitCompose(directory: string) {
	await git(directory, ["add", "compose.yaml"]);
	await git(directory, ["commit", "-m", "Disposable stack content"]);
}
function writeDefinition(
	config: Config,
	socket: string,
	bin: string,
	options: Options,
) {
	const command = (id: string) =>
		`${JSON.stringify(process.execPath)} -e ${JSON.stringify(
			`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(config.configDir, "starts"))},${JSON.stringify(`${id}\n`)});console.log('READY');setInterval(()=>{},1000)`,
		)}`;
	const root = (id: string) => ({
		id,
		kind: "app",
		repository: config.repositories[0],
		requires: options.requires,
		defaults: { run: "serve" },
		targets: [
			{
				id: "serve",
				action: "run",
				runtime: "shell",
				timeoutMs: 10000,
				readyText: "READY",
				command: command(id),
				environment: {},
			},
		],
	});
	const environment = {
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		FIXTURE_ENGINE_SOCKET: socket,
	};
	const prerequisites = options.requires.map((id) => ({
		id,
		kind: "infrastructure",
		repository: config.repositories[0],
		defaults: { run: "serve" },
		targets: [
			{
				id: "serve",
				action: "run",
				timeoutMs: 10000,
				environment,
				...(id === "stack"
					? {
							runtime: "compose",
							compose: { file: "compose.yaml", provider: "docker", socket },
						}
					: {
							runtime: "docker",
							container: {
								socket,
								image: "fixture:latest",
								name: "lifetime-database",
								command: ["serve"],
								readiness: "healthy",
							},
						}),
			},
		],
	}));
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [root("api"), root("worker"), ...prerequisites],
		}),
	);
}
test("a Compose prerequisite is started once and released with the last reference", async () => {
	const subject = await fixture(false, (config) =>
		configure(config, { requires: ["stack"] }),
	);
	writeCompose(subject.config.repositories[0] ?? "", ["serve"]);
	await commitCompose(subject.config.repositories[0] ?? "");
	let afterStart: string[] = [],
		states: string[] = [];
	subject.fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 2,
			);
			afterStart = await running(subject);
			return call("env_stop", { apps: ["api"] });
		},
		async () => {
			await eventually(
				() => settled(subject),
				(done) => done,
			);
			states = (await snapshot(subject)).runs.map((run) => run.state);
			return fauxAssistantMessage("Compose lifetime finished", {
				stopReason: "stop",
			});
		},
	]);
	const owner = await subject.app.startTask(subject.invocation);
	await approve(subject.app, owner);
	await eventually(
		async () => (await snapshot(subject)).runs.length,
		(count) => count === 2,
	);
	await eventually(
		() => settled(subject),
		(done) => done,
	);
	expect(afterStart).toEqual(["api", "stack"]);
	// Stopping the only root releases the prerequisite it declared.
	expect(states).toEqual(["exited", "exited"]);
	expect(starts(subject.config)).toEqual(["api"]);
	expect(verbs(subject.config, "create")).toBe(1);
	expect(verbs(subject.config, "rm")).toBe(1);
}, 60000);

test("a shared prerequisite approved with changed stack content is not adopted by name", async () => {
	const subject = await fixture(false, (config) =>
		configure(config, { requires: ["stack"] }),
	);
	writeCompose(subject.config.repositories[0] ?? "", ["serve"]);
	await commitCompose(subject.config.repositories[0] ?? "");
	let refused: string[] = [];
	subject.fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 2,
			);
			writeCompose((await snapshot(subject)).runs[0]?.plan.workspace ?? "", [
				"serve",
				"--changed",
			]);
			return call("env_start", {
				apps: ["worker"],
				lifetime: "shared-prerequisites-v1",
			});
		},
		async (value) => {
			refused = texts(value, "env_start");
			return fauxAssistantMessage("Changed plan refused", {
				stopReason: "stop",
			});
		},
	]);
	const owner = await subject.app.startTask(subject.invocation);
	await approve(subject.app, owner);
	const worker = approve(subject.app, owner, "Environment run: worker");
	await eventually(
		async () => refused.length,
		(count) => count === 2,
	);
	await worker;
	expect(refused[1]).toContain(
		"Shared prerequisite stack generation was approved with a different plan",
	);
	// The live stack is neither adopted under the new approval nor duplicated.
	expect(verbs(subject.config, "create")).toBe(1);
	expect(starts(subject.config)).toEqual(["api"]);
	expect(
		(await snapshot(subject)).runs.filter((run) => run.plan.app === "worker"),
	).toHaveLength(0);
}, 60000);

test("an owned container prerequisite is shared across acquisitions and released with the last reference", async () => {
	const subject = await fixture(false, (config) =>
		configure(config, { requires: ["database"] }),
	);
	let afterFirst: string[] = [];
	subject.fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 2,
			);
			return call("env_start", {
				apps: ["worker"],
				lifetime: "shared-prerequisites-v1",
			});
		},
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 3,
			);
			return call("env_stop", { apps: ["api"] });
		},
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 2,
			);
			afterFirst = await running(subject);
			return call("env_stop", { apps: ["worker"] });
		},
		async () => {
			await eventually(
				() => settled(subject),
				(settled) => settled,
			);
			return fauxAssistantMessage("Container lifetime finished", {
				stopReason: "stop",
			});
		},
	]);
	const owner = await subject.app.startTask(subject.invocation);
	await approve(subject.app, owner);
	await approve(subject.app, owner, "Environment run: worker");
	await eventually(
		() => settled(subject),
		(done) => done,
	);
	// The prerequisite survives its first root and is removed with the last one.
	expect(afterFirst).toEqual(["database", "worker"]);
	expect(verbs(subject.config, "create")).toBe(1);
	expect(verbs(subject.config, "rm")).toBe(1);
}, 60000);

test("independent lifetimes refuse a root with declared dependencies", async () => {
	const subject = await fixture(false, (config) =>
		configure(config, { requires: ["database"] }),
	);
	let refused: string[] = [];
	subject.fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "independent-roots-v1" }),
		async (value) => {
			refused = texts(value, "env_start");
			return fauxAssistantMessage("Dependency refused", { stopReason: "stop" });
		},
	]);
	await subject.app.startTask(subject.invocation);
	await eventually(
		async () => refused.length,
		(count) => count === 1,
	);
	expect(refused[0]).toContain(
		"Independent lifetimes require one approved request of agent-owned standalone app roots without declared dependencies",
	);
	expect(verbs(subject.config, "create")).toBe(0);
	expect((await snapshot(subject)).runs).toHaveLength(0);
}, 60000);
