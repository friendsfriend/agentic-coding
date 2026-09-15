// Command, process and readiness handlers
// (`port-action-execution-to-bun`, tasks 2.3, 2.4 and 2.6).
//
// Ported from `server/pkg/actionexec/{command,process,readiness,
// container_readiness,compose_readiness}_test.go`, plus the two readiness
// contracts the spec names: a process that exits before its readiness condition
// fails the action, and an already-running resource succeeds without an invented
// command step.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionStepDefinition, ActionStepKind } from "@devenv/types";
import {
	type CommandEvent,
	CommandHandler,
	OSCommandRunner,
} from "../src/server/actions/command.ts";
import { Coordinator } from "../src/server/actions/coordinator.ts";
import { Engine } from "../src/server/actions/engine.ts";
import {
	MemoryProcessStore,
	ProcessHandler,
} from "../src/server/actions/process.ts";
import { ActionRunProjection } from "../src/server/actions/projection.ts";
import {
	ComposeReadinessProbe,
	ContainerHealthProbe,
	HTTPProbe,
	KubernetesPodReadinessProbe,
	ProcessSurvivalProbe,
	poll,
	processDead,
	ReadinessHandler,
	StandardProbeFactory,
	TCPProbe,
} from "../src/server/actions/readiness.ts";
import { RUN_STATUS, RunRegistry } from "../src/server/actions/run-registry.ts";
import {
	type HandlerContext,
	OUTCOME,
	STEP_KIND,
	type StepResult,
} from "../src/server/actions/step-result.ts";
import { ValueStore } from "../src/server/actions/values.ts";

function step(
	id: string,
	kind: ActionStepKind,
	configuration: Record<string, unknown> = {},
): ActionStepDefinition {
	return { id, kind, label: id, configuration };
}

/** The literal `${key}` placeholder a compiled definition carries. */
const PLACEHOLDER_OPEN = "${";
const placeholder = (key: string): string => `${PLACEHOLDER_OPEN}${key}}`;

function context(
	values = new ValueStore(),
	signal = new AbortController().signal,
): HandlerContext {
	return { signal, runId: "run", stepId: "step", values };
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition timed out");
		await Bun.sleep(10);
	}
}

