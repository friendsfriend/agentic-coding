// Host bootstrap for the Home Orchestrator session. One dedicated durable host
// (`<config root>/orchestrator/agent-host/`) runs in orchestrator mode, and one
// persistent conversation in it is "the" orchestrator session until `/new`
// starts another. The session talks to this shell's unified server through the
// orchestrator capability (`orchestratorTokenFor`), never the instance token:
// the token is written into the session's private run environment and stripped
// from the host process environment.
import fs from "node:fs";

import { ensureHostRunning, HostClient } from "../../agent-host/client.ts";
import { hostLayout } from "../../agent-host/layout.ts";
import {
	OPENCODE_CWD_ENV,
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "../../agent-host/orchestrator-env.ts";
import { resolveDevenvHome } from "../../backend/home.ts";
import {
	currentSessionName,
	orchestratorRuntimeDir,
	saveOrchestratorSessionName,
} from "../../orchestrator-state.ts";
import { selfExecEntry } from "../../self-exec.ts";
import { orchestratorTokenFor } from "../../server/auth.ts";
import { writeAgentRunEnv } from "../../workflow/run-env.ts";

export interface OrchestratorSession {
	/** Run id (also the host's conversation name) of the active session. */
	readonly runId: string;
	readonly hostSocket: string;
}

export interface OrchestratorModel {
	readonly model?: string;
	readonly thinking?: string;
}

/** Environment variables a host must never inherit: the instance capability
 * would let the session act beyond its orchestrator policy. */
const STRIPPED_ENV = [
	"AGENTIC_WORKFLOW_TOKEN",
	"AGENTIC_DEVENV_TOKEN",
	"AGENTIC_WORKFLOW_URL",
] as const;

/** Re-exported so every existing caller keeps importing this module. */
export { currentSessionName, orchestratorRuntimeDir };

const saveSessionName = saveOrchestratorSessionName;

/** The child environment for the orchestrator host: the parent's, minus every
 * operator capability. */
export function orchestratorHostEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const next = { ...env };
	for (const key of STRIPPED_ENV) delete next[key];
	return next;
}

/** Ensure the orchestrator host runs and the active session is registered
 * with a fresh server binding and the configured model. `fresh` starts a new
 * conversation and makes it the active one. */
export async function openOrchestratorSession(
	options: {
		fresh?: boolean;
		model?: OrchestratorModel;
		serverUrl?: string;
		serverToken?: string;
		/** The shell's primary repository, shared with embedded OpenCode. */
		opencodeCwd?: string;
	} = {},
): Promise<OrchestratorSession> {
	const serverUrl = options.serverUrl ?? process.env.AGENTIC_WORKFLOW_URL;
	const serverToken = options.serverToken ?? process.env.AGENTIC_WORKFLOW_TOKEN;
	if (!serverUrl || !serverToken)
		throw new Error("the Orchestrator needs this shell's workflow server");
	const runtimeDir = orchestratorRuntimeDir();
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const name = options.fresh
		? `orchestrator-${Date.now().toString(36)}`
		: (currentSessionName(runtimeDir) ?? "orchestrator");
	if (options.fresh) saveSessionName(runtimeDir, name);
	const layout = hostLayout(runtimeDir);
	const cwd = resolveDevenvHome();
	const entry = selfExecEntry();
	await ensureHostRunning(layout, {
		command: process.execPath,
		args: [
			...(entry ? [entry] : []),
			"agent",
			"host",
			"--workflow-dir",
			runtimeDir,
			"--orchestrator",
		],
		cwd,
		env: orchestratorHostEnv(),
	});
	// Rewritten on every open: the server URL and capability change with each
	// shell run, and the host rereads this file on `ensureRun`.
	const runEnvPath = writeAgentRunEnv({
		cwd,
		runDirectory: runtimeDir,
		runId: name,
		environment: {
			[ORCHESTRATOR_URL_ENV]: serverUrl,
			[ORCHESTRATOR_TOKEN_ENV]: orchestratorTokenFor(serverToken),
			[OPENCODE_CWD_ENV]:
				options.opencodeCwd ?? process.env[OPENCODE_CWD_ENV] ?? process.cwd(),
		},
	});
	const client = new HostClient(layout.socketPath);
	await client.ensureRun({
		runId: name,
		cwd,
		runEnvPath,
		name,
		toolPolicy: "orchestrator",
		...(options.model?.model ? { model: options.model.model } : {}),
		...(options.model?.thinking ? { thinking: options.model.thinking } : {}),
	});
	// `ensureRun` applies the model only when it creates the conversation; the
	// Settings selection is the session default on every open.
	if (options.model?.model || options.model?.thinking)
		await client.configureRun(name, {
			...(options.model.model ? { model: options.model.model } : {}),
			...(options.model.thinking ? { thinking: options.model.thinking } : {}),
		});
	return { runId: name, hostSocket: layout.socketPath };
}
