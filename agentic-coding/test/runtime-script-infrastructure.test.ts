// Script infrastructure lifecycle
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/operations/{service,script_lifecycle}.go`: logged and
// tmux launch, status/handle reporting, adoption of windows a previous process
// left, and stopping only what this owner started.
import { describe, expect, test } from "bun:test";
import { MemoryProcessStore } from "../src/server/actions/process.ts";
import {
	defaultScriptLogPath,
	INFRA_STATUS,
	INFRA_WINDOW_PREFIX,
	parseTmuxWindowAndPid,
	parseTmuxWindowLine,
	processAlive,
	SCRIPT_RUNNER,
	ScriptInfrastructure,
} from "../src/server/runtime/script-infrastructure.ts";

function harness(options: {
	tmux?: boolean;
	outputs?: Record<string, string>;
	errors?: Record<string, Error>;
	store?: MemoryProcessStore;
}): {
	infra: ScriptInfrastructure;
	calls: string[];
	store: MemoryProcessStore;
} {
	const calls: string[] = [];
	const store = options.store ?? new MemoryProcessStore();
	const infra = new ScriptInfrastructure({
		store,
		env: options.tmux ? { TMUX: "/tmp/tmux-1000/default,123,0" } : {},
		runCommand: async (command, args) => {
			const key = `${command} ${args.join(" ")}`;
			calls.push(key);
			const error = options.errors?.[key];
			return {
				output: options.outputs?.[key] ?? "",
				...(error ? { error } : {}),
			};
		},
		now: () => new Date("2026-01-01T00:00:00Z"),
	});
	return { infra, calls, store };
}

const SERVICE = { ident: "clock", type: "script" };

describe("launching a script service", () => {
	test("without tmux the service runs as a logged process", async () => {
		const { infra, calls, store } = harness({});
		let spawned = 0;
		const status = await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: ["/c/clock.sh", "--interval", "2"],
			logPath: "/h/logs/clock.log",
			spawn: () => {
				spawned++;
				return { pid: process.pid };
			},
		});
		expect(spawned).toBe(1);
		expect(calls).toEqual([]);
		expect(status.status).toBe(INFRA_STATUS.running);
		expect(status.logPath).toBe("/h/logs/clock.log");
		expect(status.executionHandle).toMatchObject({
			mode: "logged",
			runner: "shell",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(store.get("clock")).toBeUndefined();
	});

	test("inside tmux the service opens a named window instead of a process", async () => {
		const { infra, calls } = harness({
			tmux: true,
			outputs: {
				"tmux new-window -P -F #{window_id}:#{pane_pid} -n devenv - infra - clock -c /c /bin/sh /c/clock.sh":
					"@7:4242\n",
			},
		});
		let spawned = 0;
		const status = await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: ["/c/clock.sh"],
			dir: "/c",
			spawn: () => {
				spawned++;
				return { pid: 1 };
			},
		});
		// The window is the handle: no second process is started.
		expect(spawned).toBe(0);
		expect(calls[0]).toContain(`-n ${INFRA_WINDOW_PREFIX}clock`);
		expect(status.executionHandle).toMatchObject({
			mode: "tmux",
			paneId: "@7",
			pid: 4242,
		});
	});

	test("a tmux window that cannot open falls back to a logged process", async () => {
		const { infra } = harness({
			tmux: true,
			errors: {
				"tmux new-window -P -F #{window_id}:#{pane_pid} -n devenv - infra - clock /bin/sh /c/clock.sh":
					new Error("no server"),
			},
		});
		let spawned = 0;
		const status = await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: ["/c/clock.sh"],
			spawn: () => {
				spawned++;
				return { pid: process.pid };
			},
		});
		expect(spawned).toBe(1);
		expect(status.executionHandle?.mode).toBe("logged");
	});
});

describe("status and terminal state", () => {
	test("a stopped service reports stopped and its log path", async () => {
		const { infra } = harness({});
		expect(await infra.status("clock")).toEqual({
			status: INFRA_STATUS.stopped,
			logPath: "",
		});
		await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: [],
			logPath: "/h/logs/clock.log",
			spawn: () => ({ pid: process.pid }),
		});
		infra.noteExit("clock", 0, "/h/logs/clock.log");
		expect(await infra.status("clock")).toEqual({
			status: INFRA_STATUS.stopped,
			logPath: "/h/logs/clock.log",
			executionHandle: expect.objectContaining({ exitCode: 0 }),
		});
	});

	test("a non-zero exit reports failed", async () => {
		const { infra } = harness({});
		await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: [],
			spawn: () => ({ pid: process.pid }),
		});
		infra.noteExit("clock", 3, "");
		expect((await infra.status("clock")).status).toBe(INFRA_STATUS.failed);
	});

	test("a tmux pane that disappeared is stopped, never a remembered running", async () => {
		const { infra } = harness({
			tmux: true,
			outputs: {
				"tmux new-window -P -F #{window_id}:#{pane_pid} -n devenv - infra - clock /bin/sh":
					"@7:4242\n",
			},
			errors: {
				"tmux display-message -p -t @7 #{window_id}:#{pane_pid}": new Error(
					"can't find window",
				),
			},
		});
		await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: [],
			spawn: () => ({ pid: 1 }),
		});
		expect((await infra.status("clock")).status).toBe(INFRA_STATUS.stopped);
		expect(infra.tracked()).toEqual([]);
	});

	test("the handle is published for a live run", async () => {
		const { infra } = harness({});
		await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.powerShell,
			command: "pwsh",
			args: [],
			spawn: () => ({ pid: process.pid }),
		});
		expect(infra.executionHandle("clock")).toMatchObject({
			runner: "powershell",
			pid: process.pid,
		});
	});
});

describe("stopping and adoption", () => {
	test("a logged run is stopped through its process tree", async () => {
		const { infra } = harness({});
		await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: [],
			spawn: () => ({ pid: 999_999 }),
		});
		await infra.stop("clock");
		expect(infra.tracked()).toEqual([]);
		// A pid that never existed is not "alive", so nothing was signalled.
		expect(processAlive(999_999)).toBe(false);
	});

	test("a tmux run is stopped by killing its own window", async () => {
		const { infra, calls } = harness({
			tmux: true,
			outputs: {
				"tmux new-window -P -F #{window_id}:#{pane_pid} -n devenv - infra - clock /bin/sh":
					"@7:4242\n",
			},
		});
		await infra.launch({
			ident: "clock",
			runner: SCRIPT_RUNNER.shell,
			command: "/bin/sh",
			args: [],
			spawn: () => ({ pid: 1 }),
		});
		await infra.stop("clock");
		expect(calls).toContain("tmux kill-window -t @7");
	});

	test("an untracked service is already stopped", async () => {
		const { infra, calls } = harness({});
		await infra.stop("clock");
		expect(calls).toEqual([]);
	});

	test("adoption takes only windows named for a configured script service", async () => {
		const { infra, calls } = harness({
			tmux: true,
			outputs: {
				// A live pane is the adoption precondition, so the fixture uses
				// this process's own pid.
				"tmux list-windows -a -F #{window_id}:#{window_name}:#{pane_pid}": [
					`@1:devenv - infra - clock:${process.pid}`,
					"@2:user-shell:1111",
					"@3:devenv - infra - unknown:2222",
					`@4:devenv - infra - dev:${process.pid}`,
				].join("\n"),
			},
		});
		const adopted = await infra.adopt([
			{ ident: "clock", type: "script" },
			{ ident: "dev", type: "script" },
			{ ident: "db", type: "docker" },
		]);
		expect(adopted).toBe(2);
		expect(infra.tracked().sort()).toEqual(["clock", "dev"]);
		expect(calls).toHaveLength(1);
	});

	test("adoption does nothing outside tmux", async () => {
		const { infra, calls } = harness({});
		expect(await infra.adopt([SERVICE])).toBe(0);
		expect(calls).toEqual([]);
	});

	test("a dead pane is not adopted", async () => {
		const { infra } = harness({
			tmux: true,
			outputs: {
				"tmux list-windows -a -F #{window_id}:#{window_name}:#{pane_pid}":
					"@1:devenv - infra - clock:999999",
			},
		});
		expect(await infra.adopt([SERVICE])).toBe(0);
	});
});

describe("tmux line parsing", () => {
	test("parses list-windows and new-window formats", () => {
		expect(parseTmuxWindowLine("@1:devenv - infra - clock:4242")).toEqual({
			windowId: "@1",
			windowName: "devenv - infra - clock",
			pid: 4242,
		});
		expect(parseTmuxWindowLine("@7:4242")).toEqual({
			windowId: "@7",
			windowName: "",
			pid: 4242,
		});
		expect(parseTmuxWindowLine("")).toEqual({
			windowId: "",
			windowName: "",
			pid: 0,
		});
		expect(parseTmuxWindowAndPid("@7:4242")).toEqual({
			windowId: "@7",
			pid: 4242,
		});
	});

	test("the default log path is the infrastructure log directory", () => {
		expect(defaultScriptLogPath("/c", "clock")).toBe(
			"/c/logs/infrastructure/clock.log",
		);
	});
});
