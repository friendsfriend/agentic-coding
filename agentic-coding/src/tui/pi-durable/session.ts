// Host bootstrap for the sidebar's Pi Durable coding session. One dedicated
// durable host (`<config root>/pi-durable/agent-host/`) runs in coding-session
// mode (`agent host --session`), and one persistent conversation in it is "the"
// session until `/new` starts another. It is the Orchestrator's transcript and
// prompt over a plain coding agent: no workflow tools, no orchestrator
// capability, and none of the operator's server tokens.
import fs from "node:fs";

import { ensureHostRunning, HostClient } from "../../agent-host/client.ts";
import { hostLayout } from "../../agent-host/layout.ts";
import {
	currentPiDurableSessionName,
	DEFAULT_PI_DURABLE_SESSION_NAME,
	piDurableRuntimeDir,
	savePiDurableSessionName,
} from "../../pi-durable-state.ts";
import { selfExecEntry } from "../../self-exec.ts";
import { writeAgentRunEnv } from "../../workflow/run-env.ts";

export interface PiDurableSession {
	/** Run id (also the host's conversation name) of the active session. */
	readonly runId: string;
	readonly hostSocket: string;
}

export interface PiDurableModel {
	readonly model?: string;
	readonly thinking?: string;
}

/** Environment variables a coding session must never inherit: the operator
 * capabilities would let it act beyond its own repository. */
const STRIPPED_ENV = [
	"AGENTIC_WORKFLOW_TOKEN",
	"AGENTIC_DEVENV_TOKEN",
	"AGENTIC_WORKFLOW_URL",
] as const;

/** The child environment for the coding-session host: the parent's, minus every
 * operator capability. */
export function piDurableHostEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const next = { ...env };
	for (const key of STRIPPED_ENV) delete next[key];
	return next;
}

/** Ensure the coding-session host runs and its active conversation exists.
 * `fresh` starts a new conversation and makes it the active one. The working
 * directory is the repository the shell is showing. */
export async function openPiDurableSession(
	options: { fresh?: boolean; cwd?: string; model?: PiDurableModel } = {},
): Promise<PiDurableSession> {
	const runtimeDir = piDurableRuntimeDir();
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const name = options.fresh
		? `pi-durable-${Date.now().toString(36)}`
		: (currentPiDurableSessionName(runtimeDir) ??
			DEFAULT_PI_DURABLE_SESSION_NAME);
	if (options.fresh) savePiDurableSessionName(runtimeDir, name);
	const layout = hostLayout(runtimeDir);
	const cwd = options.cwd ?? process.cwd();
	const entry = selfExecEntry();
	await ensureHostRunning(layout, {
		command: process.execPath,
		args: [
			...(entry ? [entry] : []),
			"agent",
			"host",
			"--workflow-dir",
			runtimeDir,
			"--session",
		],
		cwd,
		env: piDurableHostEnv(),
	});
	// Rewritten on every open: the working directory follows the shell, and the
	// host rereads this file on `ensureRun`.
	const runEnvPath = writeAgentRunEnv({
		cwd,
		runDirectory: runtimeDir,
		runId: name,
		environment: {},
	});
	const client = new HostClient(layout.socketPath);
	await client.ensureRun({
		runId: name,
		cwd,
		runEnvPath,
		name,
		toolPolicy: "default",
		...(options.model?.model ? { model: options.model.model } : {}),
		...(options.model?.thinking ? { thinking: options.model.thinking } : {}),
	});
	// `ensureRun` applies the model only when it creates the conversation; a
	// live selection passed by the caller is the session default on every open.
	if (options.model?.model || options.model?.thinking)
		await client.configureRun(name, {
			...(options.model.model ? { model: options.model.model } : {}),
			...(options.model.thinking ? { thinking: options.model.thinking } : {}),
		});
	return { runId: name, hostSocket: layout.socketPath };
}
