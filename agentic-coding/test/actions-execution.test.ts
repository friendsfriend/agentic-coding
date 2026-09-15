// Action execution semantics: execution-key deduplication, typed values,
// failure policy, leases and run projection
// (`port-action-execution-to-bun`, tasks 2.1–2.5).
//
// Ported from `server/pkg/actionexec/{engine,coordinator,projection}_test.go`,
// with the command-count accounting the spec requires: one canonical execution
// owns the commands, reference nodes mirror the outcome, and a step that did not
// execute produces no command event at all.
import { describe, expect, test } from "bun:test";
import type {
	ActionDefinition,
	ActionStepDefinition,
	ActionStepKind,
} from "@devenv/types";
import {
	type CommandEvent,
	CommandHandler,
	type CommandRunner,
	OSCommandRunner,
} from "../src/server/actions/command.ts";
import {
	ClaimConflict,
	Coordinator,
} from "../src/server/actions/coordinator.ts";
import { Engine, type EngineEvent } from "../src/server/actions/engine.ts";
import { ActionRunProjection } from "../src/server/actions/projection.ts";
import { RUN_STATUS, RunRegistry } from "../src/server/actions/run-registry.ts";
import type {
	HandlerContext,
	StepResult,
} from "../src/server/actions/step-result.ts";
import {
	FAILURE_POLICY,
	OUTCOME,
	STEP_CONDITION,
	STEP_KIND,
} from "../src/server/actions/step-result.ts";
import {
	resolveValueTemplates,
	ValueStore,
} from "../src/server/actions/values.ts";

function step(
	id: string,
	kind: ActionStepKind,
	overrides: Partial<ActionStepDefinition> = {},
): ActionStepDefinition {
	return { id, kind, label: id, ...overrides };
}

/** The literal `${key}` placeholder a compiled definition carries. */
const PLACEHOLDER_OPEN = "${";
const placeholder = (key: string): string => `${PLACEHOLDER_OPEN}${key}}`;

function action(children: ActionStepDefinition[]): ActionDefinition {
	return {
		id: "action",
		owner: { kind: "app", id: "api" },
		type: "run",
		runtime: "shell",
		label: "Run",
		inputs: [],
		availability: { available: true },
		root: step("root", STEP_KIND.composite, { children }),
	};
}

interface Recorded {
	events: EngineEvent[];
	commands: CommandEvent[];
}

/** Records both engine events and the command events a handler emits. */
function recorder(): Recorded & {
	sink: { emit(event: EngineEvent): void };
	commandSink: { emitCommand(event: CommandEvent): void };
} {
	const events: EngineEvent[] = [];
	const commands: CommandEvent[] = [];
	return {
		events,
		commands,
		sink: { emit: (event) => events.push(event) },
		commandSink: { emitCommand: (event) => commands.push(event) },
	};
}

function summary(events: EngineEvent[]): string[] {
	return events.map(
		(event) =>
			`${event.type}:${event.stepId}${event.reference ? ":ref" : ""}${event.outcome ? `:${event.outcome}` : ""}`,
	);
}

