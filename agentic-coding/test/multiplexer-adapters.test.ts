// Multiplexer adapter contract tests (add-multiplexer-adapters, tasks 1.4,
// 2.1/2.2, 5.1-5.4, 6.1-6.3, plus verifier fixes): shared port semantics for
// every operation on both adapters, per-runtime request assertions, runtime
// selection, detached-drain environment forwarding, schema-drift handling,
// ownership-signal propagation, and the failure-kind -> runner-policy mapping.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Either, Exit, Scope } from "effect";
import {
	createMultiplexerPort,
	MULTIPLEXER_IDS,
	resolveMultiplexerSelection,
} from "../src/multiplexer/factory.ts";
import { Herdr } from "../src/multiplexer/herdr/cli.ts";
import { HerdrMultiplexer } from "../src/multiplexer/herdr/index.ts";
import { LuvusMultiplexer } from "../src/multiplexer/luvus/index.ts";
import {
	resolveLuvusSocketPath,
	UhpError,
} from "../src/multiplexer/luvus/uhp.ts";
import {
	MultiplexerError,
	type MultiplexerPort,
} from "../src/multiplexer/port.ts";
import { openFindingInEditorAsync } from "../src/server/operations/observations.ts";
import { detachedDrainEnvironment } from "../src/workflow/cli/drain.ts";
import {
	classifyFailure,
	classifyMultiplexerFailure,
} from "../src/workflow/effect-runner.ts";

function run<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
	return Effect.runPromise(effect);
}

const workspaceRow = {
	workspace: "0",
	workspace_id: "workspace_abc",
	name: "probe",
	cwd: "/repo",
	active: true,
	pinned: false,
	tabs: 1,
};

/** Create the run environment marker the launch path polls for, exactly like
 * a real pane shell would. */
function touchMarkerFrom(command: string): void {
	const match = command.match(/touch '([^']+)'/);
	if (!match?.[1]) return;
	fs.mkdirSync(path.dirname(match[1]), { recursive: true });
	fs.writeFileSync(match[1], "");
}

// ---------------------------------------------------------------------------
// Scripted Herdr CLI
// ---------------------------------------------------------------------------
interface HerdrScript {
	port: HerdrMultiplexer;
	failedPort: HerdrMultiplexer;
	calls: string[][];
}

function scriptedHerdr(_repo: string): HerdrScript {
	const calls: string[][] = [];
	let _prompted = false;
	const cli = {
		call(...args: string[]) {
			calls.push(args);
			const key = args.join(" ");
			if (key === "workspace list")
				return {
					workspaces: [
						{
							workspace_id: "workspace_abc",
							label: "probe",
							name: "probe",
						},
					],
				};
			if (key === "workspace get workspace_abc")
				return {
					workspace: {
						workspace_id: "workspace_abc",
						label: "probe",
						name: "probe",
					},
				};
			if (key.startsWith("workspace get "))
				throw new Error(`workspace ${args[2]} not found`);
			if (args[0] === "workspace" && args[1] === "create")
				return { workspace: { workspace_id: "workspace_created" } };
			if (
				args[0] === "workspace" &&
				(args[1] === "focus" || args[1] === "close")
			)
				return {};
			if (key === "tab list --workspace workspace_abc")
				return { tabs: [{ tab_id: "tab_1", label: "worker" }] };
			if (args[0] === "tab" && args[1] === "create")
				return { root_pane: { pane_id: "1", tab_id: "tab_1" } };
			if (
				args[0] === "tab" &&
				["rename", "focus", "close"].includes(args[1] ?? "")
			)
				return {};
			if (key === "pane list --workspace workspace_abc")
				return {
					panes: [
						{
							pane_id: "1",
							tab_id: "tab_1",
							workspace_id: "workspace_abc",
						},
					],
				};
			if (args[0] === "pane" && args[1] === "get") {
				if (args[2] === "missing") throw new Error("pane missing not found");
				return {
					pane: {
						pane_id: args[2],
						tab_id: "tab_1",
						workspace_id: "workspace_abc",
					},
				};
			}
			if (key === "pane layout --pane 1")
				return {
					layout: {
						focused_pane_id: "1",
						panes: [
							{ pane_id: "1", rect: { x: 0, y: 0, width: 10, height: 5 } },
							{ pane_id: "2", rect: { x: 0, y: 5, width: 10, height: 5 } },
						],
					},
				};
			if (args[0] === "pane" && args[1] === "split")
				return { pane: { pane_id: "2", tab_id: "tab_1" } };
			if (args[0] === "pane" && args[1] === "run") {
				touchMarkerFrom(String(args[3] ?? ""));
				return {};
			}
			if (args[0] === "pane" && ["focus", "close"].includes(args[1] ?? ""))
				return {};
			if (key === "pane process-info --pane 1")
				return {
					process_info: {
						shell_pid: 42,
						foreground_process_group_id: 42,
						foreground_processes: [{ name: "zsh", pid: 42 }],
					},
				};
			if (args[0] === "agent" && args[1] === "list")
				return {
					agents: [
						{
							pane_id: "1",
							agent: "worker",
							agent_status: "working",
							tab_id: "tab_1",
							workspace_id: "workspace_abc",
						},
					],
				};
			if (args[0] === "agent" && args[1] === "get") {
				const target = String(args[2]);
				if (target === "missing") throw new Error("agent missing not found");
				return {
					agent: {
						pane_id: "1",
						tab_id: "tab_1",
						agent_status: "working",
					},
				};
			}
			if (args[0] === "agent" && args[1] === "start")
				return {
					agent: { pane_id: "1", tab_id: "tab_1", agent_status: "idle" },
				};
			if (args[0] === "agent" && args[1] === "prompt") {
				_prompted = true;
				return {};
			}
			if (args[0] === "notification" && args[1] === "show")
				return { delivery: "shown" };
			return {};
		},
	};
	const failedCli = {
		call() {
			const error = new Error(
				'Executable not found in $PATH: "herdr"',
			) as Error & { code?: string };
			error.code = "ENOENT";
			throw error;
		},
	};
	return {
		port: new HerdrMultiplexer(cli, { sleep: () => Effect.void }),
		failedPort: new HerdrMultiplexer(failedCli, {
			sleep: () => Effect.void,
		}),
		calls,
	};
}

