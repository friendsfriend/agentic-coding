// Run-target and Kubernetes run observation
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/build/{service,kubernetes_logs}.go`: the last-run
// runtime, the run-target info the status API publishes, shell tmux run
// tracking (including adoption of windows a previous process left) and the
// Kubernetes run status derived from pod phases.
//
// Two rules are load-bearing:
//
//   - **a status read observes, it does not remember.** A tmux window that
//     disappeared or a pane whose process died reports `stopped` and clears the
//     run target, instead of publishing a remembered `running`;
//   - **an unobservable target is not a running one.** A cluster read that fails
//     reports the stopped/unknown text, never a fabricated success.
import { spawn } from "node:child_process";
import { discoverActionTargets } from "../actions/discovery.ts";
import type {
	ActionTarget,
	KubernetesTargetMetadata,
} from "../actions/targets.ts";
import { type CommandResult, processAlive } from "./script-infrastructure.ts";

/** The run-target metadata `GET /api/status` publishes. */
export interface RunTargetInfo {
	runtime: string;
	launchMode?: string;
	label?: string;
	profile?: string;
	targetId?: string;
	sourcePath?: string;
	startedAt: string;
	display: string;
}

/** The stored projection of `RunTargetInfo` (the state store's shape). */
export interface StoredRunTargetInfo {
	runtime: string;
	launchMode: string;
	label: string;
	profile: string;
	targetId: string;
	sourcePath: string;
	startedAt: string;
	display: string;
}

export interface RunTargetStore {
	getAppRunTargetInfo(ident: string): StoredRunTargetInfo | undefined;
	setAppRunTargetInfo(ident: string, info: StoredRunTargetInfo): void;
	clearAppRunTargetInfo(ident: string): void;
}

interface ShellTmuxRun {
	targetId: string;
	profile: string;
	windowId: string;
	pid: number;
	startedAt: string;
}

export interface RunObservationOptions {
	readonly store?: RunTargetStore;
	/** The tmux window prefix a shell run uses (`devenv - <ident> - <profile>`). */
	readonly runCommand?: (
		command: string,
		args: readonly string[],
	) => Promise<CommandResult>;
	/** Discovers an app's run targets; the observation owns no I/O of its own. */
	readonly discoverTargets?: (
		appIdent: string,
		localDir: string,
	) => readonly ActionTarget[];
	readonly env?: Record<string, string | undefined>;
	readonly now?: () => Date;
	readonly logger?: (message: string) => void;
}

export const SHELL_WINDOW_PREFIX = "devenv - ";
export const INFRA_WINDOW_MARKER = "devenv - infra - ";

/** `[docker] dev (default)`: the badge and label the TUI renders. */
export function formatRunTargetDisplay(target: ActionTarget): string {
	let badge: string = target.runtime;
	if (target.runtime === "docker" && target.provider) badge = target.provider;
	if (target.runtime === "shell" && target.launchMode === "tmux")
		badge = "tmux";
	let label = (target.label ?? "").trim();
	if (label === "") label = (target.profile ?? "").trim();
	if (label === "") label = target.runtime;
	let display = `[${badge}] ${label}`;
	let profile = (target.profile ?? "").trim();
	if (
		profile === "" &&
		target.runtime === "docker" &&
		label.toLowerCase() === "default"
	) {
		profile = "default";
	}
	if (profile !== "") display += ` (${profile})`;
	return display;
}

export class RunObservation {
	private readonly runtimes = new Map<string, string>();
	private readonly runTargets = new Map<string, RunTargetInfo>();
	private readonly tmuxRuns = new Map<string, ShellTmuxRun>();
	private readonly store?: RunTargetStore;
	private readonly runCommand: (
		command: string,
		args: readonly string[],
	) => Promise<CommandResult>;
	private readonly discoverTargets: (
		appIdent: string,
		localDir: string,
	) => readonly ActionTarget[];
	private readonly env: Record<string, string | undefined>;
	private readonly now: () => Date;
	private readonly logger?: (message: string) => void;

	constructor(options: RunObservationOptions = {}) {
		this.store = options.store;
		this.runCommand = options.runCommand ?? spawnCommand;
		this.discoverTargets =
			options.discoverTargets ??
			((appIdent, localDir) =>
				discoverActionTargets({
					appIdent,
					localDir,
					action: "run",
					configDir: "",
				}));
		this.env = options.env ?? process.env;
		this.now = options.now ?? (() => new Date());
		this.logger = options.logger;
	}

	// --- last-run runtime ---

	lastRunRuntime(appIdent: string): string {
		return this.runtimes.get(appIdent) ?? "";
	}

	setLastRunRuntime(appIdent: string, runtime: string): void {
		this.runtimes.set(appIdent, runtime);
	}

	// --- run target info ---

	runTargetInfo(appIdent: string): RunTargetInfo | undefined {
		const inMemory = this.runTargets.get(appIdent);
		if (inMemory) return inMemory;
		const stored = this.store?.getAppRunTargetInfo(appIdent);
		if (!stored) return undefined;
		this.runTargets.set(appIdent, stored);
		return stored;
	}

	setRunTargetInfo(appIdent: string, target: ActionTarget): RunTargetInfo {
		const runtime =
			target.runtime === "docker" && target.provider
				? target.provider
				: target.runtime;
		const info: RunTargetInfo = {
			runtime,
			...(target.launchMode === undefined
				? {}
				: { launchMode: target.launchMode }),
			...(target.label === undefined ? {} : { label: target.label }),
			...(target.profile === undefined ? {} : { profile: target.profile }),
			targetId: target.id,
			sourcePath: target.sourcePath,
			startedAt: this.now().toISOString(),
			display: formatRunTargetDisplay(target),
		};
		this.runTargets.set(appIdent, info);
		try {
			this.store?.setAppRunTargetInfo(appIdent, {
				runtime: info.runtime,
				launchMode: info.launchMode ?? "",
				label: info.label ?? "",
				profile: info.profile ?? "",
				targetId: info.targetId ?? "",
				sourcePath: info.sourcePath ?? "",
				startedAt: info.startedAt,
				display: info.display,
			});
		} catch (error) {
			this.logger?.(
				`[run] persisting the run target for ${appIdent} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		return info;
	}

	clearRunTargetInfo(appIdent: string): void {
		this.runTargets.delete(appIdent);
		try {
			this.store?.clearAppRunTargetInfo(appIdent);
		} catch {
			/* a missing row is already cleared */
		}
	}

	// --- shell tmux runs ---

	/** Records the window a shell run just opened. */
	noteShellTmuxRun(
		appIdent: string,
		run: { targetId: string; profile: string; windowId: string; pid: number },
	): void {
		this.tmuxRuns.set(appIdent, {
			...run,
			startedAt: this.now().toISOString(),
		});
	}

	/**
	 * Whether the app's shell run is still alive. A window that disappeared or a
	 * dead pane clears the run and its target info, so the next status read
	 * reports stopped.
	 */
	async isShellTmuxRunActive(appIdent: string): Promise<boolean> {
		const run = this.tmuxRuns.get(appIdent);
		if (!run) return false;
		const result = await this.runCommand("tmux", [
			"display-message",
			"-p",
			"-t",
			run.windowId,
			"#{window_id}:#{pane_pid}",
		]);
		if (result.error) {
			this.tmuxRuns.delete(appIdent);
			this.clearRunTargetInfo(appIdent);
			return false;
		}
		const pid = parsePanePid(result.output);
		if (pid > 0) run.pid = pid;
		if (run.pid > 0 && !processAlive(run.pid)) {
			this.tmuxRuns.delete(appIdent);
			this.clearRunTargetInfo(appIdent);
			return false;
		}
		return true;
	}

	/** Adopts the shell windows a previous process left (only inside tmux). */
	async recoverShellTmuxRuns(
		apps: readonly { readonly ident: string }[],
	): Promise<number> {
		if ((this.env.TMUX ?? "").trim() === "") return 0;
		const result = await this.runCommand("tmux", [
			"list-windows",
			"-a",
			"-F",
			"#{window_id}:#{window_name}:#{pane_pid}",
		]);
		if (result.error) return 0;
		const known = new Set(apps.map((app) => app.ident));
		let adopted = 0;
		for (const line of result.output.split("\n")) {
			const parts = line.trim().split(":");
			if (parts.length < 3) continue;
			const windowId = parts[0].trim();
			const windowName = parts.slice(1, -1).join(":").trim();
			const pid = Number.parseInt(parts[parts.length - 1].trim(), 10);
			if (windowId === "" || !windowName.startsWith(SHELL_WINDOW_PREFIX))
				continue;
			if (windowName.startsWith(INFRA_WINDOW_MARKER)) continue;
			const segments = windowName.split(" - ");
			if (segments.length < 3) continue;
			const ident = segments[1].trim();
			const profile = segments[2].trim();
			if (!known.has(ident)) continue;
			if (Number.isFinite(pid) && pid > 0 && !processAlive(pid)) continue;
			if (this.tmuxRuns.has(ident)) continue;
			this.tmuxRuns.set(ident, {
				targetId: "",
				profile,
				windowId,
				pid: Number.isFinite(pid) ? pid : 0,
				startedAt: this.now().toISOString(),
			});
			adopted++;
		}
		return adopted;
	}

	/**
	 * Records the target a completed `run` action used, so the status API shows
	 * what was last started. The action id's last segment is the profile, and a
	 * `podman` runtime selects the podman variant of the same target.
	 */
	recordCompletedRun(
		definition: {
			readonly id: string;
			readonly owner: { readonly kind: string; readonly id: string };
			readonly type: string;
			readonly runtime: string;
		},
		app: { readonly ident: string; readonly localDirectoryPath: string },
	): boolean {
		if (definition.owner.kind !== "app" || definition.type !== "run") {
			return false;
		}
		let targets: readonly ActionTarget[];
		try {
			targets = this.discoverTargets(app.ident, app.localDirectoryPath);
		} catch {
			return false;
		}
		const profile = definition.id.split("/").pop() ?? "";
		for (const target of targets) {
			const targetProfile = target.profile === "" ? "default" : target.profile;
			if (targetProfile !== profile) continue;
			if (target.runtime === "docker" && definition.runtime === "podman") {
				const podmanTarget: ActionTarget = {
					...target,
					provider: "podman",
					id: definition.id,
				};
				this.setRunTargetInfo(app.ident, podmanTarget);
				this.setLastRunRuntime(app.ident, podmanTarget.runtime);
				return true;
			}
			if (target.runtime !== definition.runtime) continue;
			this.setRunTargetInfo(app.ident, target);
			this.setLastRunRuntime(app.ident, target.runtime);
			return true;
		}
		return false;
	}

	// --- kubernetes run status ---

	/**
	 * The Kubernetes run status for an app: the highest-ranked pod observation
	 * across its run targets, as a `running (1/1 pods)` string.
	 */
	async discoverKubernetesRunStatus(
		appIdent: string,
		localDir: string,
	): Promise<string> {
		let targets: readonly ActionTarget[];
		try {
			targets = this.discoverTargets(appIdent, localDir);
		} catch {
			return "stopped";
		}
		const candidates: {
			id: string;
			status: string;
			metadata: KubernetesTargetMetadata;
		}[] = [];
		for (const target of targets) {
			if (target.runtime !== "kubernetes" || !target.kubernetes) continue;
			candidates.push({
				id: target.id,
				status: await this.kubernetesTargetStatus(target.kubernetes),
				metadata: target.kubernetes,
			});
		}
		if (candidates.length === 0) return "stopped (0 pods)";
		// The highest-ranked observation wins; equal states aggregate.
		const ranked = [...candidates].sort(
			(a, b) => kubernetesRank(b.status) - kubernetesRank(a.status),
		);
		const best = ranked[0];
		const tied = ranked.filter(
			(candidate) =>
				kubernetesRank(candidate.status) === kubernetesRank(best.status),
		);
		if (tied.length > 1 && kubernetesRank(best.status) > 0) {
			return `running (${tied.length} targets)`;
		}
		return best.status;
	}

	/** Pod phases for one release: `running (1/1 pods)`, `failed (0/1 pods)`. */
	async kubernetesTargetStatus(
		target: KubernetesTargetMetadata,
	): Promise<string> {
		const context =
			target.contextName === undefined || target.contextName === ""
				? "kind-devenv"
				: target.contextName;
		const namespace =
			target.namespace === undefined || target.namespace === ""
				? "default"
				: target.namespace;
		const result = await this.runCommand("kubectl", [
			"--context",
			context,
			"get",
			"pods",
			"--namespace",
			namespace,
			"-l",
			`app.kubernetes.io/instance=${target.release}`,
			"--no-headers",
		]);
		const output = result.output.trim();
		if (
			result.error ||
			output === "" ||
			output.toLowerCase().startsWith("no resources found")
		) {
			return "stopped (0 pods)";
		}
		let total = 0;
		let running = 0;
		let failed = 0;
		for (const line of output.split("\n")) {
			const fields = line.split(/\s+/).filter(Boolean);
			if (fields.length < 3) continue;
			total++;
			const phase = fields[2].toLowerCase();
			if (phase === "running" || phase === "succeeded") running++;
			if (phase === "failed" || phase === "error" || phase.includes("crash")) {
				failed++;
			}
		}
		if (total === 0) return "stopped (0 pods)";
		if (failed > 0) return `failed (${running}/${total} pods)`;
		if (running === total) return `running (${running}/${total} pods)`;
		return `starting (${running}/${total} pods)`;
	}
}

/** Ranks pod observations so the highest one wins across targets. */
export function kubernetesRank(status: string): number {
	const value = status.toLowerCase();
	if (value.startsWith("running")) return 3;
	if (value.startsWith("starting")) return 2;
	if (value.startsWith("failed")) return 1;
	return 0;
}

/** Parses `window_id:pane_pid`. */
export function parsePanePid(output: string): number {
	const parts = output.trim().split(":");
	const last = parts[parts.length - 1]?.trim() ?? "";
	const match = last.match(/^\d+$/);
	return match ? Number.parseInt(match[0], 10) : 0;
}

/** Default argv runner for tmux and kubectl observation. */
export function spawnCommand(
	command: string,
	args: readonly string[],
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", (error) => resolve({ output, error }));
		child.on("close", (code) =>
			resolve({
				output,
				...(code === 0
					? {}
					: { error: new Error(`${command} ${args.join(" ")}: exit ${code}`) }),
			}),
		);
	});
}