describe("command handler", () => {
	test("records streams, exit code and redacted display args", async () => {
		const events: CommandEvent[] = [];
		const handler = new CommandHandler(
			{
				run: async (spec, output) => {
					expect(spec.args).toEqual(["--token", "s3cr3t"]);
					output?.("stdout", "ok");
					output?.("stderr", "warning");
					return {
						stdout: "ok",
						stderr: "warning",
						exitCode: 7,
						error: new Error("exit status 7"),
					};
				},
			},
			{ emitCommand: (event) => events.push(event) },
		);
		const result = await handler.execute(
			context(),
			step("step", STEP_KIND.command, {
				command: "tool",
				args: ["--token", "s3cr3t"],
				displayArgs: ["--token", "[REDACTED]"],
			}),
		);

		expect(result.outcome).toBe(OUTCOME.failed);
		expect(result.exitCode).toBe(7);
		expect(events).toHaveLength(4);
		expect(events[0]).toMatchObject({
			type: "command.started",
			command: "tool",
			args: ["--token", "[REDACTED]"],
		});
		expect(events[1]).toMatchObject({
			type: "command.output",
			stream: "stdout",
			chunk: "ok",
		});
		expect(events[2]).toMatchObject({
			type: "command.output",
			stream: "stderr",
			chunk: "warning",
		});
		expect(events[3]).toMatchObject({
			type: "command.failed",
			exitCode: 7,
			error: "exit status 7",
		});
		// The secret never reaches an event, only the redacted display form.
		expect(JSON.stringify(events)).not.toContain("s3cr3t");
	});

	test("extracts a captured JSON label into a named value", async () => {
		const values = new ValueStore();
		const handler = new CommandHandler({
			run: async () => ({
				stdout: `{"devenv.artifacts":"dist/output"}`,
				stderr: "",
				exitCode: 0,
			}),
		});
		const result = await handler.execute(
			context(values),
			step("inspect", STEP_KIND.command, {
				command: "docker",
				args: ["inspect"],
				captureJSONLabel: "devenv.artifacts",
				captureKey: "artifact.path",
			}),
		);
		expect((await result).error).toBeUndefined();
		expect(values.get("artifact.path")).toEqual({
			type: "path",
			visibility: "internal",
			data: "dist/output",
		});
	});

	test("unparseable capture output fails the step", async () => {
		const handler = new CommandHandler({
			run: async () => ({ stdout: "not json", stderr: "", exitCode: 0 }),
		});
		const result = await handler.execute(
			context(),
			step("inspect", STEP_KIND.command, {
				command: "docker",
				captureJSONLabel: "devenv.artifacts",
				captureKey: "artifact.path",
			}),
		);
		expect(result.outcome).toBe(OUTCOME.failed);
		expect(result.error).toBeDefined();
	});

	test("captures stdout and consumes it in a later step's argv", async () => {
		const values = new ValueStore();
		const seen: string[][] = [];
		const handler = new CommandHandler({
			run: async (spec) => {
				seen.push(spec.args);
				if (spec.args[0] === "rev-parse") {
					return { stdout: "main\n", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});
		const first = await handler.execute(
			context(values),
			step("get-ref", STEP_KIND.command, {
				command: "git",
				args: ["rev-parse"],
				captureStdout: "git.branch",
			}),
		);
		expect(first.error).toBeUndefined();
		const second = await handler.execute(
			context(values),
			step("pull", STEP_KIND.command, {
				command: "git",
				args: ["reset", "--hard", `origin/${placeholder("git.branch")}`],
			}),
		);
		expect(second.error).toBeUndefined();
		expect(seen[1]).toEqual(["reset", "--hard", "origin/main"]);
	});

	test("publishes setValues and endpoint exports as typed values", async () => {
		const values = new ValueStore();
		const handler = new CommandHandler({
			run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		});
		await handler.execute(
			context(values),
			step("build", STEP_KIND.command, {
				command: "docker",
				setValues: { "image.ref": "devenv-api:latest" },
				endpointExports: [
					{ name: "api", protocol: "http", host: "127.0.0.1", port: 8080 },
				],
			}),
		);
		expect(values.get("image.ref")).toEqual({
			type: "string",
			visibility: "internal",
			data: "devenv-api:latest",
		});
		expect(values.get("endpoint.api")?.type).toBe("endpoint");
		expect(values.get("endpoint.api")?.visibility).toBe("public");
	});

	test("a failed command publishes nothing", async () => {
		const values = new ValueStore();
		const handler = new CommandHandler({
			run: async () => ({
				stdout: "x",
				stderr: "",
				exitCode: 1,
				error: new Error("exit status 1"),
			}),
		});
		await handler.execute(
			context(values),
			step("build", STEP_KIND.command, {
				command: "docker",
				captureStdout: "image.ref",
				setValues: { "artifact.path": "/out" },
			}),
		);
		expect(values.get("image.ref")).toBeUndefined();
		expect(values.get("artifact.path")).toBeUndefined();
	});

	test("a missing command is rejected before any event", async () => {
		const events: CommandEvent[] = [];
		const handler = new CommandHandler(
			{ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			{ emitCommand: (event) => events.push(event) },
		);
		const result = await handler.execute(
			context(),
			step("x", STEP_KIND.command, {}),
		);
		expect(result.error?.message).toBe("command is required");
		expect(events).toEqual([]);
	});
});

describe("os command runner", () => {
	test("runs argv, captures both streams and the exit code", async () => {
		const result = await new OSCommandRunner().run({
			name: "sh",
			args: ["-c", "echo out; echo err >&2; exit 3"],
		});
		expect(result.stdout.trim()).toBe("out");
		expect(result.stderr.trim()).toBe("err");
		expect(result.exitCode).toBe(3);
		expect(result.error?.message).toBe("exit status 3");
	});

	test("runs in the requested directory with the requested environment", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devenv-runner-"));
		const result = await new OSCommandRunner().run({
			name: "sh",
			args: ["-c", "pwd; echo $DEVENV_TEST_ENV"],
			dir,
			env: ["DEVENV_TEST_ENV=marker"],
		});
		expect(result.stdout).toContain(fs.realpathSync(dir));
		expect(result.stdout).toContain("marker");
	});

	test("a cancelled signal kills the child instead of waiting for it", async () => {
		const controller = new AbortController();
		const running = new OSCommandRunner().run(
			{ name: "sleep", args: ["30"] },
			undefined,
			controller.signal,
		);
		controller.abort(new Error("cancelled by the test"));
		const result = await running;
		expect(result.error).toBeDefined();
		expect(result.exitCode).toBe(-1);
	});

	test("an already-cancelled signal never spawns", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled before start"));
		const result = await new OSCommandRunner().run(
			{ name: "sh", args: ["-c", "echo should-not-run"] },
			undefined,
			controller.signal,
		);
		expect(result.stdout).toBe("");
		expect(result.error?.message).toBe("cancelled before start");
	});
});

describe("process handler", () => {
	test("streams output and preserves it in the log file", async () => {
		const logPath = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "devenv-process-")),
			"process.log",
		);
		const events: CommandEvent[] = [];
		const store = new MemoryProcessStore();
		const handler = new ProcessHandler(store, {
			emitCommand: (event) => events.push(event),
		});
		const result = handler.execute(
			context(),
			step("start", STEP_KIND.process, {
				command: "sh",
				args: ["-c", "echo stdout; echo stderr >&2"],
				logPath,
			}),
		);
		expect((await result).error).toBeUndefined();
		await waitFor(
			() =>
				fs.existsSync(logPath) &&
				fs.readFileSync(logPath, "utf8").includes("stderr"),
		);
		const logged = fs.readFileSync(logPath, "utf8");
		expect(logged).toContain("stdout");
		expect(logged).toContain("stderr");
		expect(events.filter((e) => e.type === "command.output")).toHaveLength(2);
		await waitFor(() => store.get("start") === undefined);
	});

	test("a managed process outlives the action context and dies with the store", async () => {
		const store = new MemoryProcessStore();
		const handler = new ProcessHandler(store);
		const controller = new AbortController();
		const result = handler.execute(
			context(new ValueStore(), controller.signal),
			step("port-forward", STEP_KIND.process, {
				command: "sh",
				args: ["-c", "sleep 30"],
			}),
		);
		expect((await result).error).toBeUndefined();
		const handle = store.get("port-forward");
		expect(handle?.pid).toBeGreaterThan(0);
		const pid = handle?.pid ?? 0;
		controller.abort(new Error("action deadline"));
		await Bun.sleep(100);
		expect(processDead(pid)).toBe(false);
		store.killAll();
		await waitFor(() => processDead(pid));
	});

	test("a configured handle key addresses the process, not the step id", () => {
		const store = new MemoryProcessStore();
		const handler = new ProcessHandler(store);
		handler.execute(
			context(),
			step("start", STEP_KIND.process, {
				command: "sh",
				args: ["-c", "sleep 30"],
				handleKey: "worker",
			}),
		);
		expect(store.get("worker")?.pid).toBeGreaterThan(0);
		expect(store.get("start")).toBeUndefined();
		store.killAll();
	});

	test("a missing command fails the step without spawning", async () => {
		const result = await new ProcessHandler(new MemoryProcessStore()).execute(
			context(),
			step("start", STEP_KIND.process, {}),
		);
		expect(result.outcome).toBe(OUTCOME.failed);
		expect(result.error?.message).toBe("command is required");
	});

	test("the store deletes a handle and reports absence", () => {
		const store = new MemoryProcessStore();
		store.put("start", { mode: "process", pid: 42, startedAt: "now" });
		expect(store.get("start")?.pid).toBe(42);
		store.delete("start");
		expect(store.get("start")).toBeUndefined();
	});
});