describe("sequential execution and typed values", () => {
	test("a value produced by one step reaches the next", async () => {
		const order: string[] = [];
		const handler = {
			execute: async (
				_context: HandlerContext,
				s: ActionStepDefinition,
			): Promise<StepResult> => {
				order.push(s.id);
				if (s.id === "produce") {
					_context.values.set("image.ref", {
						type: "image-ref",
						visibility: "internal",
						data: "api:latest",
					});
				} else {
					const value = _context.values.get("image.ref");
					expect(value?.data).toBe("api:latest");
				}
				return { outcome: OUTCOME.executed };
			},
		};
		const engine = new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
		});
		const result = await engine.run(
			new AbortController().signal,
			"run",
			action([
				step("produce", STEP_KIND.operation),
				step("consume", STEP_KIND.operation),
			]),
		);
		expect(result.error).toBeUndefined();
		expect(order).toEqual(["produce", "consume"]);
	});

	test("a step consuming an absent value fails with the Go diagnostic", async () => {
		const engine = new Engine({
			handlers: new Map([
				[
					STEP_KIND.command,
					new CommandHandler(
						{
							run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
						},
						recorder().commandSink,
					),
				],
			]),
		});
		const result = await engine.run(
			new AbortController().signal,
			"run",
			action([
				step("pull", STEP_KIND.command, {
					configuration: {
						command: "git",
						args: ["reset", "--hard", `origin/${placeholder("git.branch")}`],
					},
				}),
			]),
		);
		expect(result.error?.message).toBe("required value git.branch missing");
		expect(result.outcome).toBe(OUTCOME.failed);
	});

	test("an unclosed placeholder is rejected instead of reaching the process", () => {
		const store = new ValueStore();
		expect(() =>
			resolveValueTemplates(store, [`a${placeholder("b")}`.slice(0, -1)]),
		).toThrow(/invalid value template/);
	});

	test("value templates render endpoints, scalars and Go-shaped containers", () => {
		const store = new ValueStore();
		store.set("ep", {
			type: "endpoint",
			visibility: "public",
			data: { name: "api", protocol: "http", host: "127.0.0.1", port: 8080 },
		});
		store.set("path", {
			type: "path",
			visibility: "internal",
			data: "/tmp/out",
		});
		store.set("count", { type: "int", visibility: "internal", data: 3 });
		store.set("flag", { type: "bool", visibility: "internal", data: true });
		store.set("none", { type: "string", visibility: "internal", data: null });
		expect(
			resolveValueTemplates(store, [
				placeholder("ep"),
				placeholder("path"),
				placeholder("count"),
				placeholder("flag"),
				placeholder("none"),
			]),
		).toEqual(["http://127.0.0.1:8080", "/tmp/out", "3", "true", "<nil>"]);
	});

	test("a secret value is delivered to its consumer but never serialized", async () => {
		const value = {
			type: "string",
			visibility: "secret" as const,
			data: "s3cr3t-sentinel",
		};
		let seen: string | undefined;
		const engine = new Engine({
			handlers: new Map([
				[
					STEP_KIND.operation,
					{
						execute: async (context: HandlerContext): Promise<StepResult> => {
							seen = String(context.values.get("token")?.data);
							return { outcome: OUTCOME.executed };
						},
					},
				],
			]),
		});
		const inputs = new Map([["token", value]]);
		const result = await engine.run(
			new AbortController().signal,
			"run",
			action([step("use", STEP_KIND.operation)]),
			inputs,
		);
		expect(result.error).toBeUndefined();
		expect(seen).toBe("s3cr3t-sentinel");

		// The run tree carries steps and outcomes, never value data.
		const registry = new RunRegistry();
		registry.start(
			{ id: "run", title: "Run", status: RUN_STATUS.active, steps: [] },
			"api",
			"run",
		);
		expect(JSON.stringify(registry.get("run"))).not.toContain(
			"s3cr3t-sentinel",
		);
	});
});