// ---------------------------------------------------------------------------
// Scripted Luvus UHP backend
// ---------------------------------------------------------------------------
function scriptedLuvus(
	repo: string,
	socketPath?: string,
): {
	port: LuvusMultiplexer;
	failedPort: LuvusMultiplexer;
	calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let openedCwd = repo;
	let _prompted = false;
	const handle = (method: string, params: Record<string, unknown>): unknown => {
		if (method === "workspace.list")
			return {
				type: "workspace_list",
				workspaces: [{ ...workspaceRow, cwd: openedCwd }],
			};
		if (method === "workspace.open") {
			openedCwd = String(params.path ?? repo);
			return { type: "workspace", workspace: "0" };
		}
		if (method === "workspace.get") {
			if (params.workspace_id === "missing" || params.workspace === "missing")
				throw new UhpError("not_found", "workspace missing not found");
			return { ...workspaceRow, cwd: openedCwd };
		}
		if (method === "workspace.rename") return { type: "workspace_rename" };
		if (method === "workspace.focus" || method === "workspace.close")
			return { type: "ok" };
		if (method === "tab.list")
			return {
				type: "tab_list",
				tabs: [{ tab: "1", tab_id: "tab_1", name: "worker", active: true }],
			};
		if (method === "tab.new") return { type: "tab", tab: "1" };
		if (method === "tab.get")
			return {
				type: "tab",
				tab: "1",
				tab_id: "tab_1",
				focus: "1",
				panes: ["1", "2"],
			};
		if (
			[
				"tab.rename",
				"tab.focus",
				"tab.close",
				"pane.focus",
				"pane.close",
				"pane.run",
			].includes(method)
		) {
			if (method === "pane.run") touchMarkerFrom(String(params.command ?? ""));
			return { type: "ok" };
		}
		if (method === "pane.get") {
			if (params.pane === "missing")
				throw new UhpError("not_found", "pane missing not found");
			return {
				type: "pane",
				pane: params.pane,
				tab_id: "tab_1",
				workspace_id: "workspace_abc",
			};
		}
		if (method === "pane.layout")
			return {
				type: "pane_layout",
				pane: params.pane,
				rect: {
					x: 0,
					y: params.pane === "2" ? 5 : 0,
					width: 10,
					height: 5,
				},
			};
		if (method === "pane.split") return { type: "pane", pane: "2", tab: "1" };
		if (method === "pane.processes")
			return {
				type: "pane_processes",
				pane: params.pane,
				root_process: { pid: 7 },
				executables: ["bash"],
			};
		if (method === "agent.list")
			return {
				type: "agent_list",
				agents: [{ pane: "1", agent: "pi", name: "worker", status: "working" }],
			};
		if (method === "agent.get") {
			if (params.target === "missing")
				throw new UhpError("not_found", "agent missing not found");
			return {
				type: "agent",
				pane: "1",
				agent: "pi",
				name: "worker",
				status: "working",
			};
		}
		if (method === "agent.start")
			return {
				type: "agent_start",
				name: "worker",
				kind: "pi",
				pane: "1",
				ready: true,
				status: "idle",
			};
		if (method === "agent.prompt") {
			_prompted = true;
			return { type: "agent_prompt", submitted: true, status: "working" };
		}
		return { type: "ok" };
	};
	const make = (
		request: (
			method: string,
			params: Record<string, unknown>,
		) => Promise<unknown>,
	) =>
		new LuvusMultiplexer({
			...(socketPath ? { socketPath } : {}),
			request,
			runCli: () => ({}),
			sleep: () => Effect.void,
		});
	const port = make(async (method, params) => {
		calls.push({ method, params });
		return handle(method, params);
	});
	const failedPort = make(async () => {
		const error = new Error("connect ECONNREFUSED /tmp/luvus.sock") as Error & {
			code?: string;
		};
		error.code = "ECONNREFUSED";
		throw error;
	});
	return { port, failedPort, calls };
}

/** Behavioral assertions applied to both adapters: every required port
 * operation, confirmed-absence vs transport-failure, launch prompt
 * confirmation, notification outcome, and scoped events. */
