// `agentic-coding server` — headless unified backend. The Bun workflow/
// telemetry server owns the API and delegates unported environment routes to
// the private Go child it spawns. No renderer, no observer.
import {
	BackendStartupError,
	type OwnedBackend,
	startOwnedBackend,
} from "./backend/lifecycle.ts";
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
	try {
		environment = await startOwnedBackend({
			port: String(environmentPort),
			instance,
		});
		workflow = await startWorkflowServer({
			port: workflowPort,
			environmentBaseUrl: environment.url,
			environmentToken: environment.token,
			instance,
			// The headless server owns telemetry persistence/retention.
			ownTelemetry: true,
		});
		process.stdout.write(
			`environment backend ${environment.url} (instance ${environment.instance}, pid ${
				environment.pid ?? "?"
			})\n`,
		);
		process.stdout.write(
			`workflow server ${workflow.url} (instance ${workflow.instance})\n`,
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
	}
	process.exit(process.exitCode ?? 0);
}
