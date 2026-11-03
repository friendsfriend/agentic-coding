import type { Plan } from "./catalog.ts";
import { containerPlans, verifyCompose } from "./compose-config.ts";
import { ContainerProcess } from "./container.ts";
import type { EnvironmentProcess, Exit } from "./process.ts";

/** A Compose file is compiled to independent, receipt-fenced creations, never
 * `compose up/down`: project labels cannot prove which resources we created. */
export class ComposeProcess implements EnvironmentProcess {
	readonly pid = null;
	readonly done: Promise<Exit>;
	private complete: (exit: Exit) => void = () => {};
	private children: ContainerProcess[] = [];
	private starting: Promise<void> | null = null;
	private stopping: Promise<void> | null = null;
	private controller = new AbortController();
	private result: Exit | null = null;
	private failedCleanup = false;
	constructor(
		private plan: Plan,
		private configDir: string,
		private stateDir: string,
		private run: string,
	) {
		this.done = new Promise((resolve) => {
			this.complete = resolve;
		});
	}
	get outcome() {
		return this.result;
	}
	get cleanupFailed() {
		return (
			this.failedCleanup || this.children.some((child) => child.cleanupFailed)
		);
	}
	get runtimeStatuses() {
		return this.children.flatMap((child) =>
			child.runtimeStatus ? [child.runtimeStatus] : [],
		);
	}
	get logs() {
		return this.children
			.map(
				(child, index) =>
					`[${this.plan.composePlan?.services[index]?.id ?? "service"}]\n${child.logs}`,
			)
			.join("\n")
			.slice(-64000);
	}
	private async start() {
		verifyCompose(this.plan);
		const deadline = Date.now() + this.plan.timeoutMs;
		for (const [index, plan] of containerPlans(this.plan).entries()) {
			this.controller.signal.throwIfAborted();
			const left = deadline - Date.now();
			if (left <= 0) throw new Error("Compose startup timed out");
			const child = new ContainerProcess(
				{ ...plan, timeoutMs: left },
				this.configDir,
				this.stateDir,
				`${this.run}:${index}`,
			);
			this.children.push(child);
			void child.done
				.then(() => this.stop())
				.catch(() => {
					/* Cleanup uncertainty retains the stack lease. */
				});
			await child.ready(this.controller.signal);
		}
	}
	async ready(signal?: AbortSignal) {
		const abort = () => this.controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			this.starting ??= this.start();
			await this.starting;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	async wait(signal?: AbortSignal) {
		await this.ready(signal);
		return this.done;
	}
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = (async () => {
			this.controller.abort();
			try {
				await this.starting;
			} catch {
				/* Partial creation is still cleaned with live receipts only. */
			}
			for (const child of [...this.children].reverse())
				try {
					await child.stop();
				} catch {
					this.failedCleanup = true;
				}
			const exits = this.children.map((child) => child.outcome);
			const code =
				this.cleanupFailed ||
				!exits.length ||
				exits.some((exit) => exit?.code === null || !exit)
					? null
					: (exits.find((exit) => exit?.code !== 0)?.code ?? 0);
			this.result = { code, signal: null };
			this.complete(this.result);
			if (this.cleanupFailed)
				throw new Error(
					"Compose cleanup is uncertain; inspect every service before releasing the stack",
				);
		})();
		return this.stopping;
	}
}
