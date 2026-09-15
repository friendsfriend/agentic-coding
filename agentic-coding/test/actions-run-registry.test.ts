// Run reservation, history retention and definition snapshots
// (`port-action-execution-to-bun`, task 1.4).
//
// Ported from `server/pkg/actionrun/{registry,snapshot}_test.go`, plus the
// reload contract the spec requires: a configuration reload must not alter an
// active or historical run's version or definition snapshot.
import { describe, expect, test } from "bun:test";
import type { ActionDefinition, ActionRun } from "@devenv/types";
import { compileGitActions } from "../src/server/actions/compile.ts";
import { ActionRegistry } from "../src/server/actions/registry.ts";
import {
	definitionSnapshot,
	HISTORY_RETENTION_MS,
	RUN_STATUS,
	RunRegistry,
} from "../src/server/actions/run-registry.ts";

/** A clock the test controls, so retention boundaries are exact. */
function clock(start: Date): {
	now: () => Date;
	advance: (ms: number) => void;
} {
	let current = start.getTime();
	return {
		now: () => new Date(current),
		advance: (ms: number) => {
			current += ms;
		},
	};
}

function run(
	id: string,
	status: ActionRun["status"] = RUN_STATUS.active,
): ActionRun {
	return { id, title: id, status, steps: [] };
}

describe("reservation", () => {
	test("rejects a duplicate app/action while the first run is active", () => {
		const registry = new RunRegistry();
		registry.start(run("r1"), "app", "build", ["db"]);
		expect(() => registry.start(run("r2"), "app", "build")).toThrow(
			/build action already active for app \(run r1\)/,
		);
	});

	test("a reserved slot is claimed by the run that starts", () => {
		const registry = new RunRegistry();
		registry.reserve("app", "build");
		registry.start(run("r1"), "app", "build");
		expect(() => registry.start(run("r2"), "app", "build")).toThrow(/run r1/);
	});

	test("reserving twice is rejected before any run exists", () => {
		const registry = new RunRegistry();
		registry.reserve("app", "build");
		expect(() => registry.reserve("app", "build")).toThrow(
			/already active for app/,
		);
	});

	test("release frees the slot without a run", () => {
		const registry = new RunRegistry();
		registry.reserve("app", "build");
		registry.release("app", "build");
		expect(() => registry.start(run("r1"), "app", "build")).not.toThrow();
	});

	test("different actions and different apps coexist", () => {
		const registry = new RunRegistry();
		registry.start(run("build"), "app", "build", ["db"]);
		registry.start(run("test"), "app", "test", ["db"]);
		registry.start(run("other"), "other", "build", ["db"]);
		expect(registry.active()).toHaveLength(3);
		expect(registry.activeForApp("app").map((r) => r.id)).toEqual([
			"build",
			"test",
		]);
	});

	test("start stamps the identity and the start time the run omitted", () => {
		const time = clock(new Date("2026-01-01T00:00:00.000Z"));
		const registry = new RunRegistry(time.now);
		const started = run("r1");
		registry.start(started, "app", "build");
		expect(started.appIdent).toBe("app");
		expect(started.action).toBe("build");
		expect(started.startedAt).toBe("2026-01-01T00:00:00.000Z");

		const explicit = run("r2");
		registry.start(
			{ ...explicit, startedAt: "2025-12-31T23:00:00.000Z" },
			"app",
			"test",
		);
		expect(registry.get("r2")?.startedAt).toBe("2025-12-31T23:00:00.000Z");
	});

	test("completing frees the slot so the action can run again", () => {
		const registry = new RunRegistry();
		registry.start(run("r1"), "app", "build", ["db"]);
		registry.complete("r1", RUN_STATUS.completed);
		expect(registry.get("r1")?.status).toBe(RUN_STATUS.completed);
		expect(registry.active()).toHaveLength(0);
		expect(() => registry.start(run("r2"), "app", "build")).not.toThrow();
	});

	test("cancel records the terminal canceled status", () => {
		const registry = new RunRegistry();
		registry.start(run("r1"), "app", "build");
		registry.cancel("r1");
		expect(registry.get("r1")?.status).toBe(RUN_STATUS.canceled);
		expect(registry.get("r1")?.finishedAt).toBeDefined();
		expect(registry.active()).toHaveLength(0);
	});

	test("a dependency held by a run is released with it", () => {
		const registry = new RunRegistry();
		registry.start(run("r1"), "app", "build", ["db"]);
		registry.complete("r1", RUN_STATUS.failed);
		// The next run can claim the same dependency and slot.
		expect(() =>
			registry.start(run("r2"), "app", "build", ["db"]),
		).not.toThrow();
	});
});

