import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
async function setup(captured = true) {
	let foreign = "",
		engineFile = "";
	const result = await fixture(true, (config) => {
		foreign = fs.realpathSync(
			fs.mkdtempSync(
				path.join(path.dirname(config.stateDir), "foreign-compose-"),
			),
		);
		const git = (args: string[]) => {
			if (
				Bun.spawnSync(
					[
						"git",
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"core.fsmonitor=false",
						...args,
					],
					{ cwd: foreign, stdout: "pipe", stderr: "pipe" },
				).exitCode !== 0
			)
				throw new Error("Disposable Git fixture failed");
		};
		git(["init", "-b", "main"]);
		git(["config", "user.name", "Fixture"]);
		git(["config", "user.email", "fixture@example.invalid"]);
		fs.writeFileSync(
			path.join(foreign, "identity.txt"),
			"captured-compose-input",
		);
		git(["add", "identity.txt"]);
		git(["commit", "-m", "fixture"]);
		fs.writeFileSync(
			path.join(foreign, "identity.txt"),
			"developer-dirty-input",
		);
		config.repositories.push(foreign);
		fs.mkdirSync(config.configDir);
		const bin = path.join(config.configDir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "docker"),
			`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`,
			{ mode: 0o700 },
		);
		engineFile = path.join(config.configDir, "engine.json");
		fs.writeFileSync(
			engineFile,
			JSON.stringify({ next: 1, containers: {}, history: [] }),
		);
		const engine = serveContainerFixture(engineFile);
		engines.push(engine);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "frontend",
						kind: "app",
						repository: config.repositories[0],
						prerequisites: [{ app: "backend", target: "serve" }],
						targets: [
							{
								id: "serve",
								runtime: "shell",
								action: "run",
								command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('READY');setInterval(()=>{},1000)")}`,
								readyText: "READY",
							},
						],
					},
					{
						id: "backend",
						kind: "app",
						repository: foreign,
						targets: [
							{
								id: "serve",
								runtime: "compose",
								action: "run",
								timeoutMs: 10000,
								environment: {
									PATH: `${bin}:${process.env.PATH ?? ""}`,
									FIXTURE_ENGINE_SOCKET: engine.socket,
								},
								compose: {
									file: "compose.captured.yaml",
									...(captured
										? {
												source:
													"services:\n  api:\n    image: fixture:latest\n    command: [serve]\n    volumes: [./identity.txt:/identity.txt:ro]\n",
											}
										: {}),
									provider: "docker",
									socket: engine.socket,
								},
							},
						],
					},
				],
			}),
		);
	});
	return { ...result, foreign, engineFile };
}

test("captured foreign Compose is recompiled in the owned detached workspace before synthetic engine effects and uses only captured-commit bind data", async () => {
	const { app, fake, invocation, foreign, engineFile } = await setup();
	fake.setResponses([
		call("env_start", { apps: ["frontend"] }),
		call("request_review", { path: ".", title: "Hold foreign Compose" }),
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task);
	expect(readEngineFile(engineFile).history).toHaveLength(0);
	await approve(app, task);
	await pendingReview(app, task, "Hold foreign Compose");
	const state = await app.environments.snapshot(),
		backend = state.runs.find((run) => run.plan.app === "backend");
	if (!backend) throw new Error("Missing public Compose prerequisite receipt");
	expect(state.runs.every((run) => run.state === "running")).toBe(true);
	expect(
		fs.readFileSync(path.join(backend.plan.workspace, "identity.txt"), "utf8"),
	).toBe("captured-compose-input");
	expect(fs.readFileSync(path.join(foreign, "identity.txt"), "utf8")).toBe(
		"developer-dirty-input",
	);
	const history = readEngineFile(engineFile).history.flat().join("\n");
	expect(history).toContain(`src=${backend.plan.workspace}/identity.txt`);
	expect(history).not.toContain(`src=${foreign}/identity.txt`);
	await app.cancel(task);
	expect(Object.keys(readEngineFile(engineFile).containers)).toHaveLength(0);
	expect(Object.keys(readEngineFile(engineFile).networks ?? {})).toHaveLength(
		0,
	);
}, 20000);

test("foreign repository Compose files are not implicitly imported as captured source or granted execution", async () => {
	const { app, fake, invocation, engineFile, config } = await setup(false);
	let result = "";
	fake.setResponses([
		call("env_start", { apps: ["frontend"] }),
		(messages) => {
			result = JSON.stringify(messages.messages);
			return call("request_review", {
				path: ".",
				title: "Hold refused foreign Compose source",
			});
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Hold refused foreign Compose source");
	expect(result).toContain(
		"Foreign Compose prerequisites require config-captured source",
	);
	expect(readEngineFile(engineFile).history).toHaveLength(0);
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	expect(
		fs.existsSync(path.join(config.stateDir, "environment-workspaces")),
	).toBe(false);
	await app.cancel(task);
}, 15000);