describe("semantic tree versus execution key", () => {
	test("two paths to one dependency execute the work once", async () => {
		let calls = 0;
		const recorded = recorder();
		const handler = {
			execute: async (): Promise<StepResult> => {
				calls++;
				return { outcome: OUTCOME.executed };
			},
		};
		const definition = action([
			step("direct-db", STEP_KIND.operation, { executionKey: "dependency/db" }),
			step("transitive-db", STEP_KIND.operation, {
				executionKey: "dependency/db",
			}),
		]);
		const result = await new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
			events: recorded.sink,
			coordinator: new Coordinator(),
		}).run(new AbortController().signal, "run", definition);

		expect(result.error).toBeUndefined();
		expect(calls).toBe(1);
		expect(summary(recorded.events)).toEqual([
			"step.started:root",
			"step.started:direct-db",
			"step.completed:direct-db:executed",
			"step.reference:transitive-db:ref",
			"step.completed:root:executed",
		]);
	});

	test("a reference node mirrors the canonical outcome without its command", async () => {
		const recorded = recorder();
		const runner: CommandRunner = {
			run: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
		};
		const command = new CommandHandler(runner, recorded.commandSink);
		const definition = action([
			step("direct-db", STEP_KIND.command, {
				executionKey: "dependency/db",
				configuration: { command: "sh", args: ["-c", "start-db"] },
			}),
			step("transitive-db", STEP_KIND.command, {
				executionKey: "dependency/db",
				configuration: { command: "sh", args: ["-c", "start-db"] },
			}),
		]);
		await new Engine({
			handlers: new Map([[STEP_KIND.command, command]]),
			events: recorded.sink,
			coordinator: new Coordinator(),
		}).run(new AbortController().signal, "run", definition);

		// Exactly one command leaf: the reference owns no command output.
		const started = recorded.commands.filter(
			(e) => e.type === "command.started",
		);
		expect(started).toHaveLength(1);
		expect(started[0]?.stepId).toBe("direct-db");
		expect(started[0]?.args).toEqual(["-c", "start-db"]);
	});

	test("the same execution key in a later run executes again", async () => {
		let calls = 0;
		const coordinator = new Coordinator();
		const handler = {
			execute: async (): Promise<StepResult> => {
				calls++;
				return { outcome: OUTCOME.executed };
			},
		};
		const engine = new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
			coordinator,
		});
		const definition = action([
			step("db", STEP_KIND.operation, { executionKey: "dependency/db" }),
		]);
		await engine.run(new AbortController().signal, "run-1", definition);
		await engine.run(new AbortController().signal, "run-2", definition);
		expect(calls).toBe(2);
	});
});

