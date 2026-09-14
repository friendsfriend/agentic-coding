// `agentic-coding server` — headless unified backend. The Bun workflow/
// telemetry server owns the API and, in migrated mode, the environment state/
// catalog authority as well; the Go child keeps serving the unported
// environment routes and reaches state/configuration through the private
// operations. No renderer, no observer.
import {
	BackendStartupError,
	type OwnedBackend,
	startOwnedBackend,
} from "./backend/lifecycle.ts";
import {
	resolveConfigDir,
	resolveDevenvHome,
} from "./backend/managed-backend.ts";
import {
	bunOwnsEnvironment,
	createEnvironmentAuthority,
} from "./server/environment/authority.ts";
import { createIntegrationServices } from "./server/integrations/services.ts";
import {
	type OwnedWorkflowServer,
	startWorkflowServer,
} from "./server/lifecycle.ts";

function arg(args: string[], ...flags: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i])) return args[i + 1];
		const inline = flags.find((flag) => args[i].startsWith(`${flag}=`));
		if (inline) return args[i].slice(inline.length + 1);
	}
	return undefined;
}

function port(args: string[], label: string, flags: string[]): number {
	const raw = arg(args, ...flags);
	if (raw === undefined) return label === "environment" ? 4050 : 4051;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		console.error(`${flags.join("/")} requires a port from 1 to 65535`);
		process.exit(1);
	}
	return value;
}

export async function runHeadlessServer(args: string[]): Promise<void> {
	const environmentPort = port(args, "environment", ["-p", "--port"]);
	const workflowPort = port(args, "workflow", ["--workflow-port"]);
	const instance = arg(args, "--instance");

	let release!: () => void;
	const signal = new Promise<void>((resolve) => {
		release = resolve;
	});
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(name, () => release());
	}
	// A pending promise alone does not keep Bun's event loop alive, and the
	// inherited-fd child holds no loop handle either: without this, the command
	// would exit 0 immediately and orphan the backends it just spawned.
	const keepAlive = setInterval(() => {}, 2 ** 30);

	let environment: (OwnedBackend & { stop: () => Promise<void> }) | undefined;
	let workflow: OwnedWorkflowServer | undefined;
	let environmentAuthority:
		| ReturnType<typeof createEnvironmentAuthority>
		| undefined;
	let integrations: ReturnType<typeof createIntegrationServices> | undefined;
	try {
		// Migrated mode starts Bun first: the Go child needs the Bun address for
		// its private state/catalog calls, and Bun owns the environment state, so
		// initializing the authority before the child exists means the child never
		// opens a database handle or races the migration.
		const bunOwns = bunOwnsEnvironment();
		if (bunOwns)
			environmentAuthority = createEnvironmentAuthority({
				homeDir: resolveDevenvHome(),
				configDir: resolveConfigDir(),
				logger: (message) => process.stderr.write(`${message}\n`),
			});
		// The Git/provider families are served from the same Bun-owned
		// configuration authority, so the child forwards Git command steps here
		// instead of running a second Git implementation.
		if (environmentAuthority)
			integrations = createIntegrationServices({
				manager: environmentAuthority.manager,
				configDir: resolveConfigDir(),
				logger: (message) => process.stderr.write(`${message}\n`),
			});
		workflow = await startWorkflowServer({
			port: workflowPort,
			// The child may not exist yet; the resolver is read per delegated request.
			environmentBaseUrl: () => environment?.url,
			environmentToken: () => environment?.token,
			...(environmentAuthority ? { environment: environmentAuthority } : {}),
			...(integrations ? { integrations } : {}),
			instance,
			// The headless server owns telemetry persistence/retention.
			ownTelemetry: true,
		});
		environment = await startOwnedBackend({
			port: String(environmentPort),
			instance,
			...(bunOwns
				? {
						environment: {
							url: workflow.url,
							token: workflow.token,
						},
					}
				: {}),
			...(integrations
				? { integrations: { url: workflow.url, token: workflow.token } }
				: {}),
		});
		process.stdout.write(
			`environment backend ${environment.url} (instance ${environment.instance}, pid ${
				environment.pid ?? "?"
			})\n`,
		);
		process.stdout.write(
			`workflow server ${workflow.url} (instance ${workflow.instance})${
				bunOwns ? ", environment owner: bun" : ", environment owner: go"
			}\n`,
		);
		await signal;
	} catch (error) {
		console.error(
			error instanceof BackendStartupError
				? error.message
				: error instanceof Error
					? error.message
					: String(error),
		);
		process.exitCode = 1;
	} finally {
		clearInterval(keepAlive);
		await workflow?.stop().catch(() => {});
		await environment?.stop().catch(() => {});
		environmentAuthority?.state.close();
	}
	process.exit(process.exitCode ?? 0);
}
