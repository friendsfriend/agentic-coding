// Run-target and Kubernetes run observation
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/build/{service,kubernetes_logs}.go`: last-run runtime,
// run-target info (memory then store), shell tmux run tracking/adoption and the
// Kubernetes run status derived from pod phases.
import { describe, expect, test } from "bun:test";
import type { ActionTarget } from "../src/server/actions/targets.ts";
import {
	formatRunTargetDisplay,
	kubernetesRank,
	parsePanePid,
	RunObservation,
	type StoredRunTargetInfo,
} from "../src/server/runtime/run-observation.ts";

function target(overrides: Partial<ActionTarget> = {}): ActionTarget {
	return {
		id: "app/api/run/docker/default",
		action: "run",
		runtime: "docker",
		label: "dev",
		profile: "default",
		sourcePath: "/src/api/docker-compose.yml",
		...overrides,
	} as ActionTarget;
}

function store(initial: Record<string, StoredRunTargetInfo> = {}): {
	store: {
		getAppRunTargetInfo(ident: string): StoredRunTargetInfo | undefined;
		setAppRunTargetInfo(ident: string, info: StoredRunTargetInfo): void;
		clearAppRunTargetInfo(ident: string): void;
	};
	rows: Record<string, StoredRunTargetInfo>;
} {
	const rows = { ...initial };
	return {
		rows,
		store: {
			getAppRunTargetInfo: (ident) => rows[ident],
			setAppRunTargetInfo: (ident, info) => {
				rows[ident] = info;
			},
			clearAppRunTargetInfo: (ident) => {
				delete rows[ident];
			},
		},
	};
}

function observation(options: {
	targets?: readonly ActionTarget[];
	outputs?: Record<string, string>;
	errors?: Record<string, Error>;
	tmux?: boolean;
	rows?: Record<string, StoredRunTargetInfo>;
}): {
	observation: RunObservation;
	calls: string[];
	rows: Record<string, StoredRunTargetInfo>;
} {
	const calls: string[] = [];
	const backing = store(options.rows);
	const run = new RunObservation({
		store: backing.store,
		discoverTargets: () => options.targets ?? [],
		env: options.tmux ? { TMUX: "/tmp/tmux" } : {},
		runCommand: async (command, args) => {
			const key = `${command} ${args.join(" ")}`;
			calls.push(key);
			return {
				output: options.outputs?.[key] ?? "",
				...(options.errors?.[key] ? { error: options.errors[key] } : {}),
			};
		},
		now: () => new Date("2026-01-01T00:00:00Z"),
	});
	return { observation: run, calls, rows: backing.rows };
}

describe("run target display", () => {
	test("badges the provider, tmux and the profile", () => {
		expect(formatRunTargetDisplay(target())).toBe("[docker] dev (default)");
		expect(
			formatRunTargetDisplay(target({ runtime: "docker", provider: "podman" })),
		).toBe("[podman] dev (default)");
		expect(
			formatRunTargetDisplay(
				target({ runtime: "shell", launchMode: "tmux", profile: undefined }),
			),
		).toBe("[tmux] dev");
		// An unlabelled docker target labelled "default" gains the profile.
		expect(
			formatRunTargetDisplay(
				target({ label: "default", profile: undefined, runtime: "docker" }),
			),
		).toBe("[docker] default (default)");
		expect(
			formatRunTargetDisplay(
				target({ runtime: "kubernetes", label: "", profile: "local" }),
			),
		).toBe("[kubernetes] local (local)");
	});
});

describe("run target info", () => {
	test("records, publishes and persists the target", () => {
		const { observation: run, rows } = observation({});
		const info = run.setRunTargetInfo("api", target());
		expect(info).toMatchObject({
			runtime: "docker",
			label: "dev",
			profile: "default",
			targetId: "app/api/run/docker/default",
			display: "[docker] dev (default)",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(rows.api.display).toBe("[docker] dev (default)");
		expect(run.runTargetInfo("api")).toEqual(info);
	});

	test("a podman runtime is the recorded runtime", () => {
		const { observation: run } = observation({});
		expect(
			run.setRunTargetInfo(
				"api",
				target({ runtime: "docker", provider: "podman" }),
			).runtime,
		).toBe("podman");
	});

	test("an unknown target falls back to the persisted row", () => {
		const { observation: run } = observation({
			rows: {
				api: {
					runtime: "shell",
					launchMode: "tmux",
					label: "dev",
					profile: "default",
					targetId: "app/api/run/tmux/default",
					sourcePath: "/src/dev.sh",
					startedAt: "2025-12-31T00:00:00Z",
					display: "[tmux] dev (default)",
				},
			},
		});
		expect(run.runTargetInfo("api")?.display).toBe("[tmux] dev (default)");
		// Cleared rows are gone from both memory and the store.
		run.clearRunTargetInfo("api");
		expect(run.runTargetInfo("api")).toBeUndefined();
	});

	test("a completed run records the target its action id names", () => {
		const { observation: run } = observation({
			targets: [
				target({ id: "app/api/run/docker/default", profile: "default" }),
				target({
					id: "app/api/run/docker/canary",
					profile: "canary",
					label: "canary",
				}),
			],
		});
		const recorded = run.recordCompletedRun(
			{
				id: "app/api/run/docker/canary",
				owner: { kind: "app", id: "api" },
				type: "run",
				runtime: "docker",
			},
			{ ident: "api", localDirectoryPath: "/src/api" },
		);
		expect(recorded).toBe(true);
		expect(run.runTargetInfo("api")?.label).toBe("canary");
		expect(run.lastRunRuntime("api")).toBe("docker");
	});

	test("a podman action selects the podman variant of the same target", () => {
		const { observation: run } = observation({
			targets: [target({ id: "app/api/run/docker/default" })],
		});
		expect(
			run.recordCompletedRun(
				{
					id: "app/api/run/podman/default",
					owner: { kind: "app", id: "api" },
					type: "run",
					runtime: "podman",
				},
				{ ident: "api", localDirectoryPath: "/src/api" },
			),
		).toBe(true);
		expect(run.runTargetInfo("api")?.runtime).toBe("podman");
		expect(run.runTargetInfo("api")?.targetId).toBe(
			"app/api/run/podman/default",
		);
	});

	test("a non-run action or a mismatched profile records nothing", () => {
		const { observation: run } = observation({
			targets: [target({ id: "app/api/run/docker/default" })],
		});
		expect(
			run.recordCompletedRun(
				{
					id: "app/api/stop/docker/default",
					owner: { kind: "app", id: "api" },
					type: "stop",
					runtime: "docker",
				},
				{ ident: "api", localDirectoryPath: "/src/api" },
			),
		).toBe(false);
		expect(
			run.recordCompletedRun(
				{
					id: "app/api/run/docker/other",
					owner: { kind: "app", id: "api" },
					type: "run",
					runtime: "docker",
				},
				{ ident: "api", localDirectoryPath: "/src/api" },
			),
		).toBe(false);
		expect(run.runTargetInfo("api")).toBeUndefined();
	});
});

describe("shell tmux runs", () => {
	test("a live pane keeps the run active", async () => {
		const { observation: run } = observation({
			tmux: true,
			outputs: {
				"tmux display-message -p -t @7 #{window_id}:#{pane_pid}": `@7:${process.pid}`,
			},
		});
		run.noteShellTmuxRun("api", {
			targetId: "app/api/run/tmux/default",
			profile: "default",
			windowId: "@7",
			pid: process.pid,
		});
		expect(await run.isShellTmuxRunActive("api")).toBe(true);
	});

	test("a vanished window stops the run and clears its target", async () => {
		const { observation: run, rows } = observation({
			tmux: true,
			errors: {
				"tmux display-message -p -t @7 #{window_id}:#{pane_pid}": new Error(
					"can't find window",
				),
			},
		});
		run.setRunTargetInfo(
			"api",
			target({ runtime: "shell", launchMode: "tmux" }),
		);
		run.noteShellTmuxRun("api", {
			targetId: "app/api/run/tmux/default",
			profile: "default",
			windowId: "@7",
			pid: process.pid,
		});
		expect(await run.isShellTmuxRunActive("api")).toBe(false);
		expect(run.runTargetInfo("api")).toBeUndefined();
		expect(rows.api).toBeUndefined();
	});

	test("an untracked app has no active run", async () => {
		const { observation: run, calls } = observation({ tmux: true });
		expect(await run.isShellTmuxRunActive("api")).toBe(false);
		expect(calls).toEqual([]);
	});

	test("recovery adopts only this app's windows", async () => {
		const { observation: run, calls } = observation({
			tmux: true,
			outputs: {
				"tmux list-windows -a -F #{window_id}:#{window_name}:#{pane_pid}": [
					`@1:devenv - api - default:${process.pid}`,
					`@2:devenv - infra - clock:${process.pid}`,
					"@3:devenv - unknown - default:1234",
					"@4:user-shell:1234",
				].join("\n"),
			},
		});
		expect(await run.recoverShellTmuxRuns([{ ident: "api" }])).toBe(1);
		expect(calls).toHaveLength(1);
		// The adopted run is live because its pane process is alive: the
		// display-message stub returns no pid, so the recorded one is used.
		expect(await run.isShellTmuxRunActive("api")).toBe(true);
	});

	test("recovery does nothing outside tmux", async () => {
		const { observation: run, calls } = observation({});
		expect(await run.recoverShellTmuxRuns([{ ident: "api" }])).toBe(0);
		expect(calls).toEqual([]);
	});
});

describe("kubernetes run status", () => {
	const kubeTarget = (release: string): ActionTarget =>
		target({
			id: `app/api/run/kubernetes/${release}`,
			runtime: "kubernetes",
			label: release,
			kubernetes: {
				chartPath: "/src/chart",
				release,
				namespace: "apps",
				contextName: "kind-devenv",
			},
		});

	test("pod phases map to the Go status strings", async () => {
		const cases: [string, string][] = [
			["api-1  1/1  Running  0  1m\n", "running (1/1 pods)"],
			["api-1  0/1  Pending  0  1m\n", "starting (0/1 pods)"],
			["api-1  0/1  CrashLoopBackOff  3  1m\n", "failed (0/1 pods)"],
			["", "stopped (0 pods)"],
			["No resources found in apps namespace.\n", "stopped (0 pods)"],
		];
		for (const [output, expected] of cases) {
			const { observation: run } = observation({
				outputs: {
					"kubectl --context kind-devenv get pods --namespace apps -l app.kubernetes.io/instance=api --no-headers":
						output,
				},
			});
			expect(
				await run.kubernetesTargetStatus({
					chartPath: "/src/chart",
					release: "api",
					namespace: "apps",
					contextName: "kind-devenv",
				}),
			).toBe(expected);
		}
	});

	test("a failed kubectl read is stopped, never a fabricated running", async () => {
		const { observation: run } = observation({
			errors: {
				"kubectl --context kind-devenv get pods --namespace apps -l app.kubernetes.io/instance=api --no-headers":
					new Error("connection refused"),
			},
		});
		expect(
			await run.kubernetesTargetStatus({
				chartPath: "/src/chart",
				release: "api",
				namespace: "apps",
				contextName: "kind-devenv",
			}),
		).toBe("stopped (0 pods)");
	});

	test("the highest-ranked target wins and equal states aggregate", async () => {
		const { observation: run } = observation({
			targets: [kubeTarget("api"), kubeTarget("worker")],
			outputs: {
				"kubectl --context kind-devenv get pods --namespace apps -l app.kubernetes.io/instance=api --no-headers":
					"api-1  1/1  Running  0  1m\n",
				"kubectl --context kind-devenv get pods --namespace apps -l app.kubernetes.io/instance=worker --no-headers":
					"worker-1  0/1  Pending  0  1m\n",
			},
		});
		expect(await run.discoverKubernetesRunStatus("api", "/src/api")).toBe(
			"running (1/1 pods)",
		);

		const tied = observation({
			targets: [kubeTarget("api"), kubeTarget("worker")],
			outputs: {
				"kubectl --context kind-devenv get pods --namespace apps -l app.kubernetes.io/instance=api --no-headers":
					"api-1  1/1  Running  0  1m\n",
				"kubectl --context kind-devenv get pods --namespace apps -l app.kubernetes.io/instance=worker --no-headers":
					"worker-1  1/1  Running  0  1m\n",
			},
		});
		expect(
			await tied.observation.discoverKubernetesRunStatus("api", "/src/api"),
		).toBe("running (2 targets)");
	});

	test("no kubernetes target reports zero pods, not absence of the app", async () => {
		const { observation: run } = observation({ targets: [] });
		expect(await run.discoverKubernetesRunStatus("api", "/src/api")).toBe(
			"stopped (0 pods)",
		);
	});

	test("ranking and pane parsing", () => {
		expect(kubernetesRank("running (1/1 pods)")).toBe(3);
		expect(kubernetesRank("starting (0/1 pods)")).toBe(2);
		expect(kubernetesRank("failed (0/1 pods)")).toBe(1);
		expect(kubernetesRank("stopped (0 pods)")).toBe(0);
		expect(parsePanePid("@7:4242")).toBe(4242);
		// A bare window id carries no pane pid, as Go's parser also concluded.
		expect(parsePanePid("@7")).toBe(0);
		expect(parsePanePid("junk")).toBe(0);
	});
});
