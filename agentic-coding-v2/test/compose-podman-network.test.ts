// Podman shared Compose networking against the synthetic engine: the CLI
// returns the claimed name (not an ID) and lowercases inspected fields, so
// creation identity is read back through one label-verified inspect.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { digest } from "../src/config.ts";
import { git } from "../src/git.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((engine) => engine.stop(true)));
	}
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function engineTarget(config: Config) {
	fs.mkdirSync(config.configDir, { recursive: true });
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	for (const name of ["docker", "podman"])
		fs.writeFileSync(
			path.join(bin, name),
			`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`,
			{ mode: 0o700 },
		);
	const state = path.join(config.configDir, "engine.json");
	fs.writeFileSync(
		state,
		JSON.stringify({ next: 1, containers: {}, history: [], networks: {} }),
	);
	const engine = serveContainerFixture(state);
	engines.push(engine);
	return {
		id: "serve",
		action: "run",
		runtime: "compose",
		timeoutMs: 10000,
		compose: {
			file: "compose.yaml",
			provider: "podman",
			socket: engine.socket,
			network: "shared",
		},
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: engine.socket,
		},
	};
}
function writeDefinition(config: Config) {
	const target = engineTarget(config);
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					targets: [target],
				},
			],
		}),
	);
}
async function compose(repository: string) {
	fs.writeFileSync(
		path.join(repository, "compose.yaml"),
		Bun.YAML.stringify({
			services: {
				web: { image: "fixture:latest", command: ["serve"] },
				sidecar: { image: "fixture:latest", command: ["serve"] },
			},
		}),
	);
	await git(repository, ["add", "compose.yaml"]);
	await git(repository, ["commit", "-m", "Disposable Podman network fixture"]);
}
const networkName = (config: Config) =>
	`acv2-api-${digest(config.stateDir).slice(0, 8)}-default`;

test("Podman shared networks are created by name, verified by inspect and removed empty", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		writeDefinition(config),
	);
	await compose(invocation.repository);
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return call("request_review", { path: ".", title: "Hold network" });
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task);
	await approve(app, task);
	await pendingReview(app, task, "Hold network");
	const file = path.join(config.configDir, "engine.json");
	const names = Object.values(readEngineFile(file).networks ?? {});
	expect(names).toHaveLength(1);
	const network = names[0];
	expect(network?.Name).toBe(networkName(config));
	expect(Object.keys(network?.Labels ?? {})).toEqual([
		"dev.agentic-coding.v2.host",
		"dev.agentic-coding.v2.run",
	]);
	expect(Object.keys(network?.Containers ?? {})).toHaveLength(2);
	// The Podman CLI answered the claimed name; history proves no ID receipt.
	const creates = readEngineFile(file)
		.history.filter((args) => args[2] === "network" && args[3] === "create")
		.map((args) => args.at(-1));
	expect(creates).toEqual([networkName(config)]);
	expect(transcript).not.toContain("must-not-leak");
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
	expect(Object.keys(readEngineFile(file).networks ?? {})).toHaveLength(0);
	expect(Object.keys(readEngineFile(file).containers)).toHaveLength(0);
}, 30000);

test("Podman occupied network names refuse without adoption", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		writeDefinition(config),
	);
	await compose(invocation.repository);
	const file = path.join(config.configDir, "engine.json");
	const foreign = "f".repeat(64);
	fs.writeFileSync(
		file,
		JSON.stringify({
			next: 1,
			containers: {},
			history: [],
			networks: {
				[foreign]: {
					Id: foreign,
					Name: networkName(config),
					Labels: { foreign: "true" },
					Containers: {},
				},
			},
		}),
	);
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("Network refused");
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task);
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(transcript).toContain("Environment execution did not complete");
	expect(JSON.stringify(await app.environments.logs("api", task))).toContain(
		"network name is occupied",
	);
	const state = readEngineFile(file);
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(Object.values(state.networks ?? {})).toEqual([
		expect.objectContaining({ Id: foreign, Labels: { foreign: "true" } }),
	]);
}, 30000);
