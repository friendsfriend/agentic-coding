// `agentic-coding server` — the headless unified backend: one Bun process that
// owns the workflow/observation API, the legacy devenv environment surface, the
// environment state/catalog authority, the action/runtime families, the Git and
// provider families and the telemetry receivers. No renderer, no observer, and
// no companion runtime.

import { resolveConfigDir, resolveDevenvHome } from "./backend/home.ts";
import { recordCommandlessRun } from "./server/actions/routes.ts";
import { createEnvironmentAuthority } from "./server/environment/authority.ts";
import { createIntegrationServices } from "./server/integrations/services.ts";
import {
	DEFAULT_ENVIRONMENT_PORT,
	type OwnedWorkflowServer,
	startWorkflowServer,
} from "./server/lifecycle.ts";
import { RunObservation } from "./server/runtime/run-observation.ts";
import { ScriptInfrastructure } from "./server/runtime/script-infrastructure.ts";
import {
	createRuntimeServices,
	type RuntimeServices,
} from "./server/runtime/services.ts";
import { startStatusPollers } from "./server/runtime/status-broadcast.ts";
import { APP_VERSION } from "./version.ts";

function arg(args: string[], ...flags: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i])) return args[i + 1];
		const inline = flags.find((flag) => args[i].startsWith(`${flag}=`));
		if (inline) return args[i].slice(inline.length + 1);
	}
	return undefined;
}

function portArg(args: string[], flags: string[]): number | undefined {
	const raw = arg(args, ...flags);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		console.error(`${flags.join("/")} requires a port from 1 to 65535`);
		process.exit(1);
	}
	return value;
}

/**
 * The unified server listens on one port. `--workflow-port` is the previous
 * mixed-runtime flag and is accepted as a deprecated alias for `-p/--port`; two
 * different values are an error rather than a silent second listener.
 */
function resolvePort(args: string[]): number {
	const publicPort = portArg(args, ["-p", "--port"]);
	const legacyPort = portArg(args, ["--workflow-port"]);
	if (publicPort !== undefined && legacyPort !== undefined) {
		if (publicPort !== legacyPort) {
			console.error(
				`--workflow-port is a deprecated alias for --port: got ${publicPort} and ${legacyPort}`,
			);
			process.exit(1);
		}
		return publicPort;
	}
	if (legacyPort !== undefined) {
		console.error(
			"--workflow-port is deprecated: the unified server binds one port; use --port",
		);
		return legacyPort;
	}
	return publicPort ?? DEFAULT_ENVIRONMENT_PORT;
}

