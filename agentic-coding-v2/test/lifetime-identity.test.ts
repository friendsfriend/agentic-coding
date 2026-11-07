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
type Options = {
	requires: string[];
	composeCommand?: string[];
	chain?: boolean;
};
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
	const prerequisites = options.requires.map((id, index) => ({
		id,
		kind: "infrastructure",
		repository: config.repositories[0],
		defaults: { run: "serve" },
		// Optional declared chain: the first prerequisite requires the next one.
		...(options.chain && index === 0
			? { requires: options.requires.slice(1) }
			: {}),
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
								name: `lifetime-${id}`,
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
			projects: [root("api"), root("worker"), root("probe"), ...prerequisites],
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

test("a released shared prerequisite is started fresh for a later cycle and shared again", async () => {
	const subject = await fixture(false, (config) =>
		configure(config, { requires: ["database"] }),
	);
	const generations = async () =>
		(await snapshot(subject)).runs
			.filter((run) => run.plan.app === "database")
			.map((run) => `${run.id}:${run.state}`);
	let firstCycle: string[] = [],
		secondCycle: string[] = [],
		attached: string[] = [],
		afterWorkerRelease: string[] = [];
	subject.fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 2,
			);
			firstCycle = await generations();
			return call("env_stop", { apps: ["api"] });
		},
		async () => {
			// The last reference released the prerequisite, so a later acquisition
			// must start its own generation instead of attaching to the exit.
			await eventually(
				async () => (await generations()).length,
				(count) => count === 1,
			);
			await eventually(
				() => settled(subject),
				(done) => done,
			);
			return call("env_start", {
				apps: ["worker"],
				lifetime: "shared-prerequisites-v1",
			});
		},
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 2,
			);
			secondCycle = await generations();
			return call("env_start", {
				apps: ["probe"],
				lifetime: "shared-prerequisites-v1",
			});
		},
		async () => {
			// The later cycle is itself attachable: one new root, no new prerequisite.
			await eventually(
				() => running(subject),
				(apps) => apps.length === 3,
			);
			attached = await running(subject);
			return call("env_stop", { apps: ["worker"] });
		},
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 2,
			);
			afterWorkerRelease = await running(subject);
			return call("env_stop", { apps: ["probe"] });
		},
		async () => {
			await eventually(
				async () =>
					(await snapshot(subject)).runs.filter(
						(run) => run.state === "running",
					).length,
				(count) => count === 0,
			);
			return fauxAssistantMessage("Lifetime cycles finished", {
				stopReason: "stop",
			});
		},
	]);
	const owner = await subject.app.startTask(subject.invocation);
	await approve(subject.app, owner);
	await approve(subject.app, owner, "Environment run: worker");
	await approve(subject.app, owner, "Environment run: probe");
	await eventually(
		async () => (await generations()).length,
		(count) => count === 2,
	);
	await eventually(
		() => settled(subject),
		(done) => done,
	);
	// Cycle one released its generation; cycle two started a different one, which
	// the third acquisition attached to instead of duplicating.
	expect(firstCycle[0]?.endsWith(":running")).toBe(true);
	expect(secondCycle[0]?.endsWith(":exited")).toBe(true);
	expect(secondCycle[1]?.endsWith(":running")).toBe(true);
	expect(secondCycle[1]?.split(":")[0]).not.toBe(firstCycle[0]?.split(":")[0]);
	expect(attached).toEqual(["database", "probe", "worker"]);
	// A released root keeps no reference, so the shared generation outlives it.
	expect(afterWorkerRelease).toEqual(["database", "probe"]);
	expect(verbs(subject.config, "create")).toBe(2);
	expect(verbs(subject.config, "rm")).toBe(2);
	expect(starts(subject.config)).toEqual(["api", "worker", "probe"]);
}, 90000);

test("a transitive shared chain is attached once across acquisitions and released dependency first", async () => {
	const subject = await fixture(false, (config) =>
		configure(config, { requires: ["database", "cache"], chain: true }),
	);
	const containerId = (app: string) => {
		const containers = readEngineFile(
			path.join(subject.config.configDir, "engine.json"),
		).containers as Record<string, { Name: string }>;
		const entry = Object.entries(containers).find(
			([, value]) => value.Name === `/lifetime-${app}`,
		);
		if (!entry) throw new Error(`Missing fixture container for ${app}`);
		return entry[0];
	};
	let attached: string[] = [],
		ids: Record<string, string> = {};
	subject.fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 3,
			);
			ids = { database: containerId("database"), cache: containerId("cache") };
			return call("env_start", {
				apps: ["worker"],
				lifetime: "shared-prerequisites-v1",
			});
		},
		async () => {
			// The second root attaches to the whole live chain: one new root, no starts.
			await eventually(
				() => running(subject),
				(apps) => apps.length === 4,
			);
			attached = await running(subject);
			return call("env_stop", { apps: ["api"] });
		},
		async () => {
			await eventually(
				() => running(subject),
				(apps) => apps.length === 3,
			);
			return call("env_stop", { apps: ["worker"] });
		},
		async () => {
			await eventually(
				async () =>
					(await snapshot(subject)).runs.filter(
						(run) => run.state === "running",
					).length,
				(count) => count === 0,
			);
			return fauxAssistantMessage("Transitive chain finished", {
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
	expect(attached).toEqual(["api", "cache", "database", "worker"]);
	expect(verbs(subject.config, "create")).toBe(2);
	expect(verbs(subject.config, "rm")).toBe(2);
	// The chain is released dependent first: the database goes before its own
	// prerequisite, never the reverse.
	const removals = history(subject.config)
		.filter((argv) => argv.includes("rm") && !argv.includes("network"))
		.map((argv) => argv[argv.indexOf("rm") + 1]);
	expect(removals).toEqual([ids.database, ids.cache]);
}, 90000);