describe("failure policy", () => {
	test("a failure stops normal steps and runs an always-run cleanup", async () => {
		const order: string[] = [];
		const handler = {
			execute: async (
				_context: HandlerContext,
				s: ActionStepDefinition,
			): Promise<StepResult> => {
				order.push(s.id);
				if (s.id === "fail") {
					return { outcome: OUTCOME.failed, error: new Error("boom") };
				}
				return { outcome: OUTCOME.executed };
			},
		};
		const result = await new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
		}).run(
			new AbortController().signal,
			"run",
			action([
				step("fail", STEP_KIND.operation),
				step("skip", STEP_KIND.operation),
				step("cleanup", STEP_KIND.operation, {
					failurePolicy: FAILURE_POLICY.alwaysRun,
				}),
			]),
		);
		expect(result.error?.message).toBe("boom");
		expect(result.outcome).toBe(OUTCOME.failed);
		expect(order).toEqual(["fail", "cleanup"]);
	});

	test("an on-failure step runs only after a failure", async () => {
		const order: string[] = [];
		const handler = {
			execute: async (
				_context: HandlerContext,
				s: ActionStepDefinition,
			): Promise<StepResult> => {
				order.push(s.id);
				return { outcome: OUTCOME.executed };
			},
		};
		const engine = new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
		});
		await engine.run(
			new AbortController().signal,
			"run",
			action([
				step("work", STEP_KIND.operation),
				step("diagnostics", STEP_KIND.operation, {
					condition: STEP_CONDITION.onFailure,
				}),
			]),
		);
		expect(order).toEqual(["work"]);

		order.length = 0;
		await engine.run(
			new AbortController().signal,
			"run",
			action([
				step("work", STEP_KIND.operation, {
					configuration: { resourceClaims: [] },
				}),
				step("diagnostics", STEP_KIND.operation, {
					condition: STEP_CONDITION.onFailure,
					failurePolicy: FAILURE_POLICY.alwaysRun,
				}),
			]),
		);
		// No failure: the on-failure step is still skipped, because it only runs
		// when a sibling failed.
		expect(order).toEqual(["work"]);
	});

	test("a child failure without an error still fails the composite", async () => {
		const handler = {
			execute: async (): Promise<StepResult> => ({ outcome: OUTCOME.failed }),
		};
		const result = await new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
		}).run(
			new AbortController().signal,
			"run",
			action([step("child", STEP_KIND.operation)]),
		);
		expect(result.error?.message).toBe("child step failed");
	});

	test("a missing handler fails the step instead of silently succeeding", async () => {
		const result = await new Engine({ handlers: new Map() }).run(
			new AbortController().signal,
			"run",
			action([step("work", STEP_KIND.command)]),
		);
		expect(result.error?.message).toBe("no handler for command");
	});

	test("cancellation stops normal steps but lets cleanup run", async () => {
		const controller = new AbortController();
		controller.abort(new Error("context canceled"));
		const order: string[] = [];
		const handler = {
			execute: async (
				_context: HandlerContext,
				s: ActionStepDefinition,
			): Promise<StepResult> => {
				order.push(s.id);
				return { outcome: OUTCOME.executed };
			},
		};
		const result = await new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
		}).run(
			controller.signal,
			"run",
			action([
				step("work", STEP_KIND.operation),
				step("cleanup", STEP_KIND.operation, {
					failurePolicy: FAILURE_POLICY.alwaysRun,
				}),
			]),
		);
		expect(result.error?.message).toBe("context canceled");
		expect(order).toEqual(["cleanup"]);
	});

	test("a handler that throws fails its step without failing the engine", async () => {
		const engine = new Engine({
			handlers: new Map([
				[
					STEP_KIND.operation,
					{
						execute: async () => {
							throw new Error("handler exploded");
						},
					},
				],
			]),
		});
		const result = await engine.run(
			new AbortController().signal,
			"run",
			action([step("work", STEP_KIND.operation)]),
		);
		expect(result.error?.message).toBe("handler exploded");
	});
});