export async function runHeadlessServer(args: string[]): Promise<void> {
	const serverPort = resolvePort(args);
	const instance = arg(args, "--instance");
	// The instance capability. An operator who wants to attach supplies one
	// (`--token` or AGENTIC_WORKFLOW_TOKEN); otherwise this process generates one
	// and only its own clients can reach it. The token is never printed.
	const suppliedToken =
		arg(args, "--token") ?? process.env.AGENTIC_WORKFLOW_TOKEN;

	let release!: () => void;
	const signal = new Promise<void>((resolve) => {
		release = resolve;
	});
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(name, () => release());
	}
	// A pending promise alone does not keep Bun's event loop alive: without this
	// the command would exit 0 immediately and orphan what it started.
	const keepAlive = setInterval(() => {}, 2 ** 30);

	const homeDir = resolveDevenvHome();
	const configDir = resolveConfigDir();
	let workflow: OwnedWorkflowServer | undefined;
	let environmentAuthority:
		| ReturnType<typeof createEnvironmentAuthority>
		| undefined;
	let runtimeServices: RuntimeServices | undefined;
	try {
		// The environment authority is the only state/config owner: it opens the
		// database and publishes the first catalog snapshot this process serves.
		environmentAuthority = createEnvironmentAuthority({
			homeDir,
			configDir,
			logger: (message) => process.stderr.write(`${message}\n`),
		});
		// The runtime families and the action engine are mutually dependent (the
		// route records a commandless run; the engine's event stream is the
		// runtime's fan-out), so both wires are late-bound through one holder
		// instead of duplicating either owner.
		const actionWire: {
			context?: ReturnType<typeof createIntegrationServices>["actions"];
		} = {};
		const authority = environmentAuthority;
		// The script lifecycle owner decides how a script service launches
		// (logged, or a tmux window when the server runs inside tmux) and reports
		// its status; the action engine's process handler defers to it.
		const observation = new RunObservation({
			store: authority.state,
			logger: (message) => process.stderr.write(`${message}\n`),
		});
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
			logger: (message) => process.stderr.write(`${message}\n`),
		});
		runtimeServices = await createRuntimeServices({
			scriptInfra,
			observation,
			apps: () => authority.manager.getApps(),
			infraServices: () => authority.manager.getInfraServices(),
			stream: {
				publish: (event) => actionWire.context?.stream.publish(event as never),
			},
			publish: (event) => actionWire.context?.services.publish(event as never),
			recordCommandlessRun: (input) => {
				if (actionWire.context) recordCommandlessRun(actionWire.context, input);
			},
			logger: (message) => process.stderr.write(`${message}\n`),
		});
		const integrations = createIntegrationServices({
			manager: authority.manager,
			state: authority.state,
			configDir,
			homeDir,
			logger: (message) => process.stderr.write(`${message}\n`),
			runtime: runtimeServices.routes,
			runtimeOperation: runtimeServices.dispatch,
		});
		actionWire.context = integrations.actions;
		// The status pollers share the runtime scope's signal, so a shutdown stops
		// the listeners, watchers, prune poller and status pollers as one unit and
		// schedules nothing else.
		const appFamily = integrations.appFamily;
		if (appFamily) {
			startStatusPollers({
				services: appFamily,
				signal: runtimeServices.signal,
				publish: (event) => {
					actionWire.context?.stream.publish(event as never);
					actionWire.context?.services.publish(event as never);
				},
				logger: (message) => process.stderr.write(`${message}\n`),
			});
		}
		workflow = await startWorkflowServer({
			port: serverPort,
			instance,
			version: APP_VERSION,
			...(suppliedToken ? { token: suppliedToken } : {}),
			homeDir,
			configDir,
			environment: environmentAuthority,
			integrations,
			// The headless server owns telemetry persistence/retention.
			ownTelemetry: true,
		});
		// The catalog/observation paths in this process read through the same
		// authenticated boundary as any client, so the server must know its own
		// address and capability: without this a catalog read would target the
		// default environment port, which is nobody in a clean install.
		process.env.AGENTIC_DEVENV_URL = workflow.url;
		process.env.AGENTIC_DEVENV_TOKEN = workflow.token;
		// Workflow effects can spawn a dashboard pane from this headless owner;
		// give that child the same authenticated transport handoff as agents.
		process.env.AGENTIC_WORKFLOW_URL = workflow.url;
		process.env.AGENTIC_WORKFLOW_TOKEN = workflow.token;
		process.stdout.write(
			`unified server ${workflow.url} (instance ${workflow.instance}, pid ${process.pid})\n`,
		);
		process.stdout.write(
			suppliedToken
				? "attach with: agentic-coding attach <url> --token <the supplied AGENTIC_WORKFLOW_TOKEN>\n"
				: "generated instance capability: only this session's clients can attach (pass --token or AGENTIC_WORKFLOW_TOKEN to allow attach)\n",
		);
		await signal;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		delete process.env.AGENTIC_WORKFLOW_URL;
		delete process.env.AGENTIC_WORKFLOW_TOKEN;
		clearInterval(keepAlive);
		runtimeServices?.stop();
		await workflow?.stop().catch(() => {});
		environmentAuthority?.state.close();
	}
	process.exit(process.exitCode ?? 0);
}