describe("history retention", () => {
	test("keeps a finished run for a day and prunes it after that", () => {
		const time = clock(new Date("2026-01-01T00:00:00.000Z"));
		const registry = new RunRegistry(time.now);
		registry.start(run("r1"), "app", "build");
		registry.complete("r1", RUN_STATUS.completed);

		time.advance(HISTORY_RETENTION_MS - 60_000);
		registry.cleanup();
		expect(registry.get("r1")).toBeDefined();

		time.advance(120_000);
		registry.cleanup();
		expect(registry.get("r1")).toBeUndefined();
	});

	test("an unfinished run is never pruned", () => {
		const time = clock(new Date("2026-01-01T00:00:00.000Z"));
		const registry = new RunRegistry(time.now);
		registry.start(run("r1"), "app", "build");
		time.advance(HISTORY_RETENTION_MS * 30);
		registry.cleanup();
		expect(registry.get("r1")).toBeDefined();
	});
});

describe("step accounting helpers", () => {
	test("addStep is idempotent so pre-declared steps are never duplicated", () => {
		const registry = new RunRegistry();
		registry.start(
			{
				...run("r1"),
				steps: [{ id: "step-a", label: "A", status: "active", commands: [] }],
			},
			"app",
			"build",
		);
		expect(registry.hasStep("r1", "step-a")).toBe(true);
		registry.addStep("r1", {
			id: "step-a",
			label: "Duplicate",
			status: "active",
			commands: [],
		});
		registry.addStep("r1", {
			id: "step-b",
			label: "B",
			status: "active",
			commands: [],
		});
		expect(registry.get("r1")?.steps.map((s) => s.label)).toEqual(["A", "B"]);
		expect(registry.hasStep("missing", "step-a")).toBe(false);
	});

	test("updateStep targets one step and ignores unknown ids", () => {
		const registry = new RunRegistry();
		registry.start(
			{
				...run("r1"),
				steps: [
					{ id: "step-a", label: "A", status: "active", commands: [] },
					{ id: "step-b", label: "B", status: "active", commands: [] },
				],
			},
			"app",
			"build",
		);
		registry.updateStep("r1", "step-b", (step) => {
			step.status = RUN_STATUS.completed;
		});
		registry.updateStep("r1", "missing", () => {
			throw new Error("must not run");
		});
		expect(registry.get("r1")?.steps.map((s) => s.status)).toEqual([
			RUN_STATUS.active,
			RUN_STATUS.completed,
		]);
	});

	test("updating an unknown run is a no-op", () => {
		const registry = new RunRegistry();
		expect(() =>
			registry.complete("missing", RUN_STATUS.completed),
		).not.toThrow();
		registry.updateRun("missing", () => {
			throw new Error("must not run");
		});
		expect(registry.get("missing")).toBeUndefined();
	});
});

