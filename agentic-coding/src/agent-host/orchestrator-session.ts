// Non-presentation orchestrator bootstrap shared by the shell and background server.
import fs from "node:fs";
import { resolveDevenvHome } from "../backend/home.ts";
import { configRootEnv } from "../config-root.ts";
import {
	currentSessionName,
	orchestratorRuntimeDir,
	saveOrchestratorSessionName,
} from "../orchestrator-state.ts";
import { selfExecEntry } from "../self-exec.ts";
import { orchestratorTokenFor } from "../server/auth.ts";
import { writeAgentRunEnv } from "../workflow/run-env.ts";
import { ensureHostRunning, HostClient } from "./client.ts";
import { hostLayout } from "./layout.ts";
import {
	OPENCODE_CWD_ENV,
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "./orchestrator-env.ts";
export interface OrchestratorSession {
	readonly runId: string;
	readonly hostSocket: string;
}
export interface OrchestratorModel {
	readonly model?: string;
	readonly thinking?: string;
}
export { currentSessionName, orchestratorRuntimeDir };
export function orchestratorHostEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const next = { ...env };
	for (const key of [
		"AGENTIC_WORKFLOW_TOKEN",
		"AGENTIC_DEVENV_TOKEN",
		"AGENTIC_WORKFLOW_URL",
	])
		delete next[key];
	return next;
}
export async function recoverScheduledOrchestrator(
	target: {
		hostId: string;
		hostSocket: string;
		conversationId: string;
		runId: string;
	},
	server: { serverUrl: string; serverToken: string; configDir?: string },
): Promise<void> {
	const runtimeDir = orchestratorRuntimeDir(server.configDir),
		layout = hostLayout(runtimeDir),
		cwd = resolveDevenvHome();
	if (
		target.hostSocket !== layout.socketPath ||
		!fs.existsSync(layout.storagePath)
	)
		throw new Error(
			"Pinned orchestrator host is unavailable; no replacement was created.",
		);
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
		env: orchestratorHostEnv({
			...process.env,
			...(server.configDir
				? { AGENTIC_CODING_CONFIG_DIR: server.configDir }
				: {}),
		}),
	});
	const client = new HostClient(layout.socketPath);
	if ((await client.scheduledIdentity()) !== target.hostId)
		throw new Error("Pinned orchestrator host identity changed.");
	const runEnvPath = writeAgentRunEnv({
		cwd,
		runDirectory: runtimeDir,
		runId: target.runId,
		environment: {
			[ORCHESTRATOR_URL_ENV]: server.serverUrl,
			[ORCHESTRATOR_TOKEN_ENV]: orchestratorTokenFor(server.serverToken),
			[OPENCODE_CWD_ENV]: process.env[OPENCODE_CWD_ENV] ?? process.cwd(),
		},
	});
	await client.recoverRun({
		runId: target.runId,
		expectedConversationId: target.conversationId,
		cwd,
		runEnvPath,
		name: target.runId,
		toolPolicy: "orchestrator",
	});
}
export async function openOrchestratorSession(
	options: {
		fresh?: boolean;
		configDir?: string;
		model?: OrchestratorModel;
		serverUrl?: string;
		serverToken?: string;
		opencodeCwd?: string;
	} = {},
): Promise<OrchestratorSession & { conversationId: string }> {
	const serverUrl = options.serverUrl ?? process.env.AGENTIC_WORKFLOW_URL,
		serverToken = options.serverToken ?? process.env.AGENTIC_WORKFLOW_TOKEN;
	if (!serverUrl || !serverToken)
		throw new Error("the Orchestrator needs this shell's workflow server");
	const runtimeDir = orchestratorRuntimeDir(options.configDir);
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const name = options.fresh
		? `orchestrator-${Date.now().toString(36)}`
		: (currentSessionName(runtimeDir) ?? "orchestrator");
	if (options.fresh) saveOrchestratorSessionName(runtimeDir, name);
	const layout = hostLayout(runtimeDir),
		cwd = resolveDevenvHome(),
		entry = selfExecEntry();
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
		env: orchestratorHostEnv({
			...process.env,
			...(options.configDir ? configRootEnv(options.configDir) : {}),
		}),
	});
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
	const { conversationId } = await client.ensureRun({
		runId: name,
		cwd,
		runEnvPath,
		name,
		toolPolicy: "orchestrator",
		...(options.model?.model ? { model: options.model.model } : {}),
		...(options.model?.thinking ? { thinking: options.model.thinking } : {}),
	});
	if (options.model?.model || options.model?.thinking)
		await client.configureRun(name, {
			...(options.model.model ? { model: options.model.model } : {}),
			...(options.model.thinking ? { thinking: options.model.thinking } : {}),
		});
	return { runId: name, hostSocket: layout.socketPath, conversationId };
}