describe("leases, cancellation and late results", () => {
	test("a shared lease waits for and mirrors the canonical result", async () => {
		const coordinator = new Coordinator();
		const owner = coordinator.acquire("dep/db", ["container:db"]);
		expect(owner.owner()).toBe(true);
		const shared = coordinator.acquire("dep/db", ["container:db"]);
		expect(shared.owner()).toBe(false);

		const waiting = shared.wait();
		owner.release({ outcome: OUTCOME.executed });
		expect((await waiting).outcome).toBe(OUTCOME.executed);
	});

	test("a completed failure is retried once its scope is cleared", () => {
		const coordinator = new Coordinator();
		const first = coordinator.acquire("run:dep/db");
		expect(first.owner()).toBe(true);
		first.release({ outcome: OUTCOME.failed, error: new Error("pull failed") });

		const stale = coordinator.acquire("run:dep/db");
		expect(stale.owner()).toBe(false);
		expect(stale.outcome()).toBe(OUTCOME.failed);

		coordinator.clearScope("run");
		const retry = coordinator.acquire("run:dep/db");
		expect(retry.owner()).toBe(true);
	});

	test("an already-running resource yields the outcome with no owner", () => {
		let checks = 0;
		const coordinator = new Coordinator(() => {
			checks++;
			return true;
		});
		const lease = coordinator.acquire("dep/db");
		expect(lease.owner()).toBe(false);
		expect(lease.outcome()).toBe(OUTCOME.alreadyRunning);
		expect(checks).toBe(1);
	});

	test("claims are ordered and released with the lease", () => {
		const coordinator = new Coordinator();
		const one = coordinator.acquire("one", ["b", "a"]);
		expect(() => coordinator.acquire("two", ["a"])).toThrow(ClaimConflict);
		try {
			coordinator.acquire("two", ["a"]);
		} catch (error) {
			expect(error).toBeInstanceOf(ClaimConflict);
			expect((error as ClaimConflict).claim).toBe("a");
			expect((error as ClaimConflict).owner).toBe("one");
		}
		one.release({ outcome: OUTCOME.failed });
		expect(coordinator.acquire("two", ["a"]).owner()).toBe(true);
	});

	test("a non-owner release is dropped, so a late result cannot publish", () => {
		const coordinator = new Coordinator();
		const owner = coordinator.acquire("dep/db", ["container:db"]);
		const shared = coordinator.acquire("dep/db", ["container:db"]);
		// A late result from the non-owner must not overwrite the canonical one.
		shared.release({ outcome: OUTCOME.failed, error: new Error("late") });
		owner.release({ outcome: OUTCOME.executed });
		expect(shared.outcome()).toBe(OUTCOME.executed);
	});

	test("only the first release of an owner publishes", () => {
		const coordinator = new Coordinator();
		const owner = coordinator.acquire("dep/db");
		owner.release({ outcome: OUTCOME.executed });
		owner.release({ outcome: OUTCOME.failed });
		expect(owner.outcome()).toBe(OUTCOME.executed);
	});

	test("a cancelled wait rejects instead of hanging", async () => {
		const coordinator = new Coordinator();
		const owner = coordinator.acquire("dep/db");
		const shared = coordinator.acquire("dep/db");
		const controller = new AbortController();
		const waiting = shared.wait(controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
		owner.release({ outcome: OUTCOME.executed });
	});

	test("resource claims come from the step configuration", async () => {
		const coordinator = new Coordinator();
		const handler = {
			execute: async (): Promise<StepResult> => ({ outcome: OUTCOME.executed }),
		};
		const engine = new Engine({
			handlers: new Map([[STEP_KIND.operation, handler]]),
			coordinator,
		});
		const definition = action([
			step("db", STEP_KIND.operation, {
				executionKey: "dep/db",
				configuration: { resourceClaims: ["container:db"] },
			}),
		]);
		await engine.run(new AbortController().signal, "run-1", definition);
		// The claim was released with the step, so a new owner can take it.
		expect(coordinator.acquire("other", ["container:db"]).owner()).toBe(true);
	});
});

describe("run projection", () => {
	test("stores definition identity, outcome and shared references", () => {
		const registry = new RunRegistry();
		registry.start(
			{ id: "run", title: "Run", status: RUN_STATUS.active, steps: [] },
			"api",
			"run",
		);
		const projection = new ActionRunProjection(registry);
		projection.emit({
			type: "step.started",
			runId: "run",
			stepId: "canonical",
			label: "Start db",
			at: "2026-01-01T00:00:00.000Z",
		});
		projection.emit({
			type: "step.completed",
			runId: "run",
			stepId: "canonical",
			outcome: OUTCOME.alreadyRunning,
			at: "2026-01-01T00:00:01.000Z",
		});
		projection.emit({
			type: "step.reference",
			runId: "run",
			stepId: "reference",
			canonicalId: "canonical",
			reference: true,
			label: "Start db",
			at: "2026-01-01T00:00:02.000Z",
		});

		const run = registry.get("run");
		expect(run?.steps).toHaveLength(2);
		expect(run?.steps[0]).toMatchObject({
			id: "canonical",
			definitionId: "canonical",
			status: RUN_STATUS.completed,
			outcome: OUTCOME.alreadyRunning,
			finishedAt: "2026-01-01T00:00:01.000Z",
		});
		expect(run?.steps[1]).toMatchObject({
			id: "reference",
			sharedReference: true,
			canonicalId: "canonical",
		});
	});

	test("a failed step records its error and outcome", () => {
		const registry = new RunRegistry();
		registry.start(
			{ id: "run", title: "Run", status: RUN_STATUS.active, steps: [] },
			"api",
			"run",
		);
		const projection = new ActionRunProjection(registry);
		projection.emit({
			type: "step.started",
			runId: "run",
			stepId: "pull",
			label: "Pull",
			at: "2026-01-01T00:00:00.000Z",
		});
		projection.emit({
			type: "step.failed",
			runId: "run",
			stepId: "pull",
			outcome: OUTCOME.failed,
			error: "exit status 1",
			at: "2026-01-01T00:00:01.000Z",
		});
		expect(registry.get("run")?.steps[0]).toMatchObject({
			status: RUN_STATUS.failed,
			outcome: OUTCOME.failed,
			error: "exit status 1",
		});
	});

	test("a composite that runs no command produces no command record", async () => {
		const registry = new RunRegistry();
		registry.start(
			{ id: "run", title: "Run", status: RUN_STATUS.active, steps: [] },
			"api",
			"run",
		);
		const recorded = recorder();
		const command = new CommandHandler(
			{ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			recorded.commandSink,
		);
		const engine = new Engine({
			handlers: new Map([[STEP_KIND.command, command]]),
			events: {
				emit: (event) => {
					recorded.sink.emit(event);
					new ActionRunProjection(registry).emit(event);
				},
			},
		});
		await engine.run(
			new AbortController().signal,
			"run",
			action([
				step("build", STEP_KIND.command, {
					configuration: { command: "sh", args: ["build.sh"] },
				}),
			]),
		);

		const run = registry.get("run");
		expect(run?.steps.map((s) => [s.id, s.commands.length])).toEqual([
			["root", 0],
			["build", 0],
		]);
		// The command lives on its own leaf through the command events, and the
		// composite that only groups steps owns none.
		expect(
			recorded.commands.filter((e) => e.type === "command.started"),
		).toHaveLength(1);
		expect(
			recorded.commands.filter((e) => e.type === "command.completed"),
		).toHaveLength(1);
	});

	test("the command identity is derived from the step, exactly once", async () => {
		const recorded = recorder();
		const seen: string[] = [];
		const runner: CommandRunner = {
			run: async (spec) => {
				seen.push(spec.commandId ?? "");
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		const command = new CommandHandler(runner, recorded.commandSink);
		await new Engine({
			handlers: new Map([[STEP_KIND.command, command]]),
		}).run(
			new AbortController().signal,
			"run",
			action([
				step("one", STEP_KIND.command, { configuration: { command: "sh" } }),
				step("two", STEP_KIND.command, { configuration: { command: "sh" } }),
			]),
		);
		expect(seen).toEqual(["one-command-0", "two-command-0"]);
	});
});

describe("a skipped step produces no command", () => {
	test("a step after a failure emits no command event and no command leaf", async () => {
		const recorded = recorder();
		const command = new CommandHandler(
			new OSCommandRunner(),
			recorded.commandSink,
		);
		const engine = new Engine({
			handlers: new Map([[STEP_KIND.command, command]]),
			events: recorded.sink,
		});
		const result = await engine.run(
			new AbortController().signal,
			"run",
			action([
				step("fail", STEP_KIND.command, {
					configuration: {
						command: "sh",
						args: ["-c", "echo nope >&2; exit 1"],
					},
				}),
				step("never", STEP_KIND.command, {
					configuration: { command: "sh", args: ["-c", "true"] },
				}),
			]),
		);
		expect(result.outcome).toBe(OUTCOME.failed);
		expect(recorded.commands.map((e) => `${e.type}:${e.stepId}`)).toEqual([
			"command.started:fail",
			"command.output:fail",
			"command.failed:fail",
		]);
		expect(recorded.commands[2]).toMatchObject({
			exitCode: 1,
			error: "exit status 1",
		});
		expect(recorded.commands[1]).toMatchObject({
			stream: "stderr",
			chunk: "nope\n",
		});
		// No placeholder step for the work that did not execute.
		expect(summary(recorded.events).includes("step.started:never")).toBe(false);
	});
});
