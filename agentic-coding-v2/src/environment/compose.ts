import { containerPlans, verifyCompose } from "./compose-config.ts";
import { ComposeNetwork } from "./compose-network.ts";
import { ComposeVolumes } from "./compose-volumes.ts";
import { ContainerProcess } from "./container.ts";
import { clampedCapture } from "./log-timing.ts";
import type { Plan } from "./model.ts";
import type { EnvironmentProcess, Exit } from "./process.ts";
import { processEnvironment } from "./shell.ts";
import type { TelemetryCollector } from "./telemetry.ts";

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
	private network: ReturnType<ComposeNetwork["join"]> | null = null;
	private bridge: ComposeNetwork | null = null;
	private ownedNetwork: ComposeNetwork | null = null;
	private volumes: ComposeVolumes | null = null;
	private frozen: ReturnType<typeof processEnvironment>;
	private plans: Plan[];
	private serviceEnvironments: ReturnType<typeof processEnvironment>[];
	private observing: Promise<void> = Promise.resolve();
	constructor(
		private plan: Plan,
		private configDir: string,
		private stateDir: string,
		private run: string,
		readonly telemetry?: TelemetryCollector,
		bridge?: ComposeNetwork,
	) {
		if (
			plan.compose?.networkOnly &&
			(plan.projectKind !== "infrastructure" ||
				!plan.composePlan ||
				plan.composePlan.services.length !== 0 ||
				plan.compose.network !== "shared" ||
				bridge)
		)
			throw new Error(
				"An original network-only topology needs a reviewed empty infrastructure plan",
			);
		if (Boolean(plan.compose?.networkFrom) !== Boolean(bridge))
			throw new Error(
				"A prerequisite bridge needs the exact original live binding, never a saved network ID",
			);
		if (Boolean(plan.telemetry) !== Boolean(telemetry))
			throw new Error(
				"Compose telemetry requires the exact original live receiver",
			);
		const parent = processEnvironment(configDir, plan);
		this.plans = containerPlans(plan);
		// Resolve every service before creating a network or container. A missing
		// later-service reference cannot leave a partially started stack.
		const environments = this.plans.map((service) =>
			processEnvironment(configDir, service),
		);
		// One longest-first set across the stack also protects overlapping secrets
		// in sibling logs; per-service sequential redaction could expose suffixes.
		const hidden = [
			...new Set([
				...parent.redactionValues,
				...environments.flatMap((environment) => environment.redactionValues),
			]),
		].sort((a, b) => b.length - a.length);
		telemetry?.includeRedactions(hidden);
		const redact = (value: string) =>
			environments.reduce(
				(text, environment) => environment.redact(text),
				parent.redact(
					hidden.reduce(
						(text, secret) => text.replaceAll(secret, "[REDACTED]"),
						telemetry?.redact(value) ?? value,
					),
				),
			);
		this.frozen = { ...parent, redact };
		this.serviceEnvironments = environments.map((environment, index) => ({
			...environment,
			env: {
				...environment.env,
				...(telemetry &&
				plan.telemetry &&
				"collectorService" in plan.telemetry &&
				plan.composePlan?.services[index]?.id ===
					plan.telemetry.collectorService
					? telemetry.containerEnvironment()
					: {}),
			},
			redact,
		}));
		if (plan.composePlan?.volumes?.length)
			this.volumes = new ComposeVolumes(plan, stateDir, configDir, this.frozen);
		if (plan.compose?.network !== "isolated") {
			this.bridge =
				bridge ??
				new ComposeNetwork(
					plan,
					configDir,
					stateDir,
					`${run}:network`,
					this.frozen,
				);
			if (!bridge) this.ownedNetwork = this.bridge;
			if (!plan.compose?.networkOnly)
				this.network = this.bridge.join(
					(plan.composePlan?.services ?? []).map((service) => service.id),
				);
		}
		this.done = new Promise((resolve) => {
			this.complete = resolve;
		});
	}
	/** An internal live capability, minted only after original infrastructure
	 * re-observation. The manager separately proves same-owner graph authority. */
	async bridgeFor(dependent: Plan, signal?: AbortSignal) {
		const from = dependent.compose?.networkFrom;
		if (
			!from ||
			this.plan.projectKind !== "infrastructure" ||
			from.app !== this.plan.app ||
			from.target !== this.plan.id ||
			this.plan.compose?.provider !== dependent.compose?.provider ||
			this.plan.compose?.socket !== dependent.compose?.socket ||
			!this.bridge ||
			this.closing ||
			this.result ||
			this.cleanupFailed
		)
			throw new Error(
				"Original prerequisite bridge scope is unavailable or changed",
			);
		const service = this.plan.composePlan?.services.find(
			(service) => !service.container.completion,
		);
		if (this.plan.compose?.networkOnly) {
			if (!this.ownedNetwork || this.ownedNetwork !== this.bridge)
				throw new Error("Missing original topology creation authority");
			await this.ownedNetwork.attachment(
				2000,
				AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]),
			);
		} else {
			if (!service)
				throw new Error(
					"A bridge prerequisite needs an original live non-completion infrastructure service",
				);
			await this.observeService(service.id, false, signal, true);
		}
		if (this.closing || this.result || this.cleanupFailed)
			throw new Error("Original prerequisite bridge closed during observation");
		return this.bridge;
	}
	get closing() {
		return this.controller.signal.aborted;
	}
	get outcome() {
		return this.result;
	}
	get cleanupFailed() {
		return (
			this.failedCleanup ||
			this.volumes?.cleanupFailed === true ||
			this.network?.cleanupFailed === true ||
			this.ownedNetwork?.cleanupFailed === true ||
			this.children.some((child) => child.cleanupFailed)
		);
	}
	get runtimeStatuses() {
		const network = this.network ?? this.ownedNetwork;
		return [
			...(network ? [network.runtimeStatus] : []),
			...this.children.flatMap((child) =>
				child.runtimeStatus ? [child.runtimeStatus] : [],
			),
		];
	}
	get serviceLogs() {
		const count = Math.max(1, this.plan.composePlan?.services.length ?? 1),
			cap = Math.floor(64000 / count);
		return Object.fromEntries(
			this.children.map((child, index) => {
				const id = this.plan.composePlan?.services[index]?.id;
				if (!id) throw new Error("Compose service log identity is missing");
				return [id, clampedCapture(child.logs, cap, child.logTiming)];
			}),
		);
	}
	get logs() {
		const network = this.network ?? this.ownedNetwork;
		return [
			this.volumes ? `[volumes]\n${this.volumes.logs}` : "",
			network ? `[network]\n${network.logs}` : "",
			...this.children.map(
				(child, index) =>
					`[${this.plan.composePlan?.services[index]?.id ?? "service"}]\n${child.logs}`,
			),
		]
			.join("\n")
			.slice(-64000);
	}
	/** A service remains authority only inside this original live stack. Check
	 * all non-completion children and the owned network; never borrow a sibling
	 * credential or adopt a copied-label replacement. Queue cancellation covers
	 * the whole observation window, not a fresh budget per queued service. */
	diagnosticService(id: string, signal?: AbortSignal) {
		return this.observeService(id, true, signal);
	}
	async telemetryScope() {
		const capture = this.plan.telemetry;
		if (!this.telemetry || !capture || !("collectorService" in capture))
			throw new Error("No original live Compose telemetry scope");
		try {
			this.telemetry.certificateMount();
		} catch {
			this.failedCleanup = true;
			throw new Error(
				"Original native telemetry certificate scope changed; inspection required",
			);
		}
		await this.observeService(capture.collectorService, false);
	}
	private async observeService(
		id: string,
		requireSelectedHealth: boolean,
		signal?: AbortSignal,
		requireDeclaredHealth = false,
	) {
		const bounded = AbortSignal.any([
			this.controller.signal,
			AbortSignal.timeout(2000),
			...(signal ? [signal] : []),
		]);
		const operation = this.observing.then(async () => {
			bounded.throwIfAborted();
			const services = this.plan.composePlan?.services ?? [];
			const index = services.findIndex((service) => service.id === id);
			const selected = this.children[index];
			if (
				this.result ||
				this.cleanupFailed ||
				this.children.length !== services.length ||
				!selected ||
				services[index]?.container.completion
			)
				throw new Error(
					"Compose diagnostics require the exact original live non-completion service",
				);
			await this.network?.attachment(2000, bounded);
			await this.volumes?.verify(2000, bounded);
			const observations = await Promise.allSettled(
				this.children.map(async (child, position) => {
					const service = services[position];
					if (service?.container.completion) {
						if (child.outcome?.code !== 0 || child.cleanupFailed)
							throw new Error(
								"Compose completion prerequisite no longer has a confirmed successful receipt",
							);
						return;
					}
					const observed = await child.refresh(bounded);
					if (
						child.closing ||
						child.outcome ||
						child.cleanupFailed ||
						observed?.owned !== true ||
						observed.state !== "running" ||
						(((position === index && requireSelectedHealth) ||
							service?.container.readiness === "healthy" ||
							(requireDeclaredHealth && service?.container.health)) &&
							observed.health !== "healthy")
					)
						throw new Error(
							"Compose diagnostics require original owned running services and fresh selected-service health",
						);
				}),
			);
			bounded.throwIfAborted();
			for (const observation of observations)
				if (observation.status === "rejected") throw observation.reason;
			if (this.result || this.cleanupFailed)
				throw new Error("Compose stack is closing");
			return selected;
		});
		this.observing = operation.then(
			() => {},
			() => {},
		);
		let abort = () => {};
		const interrupted = new Promise<never>((_resolve, reject) => {
			abort = () =>
				reject(
					new Error("Compose diagnostic observation interrupted or timed out"),
				);
			bounded.addEventListener("abort", abort, { once: true });
			if (bounded.aborted) abort();
		});
		try {
			return await Promise.race([operation, interrupted]);
		} finally {
			bounded.removeEventListener("abort", abort);
		}
	}
	private async start() {
		verifyCompose(this.plan);
		const completion = new Set(
				(this.plan.composePlan?.services ?? []).flatMap((service) =>
					service.dependsOn
						.filter(
							(dependency) =>
								dependency.condition === "service_completed_successfully",
						)
						.map((dependency) => dependency.id),
				),
			),
			deadline = Date.now() + this.plan.timeoutMs;
		await this.volumes?.start(deadline - Date.now(), this.controller.signal);
		await this.ownedNetwork?.start(
			deadline - Date.now(),
			this.controller.signal,
		);
		for (const [index, plan] of this.plans.entries()) {
			this.controller.signal.throwIfAborted();
			const left = deadline - Date.now();
			if (left <= 0) throw new Error("Compose startup timed out");
			const attachment = await this.network?.attachment(
				deadline - Date.now(),
				this.controller.signal,
			);
			const alias = this.plan.composePlan?.services[index]?.id;
			if (attachment && !alias)
				throw new Error("Compose service alias is missing");
			const environment = this.serviceEnvironments[index];
			if (!environment) throw new Error("Missing frozen service environment");
			const volumeAttachments: {
				name: string;
				target: string;
				readOnly: boolean;
			}[] = [];
			for (const mount of this.plan.composePlan?.services[index]
				?.volumeMounts ?? []) {
				if (!this.volumes)
					throw new Error("Missing live volume ownership scope");
				volumeAttachments.push({
					name: await this.volumes.attachment(
						mount.id,
						deadline - Date.now(),
						this.controller.signal,
					),
					target: mount.target,
					readOnly: mount.readOnly,
				});
			}
			const child = new ContainerProcess(
				{ ...plan, timeoutMs: deadline - Date.now() },
				this.configDir,
				this.stateDir,
				`${this.run}:${index}`,
				attachment && alias
					? { id: attachment.id, aliases: [alias] }
					: undefined,
				{
					...environment,
					env: environment.env,
					queryCredentials: () =>
						plan.queryConnection ? this.frozen.queryCredentials() : undefined,
					authorization: (endpoint) =>
						Object.hasOwn(plan.endpoints ?? {}, endpoint)
							? this.frozen.authorization(endpoint)
							: undefined,
				},
				volumeAttachments,
				this.plan.telemetry &&
					"collectorService" in this.plan.telemetry &&
					alias === this.plan.telemetry.collectorService
					? this.telemetry
					: undefined,
			);
			this.children.push(child);
			const settledMembership = this.network?.begin(child);
			try {
				if (completion.has(alias ?? "")) {
					// A prerequisite's own exit is a startup decision, not stack shutdown.
					await child.wait(this.controller.signal);
					const code = child.outcome?.code;
					if (code !== 0)
						throw new Error(
							"Compose prerequisite did not complete successfully; dependents were not started",
						);
					continue;
				}
				void child.done
					.then(() => this.stop())
					.catch(() => {
						/* Cleanup uncertainty retains the stack lease. */
					});
				await child.ready(this.controller.signal);
			} finally {
				settledMembership?.();
			}
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
		this.ownedNetwork?.closeAdmission();
		this.stopping = (async () => {
			this.controller.abort();
			try {
				await this.starting;
			} catch {
				/* Partial creation is still cleaned with live receipts only. */
			}
			await this.observing;
			for (const child of [...this.children].reverse())
				try {
					await child.stop();
				} catch {
					this.failedCleanup = true;
				}
			try {
				await this.telemetry?.close();
			} catch {
				this.failedCleanup = true;
			}
			try {
				this.network?.release();
				await this.ownedNetwork?.stop();
			} catch {
				this.failedCleanup = true;
			}
			if (!this.cleanupFailed)
				try {
					await this.volumes?.stop();
				} catch {
					this.failedCleanup = true;
				}
			const exits = this.children.map((child) => child.outcome);
			const code =
				this.cleanupFailed ||
				(!exits.length && !this.plan.compose?.networkOnly) ||
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
