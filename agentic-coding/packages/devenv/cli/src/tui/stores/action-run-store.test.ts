import { describe, expect, test } from "bun:test";
import { createActionRunStore } from "./action-run-store";

/** Poll for the debounced store flush instead of sleeping a fixed interval, so
 * a loaded machine cannot make the stdout/stderr assertions flake. */
async function waitUntil(
	predicate: () => unknown,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for store update");
}

describe("action run store", () => {
	const run = {
		id: "r1",
		title: "Run",
		status: "active" as const,
		steps: [
			{ id: "one", label: "One", command: "one", status: "pending" as const },
			{ id: "two", label: "Two", command: "two", status: "pending" as const },
		],
	};
	test("hydrates removed action history from definition snapshot", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: {
				id: "old",
				title: "Old action",
				status: "completed",
				steps: [],
				definitionSnapshot: {
					id: "removed",
					owner: { kind: "app", id: "api" },
					type: "build",
					runtime: "docker",
					label: "Docker",
					inputs: [],
					availability: { available: false },
					root: {
						id: "root",
						kind: "composite",
						label: "Build api",
						children: [{ id: "build", kind: "command", label: "Build image" }],
					},
				},
			},
		});
		expect(store.run()?.steps.map((step) => step.label)).toEqual([
			"Build api",
			"Build image",
		]);
	});

	test("tracks lifecycle, output, and automatic focus", async () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", { run });
		expect(store.focusedNode()).toBe("action");
		expect(store.focusedTreeKey()).toBe("action:r1");
		store.handleEvent("action.step.started", {
			runId: "r1",
			stepId: "one",
			command: "one",
		});
		store.handleEvent("action.step.output", {
			runId: "r1",
			stepId: "one",
			output: "hello",
			stream: "stdout",
		});
		expect(store.focusedNode()).toBe("action");
		await waitUntil(() => store.run()?.steps[0].commands[0].stdout === "hello");
		expect(store.run()?.steps[0].commands[0].stdout).toBe("hello");
		store.handleEvent("action.step.failed", {
			runId: "r1",
			stepId: "two",
			error: "bad",
		});
		expect(store.focusedStepId()).toBe("two");
	});
	test("propagates failure onto a still-active command when the owning step fails without its own command.failed event", async () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", { run });
		store.handleEvent("action.command.started", {
			runId: "r1",
			stepId: "one",
			commandId: "compose",
			command: "podman-compose up -d",
		});
		store.handleEvent("action.command.completed", {
			runId: "r1",
			stepId: "one",
			commandId: "compose",
			exitCode: 0,
		});
		store.handleEvent("action.step.output", {
			runId: "r1",
			stepId: "one",
			commandId: "diag",
			output: "readiness postgres: inspect error\n",
			stream: "stdout",
		});
		await waitUntil(() =>
			store
				.run()
				?.steps[0].commands.some(
					(c) =>
						c.id === "diag" &&
						c.stdout === "readiness postgres: inspect error\n",
				),
		);
		store.handleEvent("action.step.failed", {
			runId: "r1",
			stepId: "one",
			error: "dependency failed readiness",
		});
		const step = store.run()?.steps.find((s) => s.id === "one");
		if (!step) throw new Error("expected step one");
		const composeCommand = step.commands.find((c) => c.id === "compose");
		if (!composeCommand) throw new Error("expected compose command");
		const diagnosticCommand = step.commands.find((c) => c.id === "diag");
		if (!diagnosticCommand) throw new Error("expected diag command");
		expect(composeCommand.status).toBe("completed");
		expect(diagnosticCommand.status).toBe("failed");
		expect(diagnosticCommand.error).toBe("dependency failed readiness");
	});
	test("adds one step per dynamically reported backend command", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: { ...run, action: "git.pull", steps: [] },
		});
		store.handleEvent("action.step.started", {
			runId: "r1",
			stepId: "ref",
			label: "Get ref",
		});
		store.handleEvent("action.command.started", {
			runId: "r1",
			stepId: "ref",
			commandId: "ref-command-0",
			command: "git rev-parse HEAD",
		});
		store.handleEvent("action.step.started", {
			runId: "r1",
			stepId: "fetch",
			label: "Fetch",
		});
		store.handleEvent("action.command.started", {
			runId: "r1",
			stepId: "fetch",
			commandId: "fetch-command-0",
			command: "git fetch origin",
		});
		expect(
			store.run()?.steps.map((step) => [step.label, step.commands.length]),
		).toEqual([
			["Get ref", 1],
			["Fetch", 1],
		]);
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind !== "loadOlder")
				.map((node) => node.kind),
		).toEqual(["action", "step", "step"]);
	});
	test("retains command exit code and failure output metadata", async () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", { run });
		store.handleEvent("action.command.started", {
			runId: "r1",
			stepId: "one",
			commandId: "cmd",
			command: "git pull",
		});
		store.handleEvent("action.command.output", {
			runId: "r1",
			stepId: "one",
			commandId: "cmd",
			stream: "stderr",
			output: "rejected",
		});
		store.handleEvent("action.command.failed", {
			runId: "r1",
			stepId: "one",
			commandId: "cmd",
			error: "rejected",
			exitCode: 1,
		});
		await waitUntil(() => {
			const cmd = store.run()?.steps[0].commands.find((c) => c.id === "cmd");
			return cmd?.exitCode === 1 && cmd?.stderr === "rejected";
		});
		const command = store
			.run()
			?.steps[0].commands.find((item) => item.id === "cmd");
		if (!command) throw new Error("expected cmd command");
		expect(command.exitCode).toBe(1);
		expect(command.stderr).toBe("rejected");
	});
	test("failed step focus and final status", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", { run });
		store.handleEvent("action.step.failed", {
			runId: "r1",
			stepId: "two",
			error: "broken",
		});
		store.handleEvent("action.completed", { runId: "r1", status: "failed" });
		expect(store.focusedStepId()).toBe("two");
		expect(store.run()?.steps[1].status).toBe("failed");
		expect(store.run()?.status).toBe("failed");
	});
	test("retains multiple command streams per step", async () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: {
				...run,
				steps: [
					{
						id: "one",
						label: "Start dependency: db",
						status: "pending",
						commands: [],
					},
				],
			},
		});
		store.handleEvent("action.command.started", {
			runId: "r1",
			stepId: "one",
			commandId: "c1",
			command: "docker-compose up db",
		});
		store.handleEvent("action.command.output", {
			runId: "r1",
			stepId: "one",
			commandId: "c1",
			stream: "stdout",
			output: "started\n",
		});
		store.handleEvent("action.command.completed", {
			runId: "r1",
			stepId: "one",
			commandId: "c1",
		});
		store.handleEvent("action.command.started", {
			runId: "r1",
			stepId: "one",
			commandId: "c2",
			command: "docker inspect db",
		});
		store.handleEvent("action.command.output", {
			runId: "r1",
			stepId: "one",
			commandId: "c2",
			stream: "stderr",
			output: "waiting\n",
		});
		await waitUntil(
			() => store.run()?.steps[0].commands[1]?.stderr === "waiting\n",
		);
		expect(store.run()?.steps[0].commands.map((c) => c.command)).toEqual([
			"docker-compose up db",
			"docker inspect db",
		]);
		expect(store.run()?.steps[0].commands[0].stdout).toBe("started\n");
		expect(store.run()?.steps[0].commands[1].stderr).toBe("waiting\n");
	});
	test("propagates failed status to step parents only", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: {
				...run,
				steps: [
					{
						id: "root",
						label: "root",
						status: "active",
						commands: [],
						depth: 0,
					},
					{
						id: "dep",
						label: "dep",
						status: "active",
						parentId: "root",
						commands: [],
						depth: 1,
					},
					{
						id: "leaf",
						label: "leaf",
						status: "pending",
						parentId: "dep",
						commands: [],
						depth: 2,
					},
					{
						id: "other",
						label: "other",
						status: "pending",
						parentId: "root",
						commands: [],
						depth: 1,
					},
				],
			},
		});
		store.handleEvent("action.step.failed", {
			runId: "r1",
			stepId: "leaf",
			error: "failed",
		});
		expect(store.run()?.steps.find((s) => s.id === "root")?.status).toBe(
			"failed",
		);
		expect(store.run()?.steps.find((s) => s.id === "dep")?.status).toBe(
			"failed",
		);
		expect(store.run()?.steps.find((s) => s.id === "other")?.status).toBe(
			"pending",
		);
	});
	test("manual focus disables automatic focus", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", { run });
		store.focusStep("one");
		store.handleEvent("action.step.started", {
			runId: "r1",
			stepId: "two",
			command: "two",
		});
		expect(store.focusedStepId()).toBe("one");
	});
	test("loads logs only for selected nodes", async () => {
		const store = createActionRunStore();
		const requests: Array<[string, string | undefined]> = [];
		store.configureLogsLoader(async (runId, stepId) => {
			requests.push([runId, stepId]);
		});
		store.handleEvent("action.started", { run });
		store.focusStep("two");
		await store.loadLogsForNode(store.selectedNode());
		store.selectRun("r1");
		await store.loadLogsForNode(store.selectedNode());
		await store.loadLogsForNode(store.selectedNode());
		expect(requests).toEqual([
			["r1", "two"],
			["r1", undefined],
		]);
	});
	test("loads older history once and restores action focus", async () => {
		const store = createActionRunStore();
		let loads = 0;
		let release!: () => void;
		store.handleEvent("action.started", { run });
		store.configureHistoryLoader(async () => {
			loads++;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		store.focusTreeNode(store.visibleNodes()[0]);
		const first = store.loadOlderHistory();
		const second = store.loadOlderHistory();
		expect(loads).toBe(1);
		release();
		await Promise.all([first, second]);
		expect(store.hasOlderHistory()).toBe(false);
		expect(store.visibleNodes().some((node) => node.kind === "loadOlder")).toBe(
			false,
		);
		expect(store.focusedTreeKey()).toBe("action:r1");
	});
	test("hides finished actions on reopen until history is loaded", async () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: { ...run, id: "old", status: "completed" },
		});
		store.handleEvent("action.started", { run: { ...run, id: "current" } });
		store.openModal();
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind === "action")
				.map((node) => node.run.id),
		).toEqual(["current"]);
		store.handleEvent("action.completed", {
			runId: "current",
			status: "completed",
		});
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind === "action")
				.map((node) => node.run.id),
		).toEqual(["current"]);
		store.closeModal();
		store.openModal();
		expect(
			store.visibleNodes().filter((node) => node.kind === "action"),
		).toEqual([]);
		await store.loadOlderHistory();
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind === "action")
				.map((node) => node.run.id),
		).toEqual(["old", "current"]);
	});
	test("history replay preserves current selection and chronological run order", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: { ...run, id: "recent", startedAt: "2026-01-02T00:00:00Z" },
		});
		store.handleEvent(
			"action.started",
			{ run: { ...run, id: "older", startedAt: "2026-01-01T00:00:00Z" } },
			"history",
		);
		expect(store.selectedRunId()).toBe("recent");
		expect(store.runs().map((item) => item.id)).toEqual(["older", "recent"]);
	});
	test("isolates repeated actions by unique run id", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", { run: { ...run, id: "first" } });
		store.handleEvent("action.started", { run: { ...run, id: "second" } });
		store.handleEvent("action.step.completed", {
			runId: "first",
			stepId: "one",
		});
		expect(store.runs()).toHaveLength(2);
		expect(
			store.runs().find((item) => item.id === "first")?.steps[0].status,
		).toBe("completed");
		expect(
			store.runs().find((item) => item.id === "second")?.steps[0].status,
		).toBe("pending");
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind === "action")
				.map((node) => node.key),
		).toEqual(["action:first", "action:second"]);
	});
	test("renders every structurally single-step action without a redundant substep", () => {
		for (const action of [
			"build",
			"test",
			"stop",
			"git.fetch",
			"kubernetes.cluster.create",
		] as const) {
			const store = createActionRunStore();
			store.handleEvent("action.started", {
				run: {
					...run,
					action,
					profile: "default",
					steps: [
						{
							id: action,
							label: `${action} app`,
							status: "active",
							commands: [],
						},
					],
				},
			});
			expect(
				store
					.visibleNodes()
					.filter((node) => node.kind !== "loadOlder")
					.map((node) => node.kind),
			).toEqual(["action"]);
			expect(store.selectedNode()?.kind).toBe("action");
			store.handleEvent("action.step.failed", {
				runId: "r1",
				stepId: action,
				error: "failed",
			});
			expect(store.focusedNode()).toBe("action");
		}
	});
	test("flattens recursive tree and hides descendants of collapsed nodes", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: {
				...run,
				steps: [
					{ id: "dep", label: "dependency", status: "active", commands: [] },
					{
						id: "sub",
						label: "subdependency",
						status: "active",
						parentId: "dep",
						commands: [],
					},
					{ id: "other", label: "other", status: "pending", commands: [] },
				],
			},
		});
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind !== "loadOlder")
				.map((node) => (node.kind === "action" ? node.run.id : node.step.id)),
		).toEqual(["r1", "dep", "sub", "other"]);
		store.focusStep("dep");
		store.toggleStep("dep");
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind !== "loadOlder")
				.map((node) => (node.kind === "action" ? node.run.id : node.step.id)),
		).toEqual(["r1", "dep", "other"]);
	});
	test("collapses successful action and composite steps on completion", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: {
				...run,
				steps: [
					{ id: "root", label: "Root", status: "pending", commands: [] },
					{
						id: "child",
						label: "Child",
						status: "pending",
						parentId: "root",
						commands: [],
					},
				],
			},
		});
		store.focusStep("child");
		// Composite step (root has child 'child') should collapse on completion and retain focus.
		store.handleEvent("action.step.completed", { runId: "r1", stepId: "root" });
		expect(store.run()?.steps.find((s) => s.id === "root")?.collapsed).toBe(
			true,
		);
		expect(store.focusedStepId()).toBe("root");
		expect(store.focusedTreeKey()).toBe("step:r1:root");
		// Leaf step (child has no children) should NOT collapse on completion
		store.handleEvent("action.step.completed", {
			runId: "r1",
			stepId: "child",
		});
		expect(
			store.run()?.steps.find((s) => s.id === "child")?.collapsed,
		).not.toBe(true);
		// Action should always collapse on completion
		store.handleEvent("action.completed", { runId: "r1", status: "completed" });
		expect(store.run()?.collapsed).toBe(true);
		expect(
			store.run()?.steps.every((step) => step.status === "completed"),
		).toBe(true);
		expect(store.focusedNode()).toBe("action");
		expect(store.focusedTreeKey()).toBe("action:r1");
	});
	test("failure expands only ancestors leading to failed leaf", () => {
		const store = createActionRunStore();
		store.handleEvent("action.started", {
			run: {
				...run,
				collapsed: true,
				steps: [
					{
						id: "root",
						label: "root",
						status: "active",
						commands: [],
						collapsed: true,
					},
					{
						id: "dep",
						label: "dep",
						status: "active",
						parentId: "root",
						commands: [],
						collapsed: true,
					},
					{
						id: "leaf",
						label: "leaf",
						status: "pending",
						parentId: "dep",
						commands: [],
					},
					{
						id: "other",
						label: "other",
						status: "active",
						parentId: "root",
						commands: [],
						collapsed: false,
					},
					{
						id: "other-leaf",
						label: "other leaf",
						status: "pending",
						parentId: "other",
						commands: [],
					},
				],
			},
		});
		store.handleEvent("action.step.failed", {
			runId: "r1",
			stepId: "leaf",
			error: "failed",
		});
		expect(store.run()?.collapsed).toBe(false);
		expect(
			store.run()?.steps.find((step) => step.id === "root")?.collapsed,
		).toBe(false);
		expect(
			store.run()?.steps.find((step) => step.id === "dep")?.collapsed,
		).toBe(false);
		expect(
			store.run()?.steps.find((step) => step.id === "other")?.collapsed,
		).toBe(true);
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind !== "loadOlder")
				.map((node) => (node.kind === "action" ? node.run.id : node.step.id)),
		).toEqual(["r1", "root", "dep", "leaf", "other"]);
		expect(store.focusedStepId()).toBe("leaf");
		store.handleEvent("action.completed", { runId: "r1", status: "failed" });
		expect(
			store
				.visibleNodes()
				.filter((node) => node.kind !== "loadOlder")
				.map((node) => (node.kind === "action" ? node.run.id : node.step.id)),
		).toContain("leaf");
		expect(
			store.run()?.steps.find((step) => step.id === "root")?.collapsed,
		).toBe(false);
		expect(
			store.run()?.steps.find((step) => step.id === "dep")?.collapsed,
		).toBe(false);
	});
});
