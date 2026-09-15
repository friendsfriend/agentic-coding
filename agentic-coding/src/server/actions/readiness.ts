// Readiness gates and probes (`port-action-execution-to-bun`, task 2.6).
//
// Ported from `server/pkg/actionexec/{readiness,container_readiness,
// compose_readiness,kubernetes_readiness}.go`.
//
// Startup succeeds only after its readiness step: a probe that never becomes
// ready fails the action instead of marking the startup successful, and a probe
// that finds the resource already healthy produces `already-running` with no
// command, because no startup command was fabricated for work that did not run.
import type { ActionStepDefinition } from "@devenv/types";
import type { CommandRunner } from "./command.ts";
import { endpointExports } from "./command.ts";
import type { ProcessStore } from "./process.ts";
import type { HandlerContext, StepResult } from "./step-result.ts";
import { OUTCOME } from "./step-result.ts";
import { VALUE_TYPE_ENDPOINT } from "./values.ts";

// --- probes ---------------------------------------------------------------

/** A launch is considered stable after this long without a readiness signal. */
export const DEFAULT_STABILIZATION_INTERVAL_MS = 1000;

export interface ReadinessProbe {
	/** Resolves when the resource is ready; rejects with why it is not. */
	wait(signal?: AbortSignal): Promise<void>;
}

export function probeFunc(
	check: (signal?: AbortSignal) => Promise<void>,
): ReadinessProbe {
	return { wait: check };
}

export class CommandProbe implements ReadinessProbe {
	constructor(
		private readonly runner: CommandRunner,
		private readonly spec: {
			name: string;
			args: string[];
			dir?: string;
			env?: string[];
		},
	) {}

	async wait(signal?: AbortSignal): Promise<void> {
		const result = await this.runner.run(this.spec, undefined, signal);
		if (result.error) throw result.error;
	}
}

/**
 * Watches a process (or its tmux pane) for a stabilization window: a process
 * that exits before its readiness condition is a failure, not a success.
 */
export class ProcessSurvivalProbe implements ReadinessProbe {
	constructor(
		private readonly pid: number,
		private readonly intervalMs = DEFAULT_STABILIZATION_INTERVAL_MS,
		private readonly paneAlive?: () => boolean,
	) {}

	async wait(signal?: AbortSignal): Promise<void> {
		const interval =
			this.intervalMs > 0 ? this.intervalMs : DEFAULT_STABILIZATION_INTERVAL_MS;
		const deadline = Date.now() + interval;
		for (;;) {
			if (signal?.aborted) throw abortError(signal);
			if (this.paneAlive) {
				if (!this.paneAlive()) {
					throw new Error("tmux pane exited before readiness");
				}
			} else if (processDead(this.pid)) {
				throw new Error(`process ${this.pid} exited before readiness`);
			}
			if (Date.now() >= deadline) return;
			await sleep(Math.min(25, Math.max(1, deadline - Date.now())), signal);
		}
	}
}