describe("definition snapshots", () => {
	function actionWithSecrets(): ActionDefinition {
		return {
			id: "app/api/action/deploy/default",
			owner: { kind: "app", id: "api" },
			type: "deploy",
			runtime: "shell",
			label: "Deploy",
			inputs: [
				{
					key: "token",
					type: "secret",
					scope: "action",
					visibility: "secret",
					default: "plaintext-token",
				},
				{
					key: "branch",
					type: "string",
					scope: "action",
					visibility: "public",
					default: "main",
				},
				{
					key: "scratch",
					type: "path",
					scope: "step",
					visibility: "ephemeral",
					default: "/tmp/plaintext-scratch",
				},
			],
			availability: { available: true },
			root: {
				id: "root",
				kind: "composite",
				label: "Deploy",
				children: [
					{
						id: "run",
						kind: "command",
						label: "Run",
						consumes: [
							{
								key: "token",
								type: "secret",
								scope: "action",
								visibility: "secret",
							},
							{
								key: "branch",
								type: "string",
								scope: "action",
								visibility: "public",
							},
						],
						produces: [
							{
								key: "endpoint.api",
								type: "endpoint",
								scope: "action",
								visibility: "public",
							},
							{
								key: "handle",
								type: "secret-handle",
								scope: "action",
								visibility: "secret",
							},
						],
						handler: "shell",
						configuration: {
							command: "deploy",
							args: ["--token", "plaintext-token"],
						},
					},
				],
			},
		};
	}

	test("strips executable configuration, protected defaults and protected ports", () => {
		const snapshot = definitionSnapshot(actionWithSecrets());
		const encoded = JSON.stringify(snapshot);
		expect(encoded).not.toContain("plaintext-token");
		expect(encoded).not.toContain("--token");
		expect(encoded).not.toContain("plaintext-scratch");
		expect(snapshot.root.children?.[0]?.configuration).toBeUndefined();
		expect(snapshot.root.children?.[0]?.produces?.map((p) => p.key)).toEqual([
			"endpoint.api",
		]);
		expect(snapshot.root.children?.[0]?.consumes?.map((p) => p.key)).toEqual([
			"branch",
		]);
	});

	test("keeps the public default and the history chrome", () => {
		const snapshot = definitionSnapshot(actionWithSecrets());
		expect(snapshot.inputs.map((i) => [i.key, i.default])).toEqual([
			["token", undefined],
			["branch", "main"],
			["scratch", undefined],
		]);
		expect(snapshot.root.children?.[0]?.label).toBe("Run");
		expect(snapshot.label).toBe("Deploy");
	});

	test("does not mutate the definition it snapshots", () => {
		const definition = actionWithSecrets();
		definitionSnapshot(definition);
		expect(definition.root.children?.[0]?.configuration).toBeDefined();
		expect(definition.root.children?.[0]?.produces).toHaveLength(2);
	});

	test("a snapshot of a compiled definition leaks no command line", () => {
		const [definition] = compileGitActions("api", "/checkout");
		if (!definition) throw new Error("no definition");
		const snapshot = definitionSnapshot(definition);
		expect(JSON.stringify(snapshot)).not.toContain("refs/remotes/origin");
		expect(snapshot.root.children?.[0]?.configuration).toBeUndefined();
		expect(snapshot.root.children?.map((c) => c.label)).toEqual([
			"Get ref",
			"Fetch",
			"Pull",
		]);
	});
});

describe("a reload cannot alter an active or historical run", () => {
	test("the run keeps its registry version and definition snapshot", async () => {
		const registry = new ActionRegistry();
		const first = await registry.rebuild([
			{ name: "git", compile: () => compileGitActions("api", "/checkout") },
		]);
		const definition = first.get("app/api/action/push/git/default");
		if (!definition) throw new Error("no definition");

		const runs = new RunRegistry();
		runs.start(
			{
				...run("r1"),
				registryVersion: first.version,
				definitionSnapshot: definitionSnapshot(definition),
			},
			"api",
			"push",
		);

		// A reload publishes a new version with a differently labelled
		// definition of the same id.
		const second = await registry.rebuild([
			{
				name: "git",
				compile: () => [
					{
						...(compileGitActions("api", "/checkout")[2] as ActionDefinition),
						label: "Reloaded label",
					},
				],
			},
		]);
		expect(second.version).toBe(first.version + 1);
		expect(second.get("app/api/action/push/git/default")?.label).toBe(
			"Reloaded label",
		);

		const active = runs.get("r1");
		expect(active?.registryVersion).toBe(1);
		expect(active?.definitionSnapshot?.label).toBe("Push");

		// The historical view is the same object, still on version 1.
		runs.complete("r1", RUN_STATUS.completed);
		expect(runs.get("r1")?.registryVersion).toBe(1);
		expect(runs.get("r1")?.definitionSnapshot?.root.children).toHaveLength(1);
	});
});