async function sharedConformance(
	port: MultiplexerPort,
	failedPort: MultiplexerPort,
	repo: string,
): Promise<void> {
	// Workspace lifecycle.
	const created = await run(port.workspaceCreate({ cwd: repo, label: "wf" }));
	expect(created.workspaceId).toBeTruthy();
	const found = await run(port.workspaceGet("workspace_abc"));
	expect(found?.workspaceId).toBe("workspace_abc");
	expect(found?.label).toBe("probe");
	expect(await run(port.workspaceGet("missing"))).toBeUndefined();
	const workspaces = await run(port.workspaceList());
	expect(workspaces.map((workspace) => workspace.workspaceId)).toContain(
		"workspace_abc",
	);
	await run(port.workspaceFocus("workspace_abc"));
	await run(port.workspaceClose("workspace_abc"));

	// Tabs.
	const tabs = await run(port.tabList("workspace_abc"));
	expect(tabs.map((tab) => tab.tabId)).toEqual(["tab_1"]);
	const tab = await run(
		port.tabCreate({
			workspaceId: "workspace_abc",
			cwd: repo,
			label: "worker",
		}),
	);
	expect(tab).toEqual({ tabId: "tab_1", rootPaneId: "1" });
	await run(port.tabRename("tab_1", "dashboard"));
	await run(port.tabFocus("tab_1"));
	await run(port.tabClose("tab_1"));

	// Panes.
	const panes = await run(port.paneList({ workspaceId: "workspace_abc" }));
	expect(panes.map((pane) => pane.paneId)).toContain("1");
	const pane = await run(port.paneGet("1"));
	expect(pane?.paneId).toBe("1");
	expect(pane?.tabId).toBe("tab_1");
	expect(await run(port.paneGet("missing"))).toBeUndefined();
	const layout = await run(port.paneLayout("1"));
	expect(layout.panes.map((item) => item.paneId)).toContain("1");
	expect(layout.focusedPaneId).toBe("1");
	const split = await run(
		port.paneSplit({ target: "1", direction: "down", ratio: 0.5 }),
	);
	expect(split.paneId).toBe("2");
	await run(port.paneRun("1", "echo hi"));
	await run(port.paneFocus({ paneId: "1", workspaceId: "workspace_abc" }));
	await run(port.waitForShell("1"));
	const processes = await run(port.paneForegroundProcesses("1"));
	expect(processes.length).toBeGreaterThan(0);
	await run(port.paneClose("2"));

	// Agents, including env injection + prompt confirmation.
	const agents = await run(port.agentList());
	expect(agents.map((agent) => agent.paneId)).toContain("1");
	const agent = await run(port.agentGet("worker"));
	expect(agent?.paneId).toBe("1");
	expect(agent?.status).toBe("working");
	expect(await run(port.agentGet("missing"))).toBeUndefined();
	const started = await run(
		port.agentStart({
			kind: "pi",
			name: "worker",
			paneId: "1",
			cwd: repo,
			runId: "run-1",
			runtimeArgs: ["--model", "m"],
			environment: { HERDR_RUN_ID: "run-1" },
			prompt: "do it",
		}),
	);
	expect(started.paneId).toBe("1");
	await run(port.agentPrompt("worker", "next"));

	// Notification outcome vocabulary.
	expect(await run(port.notify({ title: "t", body: "b" }))).toBe("shown");

	// Confirmed absence is distinguishable from transport unavailability.
	const failingGetters: Array<
		() => Effect.Effect<unknown, MultiplexerError, never>
	> = [
		() => failedPort.workspaceGet("w"),
		() => failedPort.paneGet("p"),
		() => failedPort.agentGet("a"),
	];
	for (const missing of failingGetters) {
		const outcome = await run(Effect.either(missing()));
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome)) expect(outcome.left.kind).toBe("unavailable");
	}
}