/** Whether the process is gone; signal 0 only probes existence. */
export function processDead(pid: number): boolean {
	if (pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

export class TCPProbe implements ReadinessProbe {
	constructor(
		private readonly address: string,
		private readonly intervalMs = 0,
	) {}

	async wait(signal?: AbortSignal): Promise<void> {
		return poll(this.intervalMs, signal, async () => {
			const separator = this.address.lastIndexOf(":");
			const host = this.address.slice(0, separator);
			const port = Number(this.address.slice(separator + 1));
			const socket = await Bun.connect({
				hostname: host,
				port,
				socket: { data() {}, error() {}, open() {}, close() {} },
			});
			socket.end();
		});
	}
}

export class HTTPProbe implements ReadinessProbe {
	constructor(
		private readonly url: string,
		private readonly intervalMs = 0,
	) {}

	async wait(signal?: AbortSignal): Promise<void> {
		return poll(this.intervalMs, signal, async () => {
			const response = await fetch(this.url, {
				method: "GET",
				...(signal ? { signal } : {}),
			});
			await response.arrayBuffer();
			if (response.status >= 400) {
				throw new Error(`readiness HTTP status ${response.status}`);
			}
		});
	}
}

export class ContainerHealthProbe implements ReadinessProbe {
	constructor(
		private readonly runner: CommandRunner,
		private readonly container: string,
		private readonly intervalMs = 0,
		private readonly runtime = "docker",
	) {}

	async wait(signal?: AbortSignal): Promise<void> {
		return poll(this.intervalMs, signal, async () => {
			const result = await this.runner.run(
				{
					name: this.runtime,
					args: [
						"inspect",
						"--format",
						"{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
						this.container,
					],
				},
				undefined,
				signal,
			);
			if (result.error) throw result.error;
			const status = result.stdout.trim();
			if (
				status.startsWith("running") &&
				(status.includes("healthy") || !status.includes("starting"))
			) {
				return;
			}
			throw new Error(`container ${this.container} not ready: ${status}`);
		});
	}
}

export class ComposeReadinessProbe implements ReadinessProbe {
	constructor(
		private readonly runner: CommandRunner,
		private readonly name: string,
		private readonly args: readonly string[] = [],
		private readonly intervalMs = 0,
	) {}

	async wait(signal?: AbortSignal): Promise<void> {
		return poll(this.intervalMs, signal, async () => {
			// `--all` is a docker-compose flag; podman-compose rejects it.
			const args = [...this.args, "ps"];
			if (!this.name.startsWith("podman-compose")) args.push("--all");
			args.push("--format", "{{.State}}");
			const result = await this.runner.run(
				{ name: this.name, args },
				undefined,
				signal,
			);
			if (result.error) throw result.error;
			const states = result.stdout.trim().split(/\s+/).filter(Boolean);
			if (states.length === 0) throw new Error("compose has no containers");
			for (const state of states) {
				if (state.toLowerCase() !== "running") {
					throw new Error(`compose container not ready: ${state}`);
				}
			}
		});
	}
}

export class KubernetesPodReadinessProbe implements ReadinessProbe {
	constructor(
		private readonly runner: CommandRunner,
		private readonly context = "",
		private readonly namespace = "",
		private readonly selector = "",
		private readonly timeout = "",
		private readonly intervalMs = 0,
	) {}

	async wait(signal?: AbortSignal): Promise<void> {
		const interval = this.intervalMs > 0 ? this.intervalMs : 1000;
		const args: string[] = [];
		if (this.context !== "") args.push("--context", this.context);
		if (this.namespace !== "") args.push("--namespace", this.namespace);
		for (;;) {
			if (signal?.aborted) throw abortError(signal);
			const listed = await this.runner.run(
				{
					name: "kubectl",
					args: [...args, "get", "pods", "-l", this.selector, "-o", "name"],
				},
				undefined,
				signal,
			);
			if (listed.error) throw listed.error;
			if (listed.stdout.trim() !== "") {
				const timeout = this.timeout !== "" ? this.timeout : "5m";
				const waited = await this.runner.run(
					{
						name: "kubectl",
						args: [
							...args,
							"wait",
							"--for=condition=ready",
							"pod",
							"-l",
							this.selector,
							"--timeout",
							timeout,
						],
					},
					undefined,
					signal,
				);
				if (waited.error) throw waited.error;
				return;
			}
			await sleep(interval, signal);
		}
	}
}

/**
 * Retries a readiness check until it passes. A failing check is never the
 * returned error — Go keeps polling and reports the context's cancellation
 * instead — so only an abort ends the loop.
 */
export async function poll(
	intervalMs: number,
	signal: AbortSignal | undefined,
	check: () => Promise<void>,
): Promise<void> {
	const interval = intervalMs > 0 ? intervalMs : 100;
	for (;;) {
		try {
			await check();
			return;
		} catch {
			if (signal?.aborted) throw abortError(signal);
		}
		await sleep(interval, signal);
	}
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error("context canceled");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError(signal);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal as AbortSignal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// --- readiness step -------------------------------------------------------

/**
 * Describes how to probe one readiness step. A probe is created before it is
 * awaited so a construction failure (a missing process handle, an unavailable
 * container runtime) fails the step instead of hanging.
 */
export interface ProbeFactory {
	probe(
		context: HandlerContext | undefined,
		step: ActionStepDefinition,
	): ReadinessProbe;
}

export class ReadinessHandler {
	constructor(private readonly factory: ProbeFactory) {}

	async execute(
		context: HandlerContext,
		step: ActionStepDefinition,
	): Promise<StepResult> {
		const configuration = step.configuration ?? {};
		let probe: ReadinessProbe;
		try {
			probe = this.factory.probe(context, step);
		} catch (error) {
			return { outcome: OUTCOME.failed, error: asError(error) };
		}
		try {
			await probe.wait(context.signal);
		} catch (error) {
			return { outcome: OUTCOME.failed, error: asError(error) };
		}
		for (const endpoint of endpointExports(configuration)) {
			context.values.set(`endpoint.${endpoint.name}`, {
				type: VALUE_TYPE_ENDPOINT,
				visibility: "public",
				data: endpoint,
			});
		}
		return { outcome: OUTCOME.executed };
	}
}

/** How the standard factory reaches the resources a probe has to observe. */
export interface StandardProbeFactoryOptions {
	processes?: ProcessStore;
	/** Whether a tmux pane is still alive. */
	paneAlive?: (paneId: string) => boolean;
	/** Where a `git`/`kubectl`/container probe runs its command. */
	runner?: CommandRunner;
	container?: (containerId: string) => ReadinessProbe;
	compose?: (step: ActionStepDefinition) => ReadinessProbe;
	kubernetes?: (step: ActionStepDefinition) => ReadinessProbe;
}

export class StandardProbeFactory implements ProbeFactory {
	constructor(private readonly options: StandardProbeFactoryOptions = {}) {}

	probe(
		_context: HandlerContext | undefined,
		step: ActionStepDefinition,
	): ReadinessProbe {
		const configuration = step.configuration ?? {};
		const kind = configuration.probe;
		if (kind === "tcp") {
			return new TCPProbe(
				String(configuration.address ?? ""),
				numberOr(configuration.stabilizationMs, 0),
			);
		}
		if (kind === "http") {
			return new HTTPProbe(
				String(configuration.url ?? ""),
				numberOr(configuration.stabilizationMs, 0),
			);
		}
		if (kind === "container-health") {
			const containerId = String(configuration.containerId ?? "");
			if (!this.options.container) {
				throw new Error("container readiness unavailable");
			}
			return this.options.container(containerId);
		}
		if (kind === "kubernetes") {
			if (!this.options.kubernetes) {
				throw new Error("kubernetes readiness unavailable");
			}
			return this.options.kubernetes(step);
		}
		if (kind === "compose") {
			if (!this.options.compose) {
				throw new Error("compose readiness unavailable");
			}
			return this.options.compose(step);
		}
		const processStepId = configuration.processStepId;
		if (typeof processStepId === "string" && processStepId !== "") {
			const handle = this.options.processes?.get(processStepId);
			if (!handle) {
				throw new Error(`process handle ${processStepId} unavailable`);
			}
			const interval = numberOr(
				configuration.stabilizationMs,
				DEFAULT_STABILIZATION_INTERVAL_MS,
			);
			const paneId = handle.paneId;
			const paneAlive = this.options.paneAlive;
			return new ProcessSurvivalProbe(
				handle.pid ?? 0,
				interval,
				paneId && paneAlive ? () => paneAlive(paneId) : undefined,
			);
		}
		// No specific probe configured — a brief stabilization delay. This covers
		// dependency targets whose start command already succeeded.
		const interval = numberOr(
			configuration.stabilizationMs,
			DEFAULT_STABILIZATION_INTERVAL_MS,
		);
		return probeFunc(async (signal) => {
			await sleep(interval, signal);
		});
	}
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
