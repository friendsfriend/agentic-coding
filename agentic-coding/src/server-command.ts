// `agentic-coding server` — headless environment backend. No renderer, no
// observer: the same owned, identity-verified backend the unified shell starts,
// held in the foreground until a signal releases it through the same Effect
// scope (src/backend/lifecycle.ts). No lifecycle logic lives here.
import { BackendStartupError, serveOwnedBackend } from "./backend/lifecycle.ts";

function arg(args: string[], ...flags: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i])) return args[i + 1];
		const inline = flags.find((flag) => args[i].startsWith(`${flag}=`));
		if (inline) return args[i].slice(inline.length + 1);
	}
	return undefined;
}

export async function runHeadlessServer(args: string[]): Promise<void> {
	const port = arg(args, "-p", "--port") ?? "4050";
	const instance = arg(args, "--instance");
	const numericPort = Number(port);
	if (
		!Number.isInteger(numericPort) ||
		numericPort < 1 ||
		numericPort > 65535
	) {
		console.error("--port requires a port from 1 to 65535");
		process.exit(1);
	}

	let release!: () => void;
	const signal = new Promise<void>((resolve) => {
		release = resolve;
	});
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(name, () => release());
	}
	// A pending promise alone does not keep Bun's event loop alive, and the
	// inherited-fd child holds no loop handle either: without this, the command
	// would exit 0 immediately and orphan the backend it just spawned.
	const keepAlive = setInterval(() => {}, 2 ** 30);

	try {
		await serveOwnedBackend(
			{
				port: String(numericPort),
				instance,
				onReady: (backend) => {
					process.stdout.write(
						`environment backend ${backend.url} (instance ${backend.instance}, pid ${backend.pid ?? "?"})\n`,
					);
				},
			},
			signal,
		);
	} catch (error) {
		console.error(
			error instanceof BackendStartupError
				? error.message
				: error instanceof Error
					? error.message
					: String(error),
		);
		process.exit(1);
	} finally {
		clearInterval(keepAlive);
	}
	process.exit(0);
}