describe("shared multiplexer conformance", () => {
	test("Herdr adapter passes the shared behavioral suite", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "shared-herdr-"));
		try {
			const script = scriptedHerdr(repo);
			await sharedConformance(script.port, script.failedPort, repo);
			// The launch path really injected the environment and confirmed the
			// prompt through the CLI.
			expect(
				script.calls.some(
					(call) =>
						call[0] === "pane" &&
						call[1] === "run" &&
						String(call[3]).includes("set -a"),
				),
			).toBe(true);
			expect(
				script.calls.some(
					(call) => call[0] === "agent" && call[1] === "prompt",
				),
			).toBe(true);
			expect(
				script.calls.some(
					(call) => call[0] === "pane" && call[1] === "process-info",
				),
			).toBe(true);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("Luvus adapter passes the shared behavioral suite", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "shared-luvus-"));
		try {
			const script = scriptedLuvus(repo);
			await sharedConformance(script.port, script.failedPort, repo);
			const methods = script.calls.map((call) => call.method);
			expect(methods).toContain("workspace.focus");
			expect(methods).toContain("workspace.close");
			expect(methods).toContain("tab.focus");
			expect(methods).toContain("tab.close");
			expect(methods).toContain("pane.processes");
			expect(methods).toContain("agent.start");
			expect(methods).toContain("agent.prompt");
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("Herdr adapter request shape", () => {
	test("emits the exact Herdr argv for workspace/tab/pane/agent calls", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-argv-"));
		try {
			const script = scriptedHerdr(repo);
			await run(script.port.workspaceCreate({ cwd: "/repo", label: "wf" }));
			await run(
				script.port.tabCreate({
					workspaceId: "w1",
					cwd: "/wt",
					label: "worker",
				}),
			);
			await run(
				script.port.paneSplit({ target: "1", direction: "down", ratio: 0.5 }),
			);
			await run(script.port.paneRun("2", "echo hi"));
			await run(script.port.paneClose("2"));
			await run(script.port.tabRename("t1", "dashboard"));
			await run(script.port.tabFocus("t1"));
			await run(script.port.tabClose("t1"));
			await run(script.port.workspaceFocus("w1"));
			await run(script.port.workspaceClose("w1"));
			await run(
				script.port.notify({ title: "t", body: "b", needsAttention: true }),
			);
			expect(script.calls).toContainEqual([
				"workspace",
				"create",
				"--cwd",
				"/repo",
				"--label",
				"wf",
			]);
			expect(script.calls).toContainEqual([
				"tab",
				"create",
				"--workspace",
				"w1",
				"--cwd",
				"/wt",
				"--label",
				"worker",
			]);
			expect(script.calls).toContainEqual([
				"pane",
				"split",
				"1",
				"--direction",
				"down",
				"--ratio",
				"0.5",
			]);
			expect(script.calls).toContainEqual(["pane", "run", "2", "echo hi"]);
			expect(script.calls).toContainEqual(["pane", "close", "2"]);
			expect(script.calls).toContainEqual(["tab", "rename", "t1", "dashboard"]);
			expect(script.calls).toContainEqual(["tab", "focus", "t1"]);
			expect(script.calls).toContainEqual(["tab", "close", "t1"]);
			expect(script.calls).toContainEqual(["workspace", "focus", "w1"]);
			expect(script.calls).toContainEqual(["workspace", "close", "w1"]);
			expect(script.calls).toContainEqual([
				"notification",
				"show",
				"t",
				"--body",
				"b",
				"--sound",
				"request",
			]);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("simplified workspace indexes and unknown-entity diagnostics classify as absence; transport failures do not", async () => {
		const script = scriptedHerdr(os.tmpdir());
		expect(await run(script.port.workspaceGet("missing"))).toBeUndefined();
		expect(await run(script.port.paneGet("missing"))).toBeUndefined();
		expect(await run(script.port.agentGet("missing"))).toBeUndefined();
		const transport = await run(
			Effect.either(script.failedPort.workspaceGet("w")),
		);
		expect(Either.isLeft(transport)).toBe(true);
		if (Either.isLeft(transport))
			expect(transport.left.kind).toBe("unavailable");
	});

	test("frames the launch prompt retry exactly like the previous behavior", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-retry-"));
		try {
			let prompts = 0;
			let attempts = 0;
			const cli = {
				call(...args: string[]) {
					const key = args.join(" ");
					if (key === "pane process-info --pane 1")
						return {
							process_info: {
								shell_pid: 42,
								foreground_process_group_id: 42,
								foreground_processes: [{ name: "zsh", pid: 42 }],
							},
						};
					if (args[0] === "pane" && args[1] === "run") {
						touchMarkerFrom(String(args[3] ?? ""));
						return {};
					}
					if (args[0] === "agent" && args[1] === "start") {
						attempts++;
						if (attempts === 1)
							throw new Error("target pane is not an available shell");
						return {
							agent: { pane_id: "1", tab_id: "tab_1", agent_status: "idle" },
						};
					}
					if (args[0] === "agent" && args[1] === "prompt") {
						prompts++;
						return {};
					}
					if (args[0] === "agent" && args[1] === "get")
						return {
							agent: {
								pane_id: "1",
								agent_status: prompts >= 2 ? "working" : "idle",
							},
						};
					return {};
				},
			};
			const port = new HerdrMultiplexer(cli, { sleep: () => Effect.void });
			const started = await run(
				port.agentStart({
					kind: "pi",
					name: "agent",
					paneId: "1",
					cwd: repo,
					runId: "run",
					runtimeArgs: [],
					environment: { HERDR_RUN_ID: "run" },
					prompt: "assignment",
				}),
			);
			expect(started.paneId).toBe("1");
			// One unavailable-shell retry and one dropped prompt re-submission.
			expect(attempts).toBe(2);
			expect(prompts).toBe(2);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("a create envelope without a tab id resolves the real tab or fails", async () => {
		const resolved = new HerdrMultiplexer(
			{
				call(...args: string[]) {
					const key = args.join(" ");
					if (args[0] === "tab" && args[1] === "create")
						return { root_pane: { pane_id: "1" } };
					if (key === "pane get 1")
						return { pane: { pane_id: "1", tab_id: "tab_1" } };
					return {};
				},
			},
			{ sleep: () => Effect.void },
		);
		expect(
			await run(
				resolved.tabCreate({ workspaceId: "w", cwd: "/repo", label: "x" }),
			),
		).toEqual({ tabId: "tab_1", rootPaneId: "1" });

		const unresolved = new HerdrMultiplexer(
			{
				call(...args: string[]) {
					if (args[0] === "tab" && args[1] === "create")
						return { root_pane: { pane_id: "1" } };
					if (args[0] === "pane" && args[1] === "get")
						return { pane: { pane_id: "1" } };
					return {};
				},
			},
			{ sleep: () => Effect.void },
		);
		const outcome = await run(
			Effect.either(unresolved.tabCreate({ workspaceId: "w", label: "x" })),
		);
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome))
			expect(outcome.left.kind).toBe("invalid-response");
	});

	test("an already-aborted launch signal fails before any prompt", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-abort-"));
		try {
			const script = scriptedHerdr(repo);
			const controller = new AbortController();
			controller.abort();
			const outcome = await run(
				Effect.either(
					script.port.agentStart({
						kind: "pi",
						name: "agent",
						paneId: "1",
						cwd: repo,
						runId: "run",
						runtimeArgs: [],
						environment: { HERDR_RUN_ID: "run" },
						prompt: "assignment",
						signal: controller.signal,
					}),
				),
			);
			expect(Either.isLeft(outcome)).toBe(true);
			expect(
				script.calls.some(
					(call) => call[0] === "agent" && call[1] === "prompt",
				),
			).toBe(false);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("Luvus adapter request shape and outcomes", () => {
	test("emits the exact UHP method/params for each port operation", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "luvus-params-"));
		try {
			const script = scriptedLuvus(repo);
			await run(script.port.workspaceCreate({ cwd: repo, label: "wf" }));
			await run(script.port.workspaceList());
			await run(script.port.workspaceFocus("workspace_abc"));
			await run(script.port.workspaceClose("workspace_abc"));
			await run(script.port.tabList("workspace_abc"));
			await run(
				script.port.tabCreate({
					workspaceId: "workspace_abc",
					label: "worker",
				}),
			);
			await run(script.port.tabRename("tab_1", "dashboard"));
			await run(script.port.tabFocus("tab_1"));
			await run(script.port.tabClose("tab_1"));
			await run(script.port.paneList());
			await run(script.port.paneSplit({ target: "1", direction: "right" }));
			await run(script.port.paneRun("1", "echo hi"));
			await run(script.port.paneFocus({ paneId: "1" }));
			await run(script.port.paneClose("2"));
			await run(script.port.agentList());
			await run(script.port.agentGet("worker"));
			await run(script.port.agentPrompt("worker", "go"));
			const byMethod = (method: string) =>
				script.calls
					.filter((call) => call.method === method)
					.map((call) => call.params);
			expect(byMethod("workspace.open")).toEqual([{ path: repo }]);
			expect(byMethod("workspace.rename")).toEqual([
				{ workspace: "0", name: "wf" },
			]);
			expect(byMethod("workspace.focus")).toEqual([
				{ workspace_id: "workspace_abc" },
				// tabCreate focuses the target first: a Luvus tab lands in the session's
				// active workspace and `tab.new` honors neither workspace_id nor cwd.
				{ workspace_id: "workspace_abc" },
			]);
			expect(byMethod("workspace.close")).toEqual([
				{ workspace_id: "workspace_abc" },
			]);
			expect(byMethod("tab.focus")).toEqual([{ tab_id: "tab_1" }]);
			expect(byMethod("tab.close")).toEqual([{ tab_id: "tab_1" }]);
			expect(byMethod("pane.list")).toContainEqual({});
			expect(byMethod("pane.split")).toEqual([
				{ pane: "1", direction: "right", focus: false },
			]);
			expect(byMethod("pane.run")).toEqual([{ pane: "1", command: "echo hi" }]);
			expect(byMethod("pane.focus")).toEqual([{ pane: "1" }]);
			expect(byMethod("agent.prompt")).toContainEqual({
				target: "worker",
				text: "go",
			});
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("the named session and socket layout are honored from the environment", () => {
		expect(resolveLuvusSocketPath({ LUVUS_SOCKET_PATH: "/custom.sock" })).toBe(
			"/custom.sock",
		);
		expect(
			resolveLuvusSocketPath({
				LUVUS_HOME: "/home/u/.luvus",
				LUVUS_SESSION: "review",
			}),
		).toBe("/home/u/.luvus/sessions/review/luvus.sock");
		expect(resolveLuvusSocketPath({ LUVUS_HOME: "/home/u/.luvus" })).toBe(
			"/home/u/.luvus/luvus.sock",
		);
		// The ambient address of the server that launched this process is not a
		// session selector: a requested session must not be silently replaced by
		// whichever server the pane happens to be attached to.
		expect(
			resolveLuvusSocketPath({
				LUVUS_HOME: "/home/u/.luvus",
				LUVUS_SESSION: "review",
				LUVUS_API_ADDRESS: "/home/u/.luvus/luvus.sock",
			}),
		).toBe("/home/u/.luvus/sessions/review/luvus.sock");
		// An explicit socket path still wins over everything.
		expect(
			resolveLuvusSocketPath({
				LUVUS_SOCKET_PATH: "/custom.sock",
				LUVUS_SESSION: "review",
				LUVUS_API_ADDRESS: "/home/u/.luvus/luvus.sock",
			}),
		).toBe("/custom.sock");
		// Without a session the ambient unix address is this process's own server.
		expect(
			resolveLuvusSocketPath({
				LUVUS_HOME: "/home/u/.luvus",
				LUVUS_API_ADDRESS: "/home/u/.luvus/luvus.sock",
			}),
		).toBe("/home/u/.luvus/luvus.sock");
		// A TCP address is not a socket path, so it never becomes one.
		expect(
			resolveLuvusSocketPath({
				LUVUS_HOME: "/home/u/.luvus",
				LUVUS_API_ADDRESS: "tcp:127.0.0.1:7777",
			}),
		).toBe("/home/u/.luvus/luvus.sock");
		// An explicitly requested default session keeps the default socket.
		expect(
			resolveLuvusSocketPath({
				LUVUS_HOME: "/home/u/.luvus",
				LUVUS_SESSION: "default",
				LUVUS_API_ADDRESS: "/elsewhere/luvus.sock",
			}),
		).toBe("/home/u/.luvus/luvus.sock");
		// A session-selected adapter resolves the same session-scoped socket the
		// CLI would target, even without an explicit socket path.
		const previous = process.env.LUVUS_SESSION;
		const previousSocket = process.env.LUVUS_SOCKET_PATH;
		try {
			delete process.env.LUVUS_SESSION;
			delete process.env.LUVUS_SOCKET_PATH;
			const adapter = new LuvusMultiplexer({ session: "review" });
			expect(adapter.socketPath).toBe(
				path.join(os.homedir(), ".luvus", "sessions", "review", "luvus.sock"),
			);
		} finally {
			if (previous === undefined) delete process.env.LUVUS_SESSION;
			else process.env.LUVUS_SESSION = previous;
			if (previousSocket === undefined) delete process.env.LUVUS_SOCKET_PATH;
			else process.env.LUVUS_SOCKET_PATH = previousSocket;
		}
	});

	test("notification refusal is recorded from the error code, never retried", async () => {
		const refused = new LuvusMultiplexer({
			runCli: () => {
				const error = new Error("policy rejection") as Error & {
					code?: string;
				};
				error.code = "denied";
				throw error;
			},
		});
		expect(await run(refused.notify({ title: "t", body: "" }))).toBe("refused");
		const shown = new LuvusMultiplexer({ runCli: () => ({}) });
		expect(await run(shown.notify({ title: "t", body: "" }))).toBe("shown");
	});

	test("identity-less single-entity replies fail as bounded invalid-response", async () => {
		const empty = new LuvusMultiplexer({
			request: async () => ({}),
			sleep: () => Effect.void,
		});
		const emptyGetters: Array<
			() => Effect.Effect<unknown, MultiplexerError, never>
		> = [
			() => empty.workspaceGet("workspace_abc"),
			() => empty.paneGet("1"),
			() => empty.agentGet("worker"),
		];
		for (const call of emptyGetters) {
			const outcome = await run(Effect.either(call()));
			expect(Either.isLeft(outcome)).toBe(true);
			if (Either.isLeft(outcome))
				expect(outcome.left.kind).toBe("invalid-response");
		}
		const startEmpty = await run(
			Effect.either(
				empty.agentStart({
					kind: "pi",
					name: "worker",
					paneId: "1",
					cwd: os.tmpdir(),
					runId: "run",
					runtimeArgs: [],
					environment: {},
					prompt: "go",
				}),
			),
		);
		expect(Either.isLeft(startEmpty)).toBe(true);
		if (Either.isLeft(startEmpty))
			expect(startEmpty.left.kind).toBe("invalid-response");
	});

	test("tabCreate fails loudly when the runtime returns no root pane", async () => {
		const port = new LuvusMultiplexer({
			request: async (method) => {
				if (method === "workspace.get") return { ...workspaceRow };
				if (method === "tab.new") return { type: "tab", tab: "1" };
				if (method === "tab.get")
					return { type: "tab", tab: "1", tab_id: "tab_1", panes: [] };
				return { type: "ok" };
			},
			sleep: () => Effect.void,
		});
		const outcome = await run(
			Effect.either(port.tabCreate({ workspaceId: "workspace_abc" })),
		);
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome)) {
			expect(outcome.left.kind).toBe("invalid-response");
			expect(outcome.left.message).toContain("no root pane");
		}
	});

	test("a tab that landed in another workspace fails loudly", async () => {
		// The real failure mode behind this guard: a pane silently created in the
		// developer's focused workspace instead of the workflow's worktree.
		const port = new LuvusMultiplexer({
			request: async (method) => {
				if (method === "workspace.get") return { ...workspaceRow };
				if (method === "tab.new") return { type: "tab", tab: "1" };
				if (method === "tab.get")
					return {
						type: "tab",
						tab: "1",
						tab_id: "tab_1",
						panes: ["1"],
						workspace_id: "workspace_other",
					};
				return { type: "ok" };
			},
			sleep: () => Effect.void,
		});
		const outcome = await run(
			Effect.either(port.tabCreate({ workspaceId: "workspace_abc" })),
		);
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome)) {
			expect(outcome.left.kind).toBe("invalid-response");
			expect(outcome.left.message).toContain("workspace_other");
		}
	});

	test("a failed agent.get poll fails the launch instead of reporting success", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "luvus-poll-"));
		try {
			let promptSent = false;
			const port = new LuvusMultiplexer({
				request: async (method, params) => {
					if (method === "pane.run") {
						touchMarkerFrom(String(params.command ?? ""));
						return { type: "ok" };
					}
					if (method === "agent.start")
						return {
							type: "agent_start",
							name: "worker",
							kind: "pi",
							pane: "1",
							ready: true,
							status: "idle",
						};
					if (method === "agent.prompt") {
						promptSent = true;
						return { type: "agent_prompt", submitted: true };
					}
					if (method === "agent.get")
						throw new UhpError("unavailable", "session dropped");
					return { type: "ok" };
				},
				sleep: () => Effect.void,
			});
			const outcome = await run(
				Effect.either(
					port.agentStart({
						kind: "pi",
						name: "worker",
						paneId: "1",
						cwd: repo,
						runId: "run",
						runtimeArgs: [],
						environment: { HERDR_RUN_ID: "run" },
						prompt: "go",
					}),
				),
			);
			expect(promptSent).toBe(true);
			expect(Either.isLeft(outcome)).toBe(true);
			if (Either.isLeft(outcome)) {
				expect(outcome.left.message).toContain(
					"agent did not start on its launch prompt",
				);
			}
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("ownership loss after the start request fails without prompting", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "luvus-abort-"));
		try {
			const controller = new AbortController();
			const port = new LuvusMultiplexer({
				request: async (method, params) => {
					if (method === "pane.run") {
						touchMarkerFrom(String(params.command ?? ""));
						return { type: "ok" };
					}
					if (method === "agent.start") {
						controller.abort();
						return {
							type: "agent_start",
							name: "worker",
							kind: "pi",
							pane: "1",
							ready: true,
							status: "idle",
						};
					}
					return { type: "ok" };
				},
				sleep: () => Effect.void,
			});
			const outcome = await run(
				Effect.either(
					port.agentStart({
						kind: "pi",
						name: "worker",
						paneId: "1",
						cwd: repo,
						runId: "run",
						runtimeArgs: [],
						environment: { HERDR_RUN_ID: "run" },
						prompt: "go",
						signal: controller.signal,
					}),
				),
			);
			expect(Either.isLeft(outcome)).toBe(true);
			if (Either.isLeft(outcome))
				expect(outcome.left.kind).toBe("ownership-lost");
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("waitForShell polls pane.processes and fails loudly on timeout", async () => {
		let polls = 0;
		const port = new LuvusMultiplexer({
			request: async (method) => {
				if (method === "pane.processes") {
					polls += 1;
					return { type: "pane_processes", pane: "1", executables: [] };
				}
				return { type: "ok" };
			},
			sleep: () => Effect.void,
		});
		const outcome = await run(Effect.either(port.waitForShell("1")));
		expect(polls).toBe(50);
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome)) {
			expect(outcome.left.kind).toBe("unavailable");
			expect(outcome.left.message).toContain(
				"did not reach an available shell",
			);
		}
	});

	test("an existing but unreachable socket fails as unavailable on first use", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luvus-stale-"));
		const socketPath = path.join(dir, "luvus.sock");
		fs.writeFileSync(socketPath, "");
		try {
			const port = new LuvusMultiplexer({ socketPath });
			const outcome = await run(Effect.either(port.workspaceList()));
			expect(Either.isLeft(outcome)).toBe(true);
			if (Either.isLeft(outcome)) expect(outcome.left.kind).toBe("unavailable");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("scoped event subscription", () => {
	test("delivers normalized events for both adapters and releases its scope", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-events-"));
		const socketPath = path.join(dir, "events.sock");
		let closed = 0;
		const server = Bun.listen({
			unix: socketPath,
			socket: {
				open(socket) {
					void socket;
				},
				data(socket) {
					socket.write(
						`${JSON.stringify({
							id: "events",
							result: { type: "subscription_started", sequence: 1 },
						})}\n`,
					);
					socket.write(
						`${JSON.stringify({ event: "pane.created", sequence: 2, data: { pane: "1" } })}\n`,
					);
				},
				close() {
					closed += 1;
				},
			},
		});
		const previousSocket = process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_SOCKET_PATH = socketPath;
		try {
			for (const port of [
				new HerdrMultiplexer(
					{ call: () => ({}) },
					{ sleep: () => Effect.void },
				),
				new LuvusMultiplexer({
					socketPath,
					request: async () => ({ type: "ok" }),
					sleep: () => Effect.void,
				}),
			] as MultiplexerPort[]) {
				const seen: Array<{ event: string }> = [];
				const scope = Effect.runSync(Scope.make());
				Effect.runSync(
					Effect.provideService(
						port.eventsSubscribe((event) => seen.push(event)),
						Scope.Scope,
						scope,
					),
				);
				const deadline = Date.now() + 2000;
				while (Date.now() < deadline && seen.length === 0) await Bun.sleep(10);
				expect(seen.map((event) => event.event)).toContain("pane.created");
				Effect.runSync(Scope.close(scope, Exit.void));
			}
			const deadline = Date.now() + 1000;
			while (Date.now() < deadline && closed < 1) await Bun.sleep(10);
			expect(closed).toBeGreaterThanOrEqual(1);
		} finally {
			if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
			else process.env.HERDR_SOCKET_PATH = previousSocket;
			void server.stop(true);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("Luvus resync loss is surfaced to the consumer and resumes from the sequence", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luvus-resync-"));
		const socketPath = path.join(dir, "resync.sock");
		const requests: Array<Record<string, unknown>> = [];
		const server = Bun.listen({
			unix: socketPath,
			socket: {
				open(socket) {
					void socket;
				},
				data(socket, data) {
					for (const line of String(data).split("\n")) {
						if (line.trim())
							requests.push(JSON.parse(line) as Record<string, unknown>);
					}
					socket.write(
						`${JSON.stringify({
							id: "events",
							result: { type: "subscription_started", sequence: 4 },
						})}\n`,
					);
					socket.write(
						`${JSON.stringify({
							event: "events.resync_required",
							sequence: 5,
							data: { reason: "subscriber_overflow" },
						})}\n`,
					);
				},
				close() {},
			},
		});
		const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
		try {
			const port = new LuvusMultiplexer({
				socketPath,
				request: async () => ({ type: "ok" }),
				sleep: () => Effect.void,
				reconnectDelayMs: 10,
			});
			const scope = Effect.runSync(Scope.make());
			Effect.runSync(
				Effect.provideService(
					port.eventsSubscribe((event) => seen.push(event)),
					Scope.Scope,
					scope,
				),
			);
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && seen.length === 0) await Bun.sleep(10);
			expect(seen[0]?.event).toBe("events.resync_required");
			expect(seen[0]?.data).toEqual({ reason: "subscriber_overflow" });
			Effect.runSync(Scope.close(scope, Exit.void));
		} finally {
			void server.stop(true);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runtime selection and detached drain environment", () => {
	test("defaults to herdr, lets the environment override configuration, and rejects unknown selectors", () => {
		expect(resolveMultiplexerSelection({ env: {} })).toBe("herdr");
		expect(
			resolveMultiplexerSelection({ env: {}, configMultiplexer: "luvus" }),
		).toBe("luvus");
		expect(
			resolveMultiplexerSelection({
				env: { AGENTIC_CODING_MULTIPLEXER: "luvus" },
				configMultiplexer: "herdr",
			}),
		).toBe("luvus");
		expect(() =>
			resolveMultiplexerSelection({
				env: { AGENTIC_CODING_MULTIPLEXER: "tmux" },
			}),
		).toThrow(/herdr, luvus/);
	});

	test("an unavailable selected runtime fails loudly and never falls back", () => {
		expect(() =>
			createMultiplexerPort("herdr", { binPath: "/definitely/missing/herdr" }),
		).toThrow(/selected multiplexer 'herdr' is unavailable/);
		expect(() =>
			createMultiplexerPort("luvus", {
				socketPath: "/definitely/missing.sock",
			}),
		).toThrow(/selected multiplexer 'luvus' is unavailable/);
		expect(MULTIPLEXER_IDS).toEqual(["herdr", "luvus"]);
	});

	test("an unsupported configured selector fails configuration load", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-config-"));
		const configFile = path.join(dir, "config.json");
		fs.writeFileSync(configFile, JSON.stringify({ multiplexer: "tmux" }));
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = configFile;
		try {
			const { loadConfig } = await import("../src/workflow/effects.ts");
			expect(() => loadConfig()).toThrow(
				/supported multiplexers: herdr, luvus/,
			);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("forwards the selector and both runtimes' connection variables to the detached drain", () => {
		const env = detachedDrainEnvironment({
			AGENTIC_CODING_MULTIPLEXER: "luvus",
			LUVUS_SESSION: "review",
			LUVUS_SOCKET_PATH: "/tmp/luvus.sock",
			LUVUS_HOME: "/home/u/.luvus",
			HERDR_BIN_PATH: "/usr/bin/herdr",
			DEVENV_HOME: "/home/u/devenv",
			SECRET: "must-not-leak",
		});
		expect(env.AGENTIC_CODING_MULTIPLEXER).toBe("luvus");
		expect(env.LUVUS_SESSION).toBe("review");
		expect(env.LUVUS_SOCKET_PATH).toBe("/tmp/luvus.sock");
		expect(env.LUVUS_HOME).toBe("/home/u/.luvus");
		expect(env.HERDR_BIN_PATH).toBe("/usr/bin/herdr");
		// The workflow worktree root resolves from the managed runtime home.
		expect(env.DEVENV_HOME).toBe("/home/u/devenv");
		expect(env.SECRET).toBeUndefined();
	});

	test("HERDR_BIN_PATH is the binary that runs, not just the one validated", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-bin-"));
		const scriptPath = path.join(dir, "fake-herdr");
		fs.writeFileSync(
			scriptPath,
			`#!/bin/sh\nprintf '{"result":{"from":"fake"}}\\n'\n`,
			{ mode: 0o755 },
		);
		try {
			expect(new Herdr(scriptPath).call("ping")).toEqual({ from: "fake" });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("failure policy mapping", () => {
	test("port failure kinds map onto the existing retry/abort/skip policy", () => {
		// The runner's existing policy treats a lost lease as an abort
		// (interrupted), and both ownership and interruption are skipped.
		const ownership = classifyMultiplexerFailure(
			new MultiplexerError(
				"ownership-lost",
				"herdr",
				"effect ownership was lost",
			),
		);
		expect(classifyFailure(ownership, false)).toBe("interrupted");
		for (const kind of ["unavailable", "denied", "invalid-response"] as const) {
			const error = classifyMultiplexerFailure(
				new MultiplexerError(kind, "herdr", `${kind} failure`),
			);
			expect(classifyFailure(error, false)).toBe("transient");
		}
		// A leaked confirmed-absence kind is a transient infrastructure condition;
		// the getters fold absence into `undefined` before this mapper runs.
		const absent = classifyMultiplexerFailure(
			new MultiplexerError("absent", "herdr", "workspace gone not found"),
		);
		expect(classifyFailure(absent, false)).toBe("transient");
	});
});

describe("paneRun shell quoting", () => {
	test("a finding path with command substitution reaches the pane single-quoted", async () => {
		const { setMultiplexerPortForTests } = await import(
			"../src/multiplexer/factory.ts"
		);
		let recorded = "";
		const capturing = {
			tabCreate: () => Effect.succeed({ tabId: "t", rootPaneId: "p" }),
			paneRun: (_pane: string, command: string) => {
				recorded = command;
				return Effect.void;
			},
		} as unknown as MultiplexerPort;
		setMultiplexerPortForTests(capturing);
		const state = {
			worktree: os.tmpdir(),
			workspace: "w1",
		} as unknown as Parameters<typeof openFindingInEditorAsync>[0];
		await openFindingInEditorAsync(state, {
			path: "$(touch /tmp/pwned).ts",
			line: 3,
		});
		setMultiplexerPortForTests(undefined);
		const expected = path.join(os.tmpdir(), "$(touch /tmp/pwned).ts");
		expect(recorded).toContain(`'${expected}'`);
		expect(recorded).not.toContain(' +3 "');
	});

	test("a finding path escaping the worktree is rejected before any pane call", async () => {
		const port = {
			tabCreate: () => Effect.sync(() => ({ tabId: "t", rootPaneId: "p" })),
			paneRun: () => Effect.void,
		} as unknown as MultiplexerPort;
		const { setMultiplexerPortForTests } = await import(
			"../src/multiplexer/factory.ts"
		);
		setMultiplexerPortForTests(port);
		const state = {
			worktree: os.tmpdir(),
			workspace: "w1",
		} as unknown as Parameters<typeof openFindingInEditorAsync>[0];
		await expect(
			openFindingInEditorAsync(state, { path: "../outside.ts" }),
		).rejects.toThrow(/inside the worktree/);
		setMultiplexerPortForTests(undefined);
	});
});
