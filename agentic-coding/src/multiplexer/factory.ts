// Multiplexer factory and runtime selection (add-multiplexer-adapters,
// tasks 2.1/2.2). Selection is resolved once from
// `AGENTIC_CODING_MULTIPLEXER` over top-level `multiplexer` configuration,
// defaulting to Herdr. An unsupported selector fails validation with the
// supported identifiers, and a selected runtime whose executable or socket is
// unavailable fails loudly instead of silently falling back.
import fs from "node:fs";
import { Effect } from "effect";
import { loadConfig } from "../workflow/effects.ts";
import { Herdr as DefaultHerdrCli } from "./herdr/cli.ts";
import { HerdrMultiplexer } from "./herdr/index.ts";
import { LuvusMultiplexer } from "./luvus/index.ts";
import { resolveLuvusSocketPath } from "./luvus/uhp.ts";
import {
	type AgentLifecycleOps,
	MultiplexerError,
	type MultiplexerId,
	type MultiplexerPort,
} from "./port.ts";

export const MULTIPLEXER_IDS: readonly MultiplexerId[] = ["herdr", "luvus"];

export interface MultiplexerSelectionInput {
	configMultiplexer?: string;
	env?: NodeJS.ProcessEnv;
}

/** Resolve the one effective selector; the environment variable wins over the
 * configured value and `herdr` is the default. */
export function resolveMultiplexerSelection(
	input: MultiplexerSelectionInput = {},
): MultiplexerId {
	const env = input.env ?? process.env;
	const raw =
		env.AGENTIC_CODING_MULTIPLEXER ?? input.configMultiplexer ?? "herdr";
	if (raw === "herdr" || raw === "luvus") return raw;
	throw new Error(
		`unsupported multiplexer '${raw}'; supported multiplexers: ${MULTIPLEXER_IDS.join(", ")}`,
	);
}

/** Resolve the selector from the loaded application configuration. Kept behind
 * one function so no call site re-reads the selector. A configuration that
 * cannot be loaded fails here: it must never silently degrade to the default
 * runtime, because the configured selection could have been a different one. */
export function configuredMultiplexer(): MultiplexerId {
	return resolveMultiplexerSelection({
		configMultiplexer: loadConfig().multiplexer,
	});
}

export interface CreateMultiplexerOptions {
	session?: string;
	binPath?: string;
	socketPath?: string;
}

function unavailableRuntime(
	id: MultiplexerId,
	detail: string,
): MultiplexerError {
	return new MultiplexerError(
		"unavailable",
		id,
		`selected multiplexer '${id}' is unavailable: ${detail}`,
	);
}

/** Construct the selected adapter. A missing selected runtime throws a bounded
 * diagnostic naming the runtime; no other runtime is constructed. */
export function createMultiplexerPort(
	id: MultiplexerId = configuredMultiplexer(),
	options: CreateMultiplexerOptions = {},
): MultiplexerPort {
	if (id === "herdr") {
		const binPath = options.binPath ?? process.env.HERDR_BIN_PATH;
		const executable = binPath ?? "herdr";
		if (!Bun.which(executable))
			throw unavailableRuntime("herdr", `executable '${executable}' not found`);
		return new HerdrMultiplexer(new DefaultHerdrCli(), {
			...(binPath ? { binPath } : {}),
			...((options.socketPath ?? process.env.HERDR_SOCKET_PATH)
				? { socketPath: options.socketPath ?? process.env.HERDR_SOCKET_PATH }
				: {}),
		});
	}
	const session = options.session ?? process.env.LUVUS_SESSION;
	const socketPath =
		options.socketPath ??
		resolveLuvusSocketPath({
			...process.env,
			...(session ? { LUVUS_SESSION: session } : {}),
		});
	if (!socketPath)
		throw unavailableRuntime(
			"luvus",
			"no socket path resolved from LUVUS_SOCKET_PATH/LUVUS_HOME",
		);
	if (!fs.existsSync(socketPath))
		throw unavailableRuntime("luvus", `socket '${socketPath}' not found`);
	return new LuvusMultiplexer({
		socketPath,
		...(session ? { session } : {}),
		...((options.binPath ?? process.env.LUVUS_BIN_PATH)
			? { binPath: options.binPath ?? process.env.LUVUS_BIN_PATH }
			: {}),
	});
}

/** Build the workflow adapter lifecycle from the selected port: launch,
 * prompt, observe, and stop all cross the port boundary. */
export function agentLifecycleOps(port: MultiplexerPort): AgentLifecycleOps {
	return {
		start: (input) => port.agentStart(input),
		prompt: (target, message, signal) =>
			port.agentPrompt(target, message, signal),
		observe: (target) =>
			port.agentGet(target).pipe(
				Effect.flatMap((agent) =>
					agent
						? Effect.succeed({
								status: agent.status,
								paneId: agent.paneId,
								...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
							})
						: Effect.fail(
								new MultiplexerError(
									"absent",
									port.id,
									`agent target not found: ${target}`,
								),
							),
				),
			),
		stop: (target) => port.paneClose(target),
	};
}

let defaultPort: MultiplexerPort | undefined;

/** The process-scoped default port, constructed lazily and memoized. The
 * application roots call this; tests may override it. */
export function multiplexerPort(): MultiplexerPort {
	defaultPort ??= createMultiplexerPort();
	return defaultPort;
}

/** Test/application seam: replace the memoized default port (undefined resets
 * it so the next read re-resolves selection). */
export function setMultiplexerPortForTests(
	port: MultiplexerPort | undefined,
): void {
	defaultPort = port;
}