describe("readiness probes", () => {
	test("a process survival window fails when the process exited", async () => {
		const proc = Bun.spawn(["sh", "-c", "true"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await proc.exited;
		const probe = new ProcessSurvivalProbe(proc.pid, 200);
		await expect(probe.wait()).rejects.toThrow(/exited before readiness/);

		const alive = Bun.spawn(["sh", "-c", "sleep 30"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await expect(
			new ProcessSurvivalProbe(alive.pid, 50).wait(),
		).resolves.toBeUndefined();
		alive.kill();
	});

	test("a tmux pane that exited fails readiness", async () => {
		await expect(
			new ProcessSurvivalProbe(1, 20, () => false).wait(),
		).rejects.toThrow(/tmux pane exited before readiness/);
		await expect(
			new ProcessSurvivalProbe(1, 20, () => true).wait(),
		).resolves.toBeUndefined();
	});

	test("an aborted signal ends a survival window", async () => {
		const controller = new AbortController();
		const probe = new ProcessSurvivalProbe(process.pid, 5000);
		const waiting = probe.wait(controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
	});

	test("tcp and http probes succeed against a live endpoint", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 204 }),
		});
		try {
			const signal = new AbortController().signal;
			await expect(
				new TCPProbe(`127.0.0.1:${server.port}`, 10).wait(signal),
			).resolves.toBeUndefined();
			await expect(
				new HTTPProbe(`http://127.0.0.1:${server.port}/`, 10).wait(signal),
			).resolves.toBeUndefined();
		} finally {
			server.stop(true);
		}
	});

	test("an http probe rejects an error status once the deadline passes", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 503 }),
		});
		const controller = new AbortController();
		try {
			const waiting = new HTTPProbe(`http://127.0.0.1:${server.port}/`, 5).wait(
				controller.signal,
			);
			setTimeout(() => controller.abort(new Error("deadline")), 40);
			await expect(waiting).rejects.toThrow("deadline");
		} finally {
			server.stop(true);
		}
	});

	test("container health probes until the container is healthy", async () => {
		let calls = 0;
		const probe = new ContainerHealthProbe(
			{
				run: async () => {
					calls++;
					return {
						stdout: calls === 1 ? "running starting" : "running healthy",
						stderr: "",
						exitCode: 0,
					};
				},
			},
			"api",
			1,
		);
		await probe.wait();
		expect(calls).toBe(2);
	});

	test("a container with no health section counts as ready once running", async () => {
		const probe = new ContainerHealthProbe(
			{ run: async () => ({ stdout: "running ", stderr: "", exitCode: 0 }) },
			"api",
			1,
		);
		await expect(probe.wait()).resolves.toBeUndefined();
	});

	test("compose readiness rejects a non-running container", async () => {
		const controller = new AbortController();
		const probe = new ComposeReadinessProbe(
			{
				run: async () => ({
					stdout: "running\nexited\n",
					stderr: "",
					exitCode: 0,
				}),
			},
			"docker",
			[],
			1,
		);
		const waiting = probe.wait(controller.signal);
		setTimeout(() => controller.abort(new Error("compose never ready")), 40);
		await expect(waiting).rejects.toThrow("compose never ready");
	});

	test("compose readiness accepts an all-running stack", async () => {
		const probe = new ComposeReadinessProbe(
			{
				run: async () => ({
					stdout: "running\nrunning\n",
					stderr: "",
					exitCode: 0,
				}),
			},
			"docker",
			[],
			1,
		);
		await expect(probe.wait()).resolves.toBeUndefined();
	});

	test("podman-compose never receives the docker-only --all flag", async () => {
		let args: string[] = [];
		const probe = new ComposeReadinessProbe(
			{
				run: async (spec) => {
					args = spec.args;
					return { stdout: "running\n", stderr: "", exitCode: 0 };
				},
			},
			"podman-compose",
			["-f", "/tmp/compose.yml"],
			1,
		);
		await probe.wait();
		expect(args).not.toContain("--all");
		expect(args).toEqual([
			"-f",
			"/tmp/compose.yml",
			"ps",
			"--format",
			"{{.State}}",
		]);
	});

	test("a kubernetes probe waits for the first pod and then for readiness", async () => {
		const specs: string[][] = [];
		const results = [
			{ stdout: "", stderr: "", exitCode: 0 },
			{ stdout: "pod/postgres\n", stderr: "", exitCode: 0 },
			{ stdout: "", stderr: "", exitCode: 0 },
		];
		const probe = new KubernetesPodReadinessProbe(
			{
				run: async (spec) => {
					specs.push(spec.args);
					return results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
				},
			},
			"kind-test",
			"apps",
			"app.kubernetes.io/instance=postgres",
			"1s",
			1,
		);
		await probe.wait();
		expect(specs).toHaveLength(3);
		expect(specs[2]).toEqual([
			"--context",
			"kind-test",
			"--namespace",
			"apps",
			"wait",
			"--for=condition=ready",
			"pod",
			"-l",
			"app.kubernetes.io/instance=postgres",
			"--timeout",
			"1s",
		]);
	});

	test("a failing check is retried until the signal ends it", async () => {
		let calls = 0;
		const controller = new AbortController();
		const waiting = poll(1, controller.signal, async () => {
			calls++;
			throw new Error("never ready");
		});
		setTimeout(() => controller.abort(new Error("gave up")), 30);
		await expect(waiting).rejects.toThrow("gave up");
		expect(calls).toBeGreaterThan(1);
	});
});

