// The one composition of the environment stack (fix-env-tools-round-2).
//
// Two composition roots own a server: the headless `agentic-coding server`
// (`src/server-command.ts`) and the TUI's own listener (`src/tui/index.tsx`).
// They used to build the runtime families independently, and the TUI's copy
// attached no container runtime at all: the agent environment routes answered
// `env_logs ... no container runtime is available: the server attached no
// container-runtime capability at all`, and an infrastructure service's state
// read `unknown` although no such container existed, because the routes had no
// client to probe with. The slot controller still started docker apps (it
// selects the runtime itself) and the app family had no docker either, so the
// defect was a *missing wire*, not a missing capability — and it is invisible
// from the controller's own tests.
//
// So the stack is built here once: run observation, the script lifecycle, the
// runtime routes (container client, cluster service, dispatch) and the
// integration services that serve them. A composition root that wants an
// environment surface calls this; nothing else may assemble the pieces by hand.
//
// What is deliberately *not* here: the HTTP listener and the environment
// state/catalog authority. A root owns that decision (the headless server always
// owns one, the TUI only when it owns the backend), and the authority must exist
// before the integrations can be built.
import { recordCommandlessRun } from "./actions/routes.ts";
import type { App } from "./environment/config.ts";
import type { OtelReceiverTarget } from "./environment/instances/variables.ts";
import type { EnvironmentManager } from "./environment/manager.ts";
import type { IntegrationServices } from "./integrations/routes.ts";
import {
	createIntegrationServices,
	type EnvironmentStateStorePort,
} from "./integrations/services.ts";
import type { LegacyRuntimeEvent } from "./runtime/routes.ts";
import { RunObservation } from "./runtime/run-observation.ts";
import { ScriptInfrastructure } from "./runtime/script-infrastructure.ts";
import {
	createRuntimeServices,
	type RuntimeServices,
} from "./runtime/services.ts";
import { startStatusPollers } from "./runtime/status-broadcast.ts";

export interface EnvironmentStackOptions {
	readonly configDir: string;
	readonly homeDir: string;
	readonly manager: EnvironmentManager;
	readonly state: EnvironmentStateStorePort;
	/** Container runtime the stack selects (`DEVENV_CONTAINER_RUNTIME` when
	 * omitted, then `docker`). */
	readonly runtimeName?: string;
	/** Environment the runtime selection and the container commands read;
	 * defaults to this process's. */
	readonly env?: Record<string, string | undefined>;
	/** The telemetry receiver this process bound, so every run it starts exports
	 * the spans `otel_query` scopes by. */
	readonly otelReceiver?: () => OtelReceiverTarget | undefined;
	/** Resolve a workflow owner's managed checkout. Absent: the workflow registry
	 * (`createWorkflowOwnerCheckoutResolver`), the only resolver production
	 * uses. */
	readonly resolveOwnerCheckout?: (
		owner: `workflow:${string}`,
		app: App,
	) => string | undefined | Promise<string | undefined>;
	/** Resolve a workflow owner's drafts overlay. Absent: the live configuration. */
	readonly resolveOwnerOverlay?: (
		owner: `workflow:${string}`,
		app: App,
	) => string | undefined;
	/** The legacy runtime event sink (`POST /api/docker/*` and the container
	 * listener). Late-bound by the caller through this holder, because the action
	 * engine's stream exists only after the integrations are built. */
	readonly legacyStream?: (event: LegacyRuntimeEvent) => void;
	/** Publishes one status event; when given, the app/infrastructure status
	 * pollers run on the stack's own signal. */
	readonly publish?: (event: {
		readonly type: string;
		readonly properties: Record<string, unknown>;
		readonly timestamp: string;
	}) => void;
	readonly logger?: (message: string) => void;
}

export interface EnvironmentStack {
	readonly integrations: IntegrationServices;
	readonly runtime: RuntimeServices;
	/** Stops the runtime scope: listeners, watchers, pollers and timers. */
	stop(): void;
}

/**
 * Build the environment stack over one configuration authority.
 *
 * The action engine and the runtime routes depend on each other (the route
 * records a commandless run, the engine's stream is the runtime's fan-out), so
 * both wires are late-bound through one holder instead of the stack taking an
 * order it cannot have.
 */
export async function createEnvironmentStack(
	options: EnvironmentStackOptions,
): Promise<EnvironmentStack> {
	const wire: { integrations?: IntegrationServices } = {};
	const observation = new RunObservation({
		store: options.state as never,
		...(options.logger ? { logger: options.logger } : {}),
	});
	// The script lifecycle owner decides how a script service launches (logged, or
	// a tmux window when the server runs inside tmux) and reports its status; the
	// action engine's process handler and the slot controller's shell runs both
	// defer to it, so one process's exit is recorded once.
	const scriptInfra = new ScriptInfrastructure({
		runCommand: (command, args) =>
			new Promise((resolve) => {
				const child = Bun.spawn([command, ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});
				let output = "";
				void (async () => {
					for await (const chunk of child.stdout)
						output += new TextDecoder().decode(chunk);
					for await (const chunk of child.stderr)
						output += new TextDecoder().decode(chunk);
				})();
				child.exited.then((code) =>
					resolve({
						output,
						...(code === 0
							? {}
							: {
									error: new Error(
										`${command} ${args.join(" ")}: exit ${code}`,
									),
								}),
					}),
				);
			}),
		...(options.logger ? { logger: options.logger } : {}),
	});
	const runtime = await createRuntimeServices({
		scriptInfra,
		observation,
		apps: () => options.manager.getApps(),
		infraServices: () => options.manager.getInfraServices(),
		...(options.runtimeName ? { runtimeName: options.runtimeName } : {}),
		...(options.env ? { env: options.env } : {}),
		...(options.legacyStream
			? {
					stream: {
						publish: (event) =>
							options.legacyStream?.(event as LegacyRuntimeEvent),
					},
				}
			: {}),
		publish: (event) => {
			const context = wire.integrations?.actions;
			if (context) context.services.publish(event as never);
		},
		recordCommandlessRun: (input) => {
			const context = wire.integrations?.actions;
			if (context) recordCommandlessRun(context, input);
		},
		...(options.logger ? { logger: options.logger } : {}),
	});
	const integrations = createIntegrationServices({
		manager: options.manager,
		state: options.state,
		configDir: options.configDir,
		homeDir: options.homeDir,
		// The container/Kubernetes capability the agent environment routes read:
		// without it `env_logs` cannot read a docker app, and an infrastructure
		// service's state cannot be probed.
		runtime: runtime.routes,
		runtimeOperation: runtime.dispatch,
		scriptInfra,
		observation,
		...(options.resolveOwnerCheckout
			? { resolveOwnerCheckout: options.resolveOwnerCheckout }
			: {}),
		...(options.resolveOwnerOverlay
			? { resolveOwnerOverlay: options.resolveOwnerOverlay }
			: {}),
		...(options.otelReceiver ? { otelReceiver: options.otelReceiver } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	});
	wire.integrations = integrations;
	const appFamily = integrations.appFamily;
	if (appFamily && options.publish) {
		const publish = options.publish;
		startStatusPollers({
			services: appFamily,
			signal: runtime.signal,
			publish,
			...(options.logger ? { logger: options.logger } : {}),
		});
	}
	return { integrations, runtime, stop: () => runtime.stop() };
}