describe("standard probe factory", () => {
	test("resolves process, tcp, http, container, compose and kubernetes probes", () => {
		const store = new MemoryProcessStore();
		store.put("worker", {
			mode: "process",
			pid: process.pid,
			startedAt: "now",
		});
		const factory = new StandardProbeFactory({
			processes: store,
			container: () => ({ wait: async () => undefined }),
			compose: () => ({ wait: async () => undefined }),
			kubernetes: () => ({ wait: async () => undefined }),
		});
		for (const configuration of [
			{ probe: "tcp", address: "127.0.0.1:1" },
			{ probe: "http", url: "http://127.0.0.1:1/" },
			{ probe: "container-health", containerId: "api" },
			{ probe: "kubernetes" },
			{ probe: "compose" },
			{ processStepId: "worker" },
			{ processStepId: "worker", stabilizationMs: 5 },
			{},
		]) {
			expect(() =>
				factory.probe(
					undefined,
					step("ready", STEP_KIND.readiness, configuration),
				),
			).not.toThrow();
		}
	});

	test("an unavailable runtime or handle fails instead of hanging", () => {
		const factory = new StandardProbeFactory();
		expect(() =>
			factory.probe(
				undefined,
				step("ready", STEP_KIND.readiness, {
					probe: "container-health",
					containerId: "api",
				}),
			),
		).toThrow("container readiness unavailable");
		expect(() =>
			factory.probe(
				undefined,
				step("ready", STEP_KIND.readiness, {
					probe: "kubernetes",
				}),
			),
		).toThrow("kubernetes readiness unavailable");
		expect(() =>
			factory.probe(
				undefined,
				step("ready", STEP_KIND.readiness, {
					probe: "compose",
				}),
			),
		).toThrow("compose readiness unavailable");
		expect(() =>
			factory.probe(
				undefined,
				step("ready", STEP_KIND.readiness, {
					processStepId: "missing",
				}),
			),
		).toThrow("process handle missing unavailable");
	});

	test("a probe without a specific kind is a stabilization delay", async () => {
		const factory = new StandardProbeFactory();
		const probe = factory.probe(
			undefined,
			step("ready", STEP_KIND.readiness, { stabilizationMs: 10 }),
		);
		await expect(probe.wait()).resolves.toBeUndefined();
	});

	test("an aborted stabilization delay does not block the run", async () => {
		const factory = new StandardProbeFactory();
		const controller = new AbortController();
		const probe = factory.probe(
			undefined,
			step("ready", STEP_KIND.readiness, { stabilizationMs: 5000 }),
		);
		const waiting = probe.wait(controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
	});

	test("the readiness step publishes endpoint exports only on success", async () => {
		const values = new ValueStore();
		const handler = new ReadinessHandler(
			new StandardProbeFactory({
				processes: new MemoryProcessStore(),
			}),
		);
		const result = await handler.execute(
			context(values),
			step("ready", STEP_KIND.readiness, {
				stabilizationMs: 1,
				endpointExports: [
					{ name: "api", protocol: "http", host: "127.0.0.1", port: 8080 },
				],
			}),
		);
		expect((await result).outcome).toBe(OUTCOME.executed);
		expect(values.get("endpoint.api")?.data).toEqual({
			name: "api",
			protocol: "http",
			host: "127.0.0.1",
			port: 8080,
		});
	});

	test("a failing probe fails the step with its reason", async () => {
		const handler = new ReadinessHandler({
			probe: () => ({
				wait: async () => {
					throw new Error("container api not ready: exited");
				},
			}),
		});
		const result = await handler.execute(
			context(),
			step("ready", STEP_KIND.readiness, {}),
		);
		expect(result.outcome).toBe(OUTCOME.failed);
		expect(result.error?.message).toBe("container api not ready: exited");
	});
});

describe("readiness gates the action outcome", () => {
	test("a process that exits before readiness fails the action", async () => {
		const store = new MemoryProcessStore();
		const handler = new ProcessHandler(store);
		const factory = new StandardProbeFactory({ processes: store });
		const engine = new Engine({
			handlers: new Map<
				string,
				{
					execute(
						c: HandlerContext,
						s: ActionStepDefinition,
					): StepResult | Promise<StepResult>;
				}
			>([
				[STEP_KIND.process, { execute: (c, s) => handler.execute(c, s) }],
				[
					STEP_KIND.readiness,
					{
						execute: (c, s) => new ReadinessHandler(factory).execute(c, s),
					},
				],
			]),
		});
		const result = await engine.run(new AbortController().signal, "run", {
			id: "action",
			owner: { kind: "app", id: "api" },
			type: "run",
			runtime: "shell",
			label: "Run",
			inputs: [],
			availability: { available: true },
			root: {
				id: "root",
				kind: STEP_KIND.composite,
				label: "root",
				children: [
					step("start", STEP_KIND.process, {
						command: "sh",
						args: ["-c", "true"],
						handleKey: "worker",
					}),
					step("ready", STEP_KIND.readiness, {
						processStepId: "worker",
						stabilizationMs: 150,
					}),
				],
			},
		});
		expect(result.outcome).toBe(OUTCOME.failed);
		expect(result.error?.message).toMatch(/exited before readiness/);
	});

	test("an already-running resource succeeds with no command step", async () => {
		const registry = new RunRegistry();
		registry.start(
			{ id: "run", title: "Run", status: RUN_STATUS.active, steps: [] },
			"api",
			"run",
		);
		const commands: CommandEvent[] = [];
		const projection = new ActionRunProjection(registry);
		const engine = new Engine({
			handlers: new Map([
				[
					STEP_KIND.command,
					{
						execute: async () => {
							throw new Error("the canonical execution must not run");
						},
					},
				],
			]),
			events: {
				emit: (event) => {
					projection.emit(event);
				},
			},
			// The ready probe reports the dependency as already up.
			coordinator: new Coordinator(() => true),
		});
		const result = await engine.run(new AbortController().signal, "run", {
			id: "action",
			owner: { kind: "app", id: "api" },
			type: "run",
			runtime: "shell",
			label: "Run",
			inputs: [],
			availability: { available: true },
			root: {
				id: "root",
				kind: STEP_KIND.composite,
				label: "root",
				children: [
					{
						id: "start-db",
						kind: STEP_KIND.command,
						label: "start-db",
						executionKey: "dependency/db",
						configuration: { command: "docker-compose", args: ["up", "-d"] },
					},
				],
			},
		});
		expect((await result).outcome).toBe(OUTCOME.executed);
		expect(commands).toEqual([]);
		const run = registry.get("run");
		expect(run?.steps.find((s) => s.id === "start-db")?.outcome).toBe(
			OUTCOME.alreadyRunning,
		);
		expect(run?.steps.find((s) => s.id === "start-db")?.commands).toEqual([]);
	});
});
