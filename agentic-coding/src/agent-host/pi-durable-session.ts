// Shared bootstrap for named workflowless native sessions. One dedicated
// coding-session host serves immutable registry/native bindings; sidebar and
// background scheduler recovery reuse this same lifecycle. These sessions are
// independent of Home/workflows and inherit no operator server capability.
import fs from "node:fs";
import { resolveConfigRoot } from "../config-root.ts";
import {
	bindDurableSession,
	createDurableSession,
	type DurableSessionRegistry,
	durableSessionOwner,
	initializeDurableSessions,
	requireDurableSession,
	selectDurableSession,
} from "../pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../pi-durable-state.ts";
import { selfExecEntry } from "../self-exec.ts";
import { writeAgentRunEnv } from "../workflow/run-env.ts";
import { ensureHostRunning, HostClient } from "./client.ts";
import { hostLayout } from "./layout.ts";

export interface PiDurableSession {
	/** Run id (also the host's conversation name) of the active session. */
	readonly runId: string;
	readonly hostSocket: string;
	readonly sessionId: string;
	readonly name?: string;
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
	"AGENTIC_ORCHESTRATOR_TOKEN",
	"AGENTIC_ORCHESTRATOR_URL",
	"AGENTIC_ENV_TOKEN",
	"AGENTIC_ENV_URL",
	"AGENTIC_ENV_OWNER",
	"AGENTIC_SERVER_TOKEN",
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
	options: {
		fresh?: boolean;
		sessionId?: string;
		operationId?: string;
		name?: string;
		select?: boolean;
		cwd?: string;
		model?: PiDurableModel;
		toolPolicy?: "default" | "collection";
		configDir?: string;
		gitlabHosts?: readonly string[];
		gitlabToolHost?: string;
		repositoryRoots?: readonly string[];
	} = {},
): Promise<PiDurableSession> {
	const runtimeDir = piDurableRuntimeDir(options.configDir);
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const owner = durableSessionOwner();
	let registry: DurableSessionRegistry;
	try {
		registry = initializeDurableSessions(
			runtimeDir,
			options.cwd ?? process.cwd(),
			owner,
		);
	} catch (error) {
		throw new Error(
			"Cannot reopen pi-durable session: metadata is unreadable or invalid; no replacement conversation was created.",
			{ cause: error },
		);
	}
	const id = options.sessionId ?? registry.activeId;
	const operationId = options.operationId ?? crypto.randomUUID();
	const record = options.fresh
		? createDurableSession(runtimeDir, {
				operationId,
				owner,
				name: options.name ?? `Coding session ${operationId.slice(0, 8)}`,
				cwd: options.cwd ?? process.cwd(),
				...options.model,
				...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
				...(options.gitlabHosts ? { gitlabHosts: options.gitlabHosts } : {}),
				...(options.gitlabToolHost
					? { gitlabToolHost: options.gitlabToolHost }
					: {}),
				...(options.repositoryRoots
					? { repositoryRoots: options.repositoryRoots }
					: {}),
			})
		: id
			? requireDurableSession(registry, id, owner)
			: undefined;
	if (!record)
		throw new Error(
			"No active durable session. Explicitly create or select a session; no replacement conversation was created.",
		);
	// Select at intent time, never when a slower recovery finishes after a
	// newer user selection. Background admission always passes select:false.
	if (options.select !== false)
		selectDurableSession(runtimeDir, record.id, owner);
	const name = record.runId;
	const layout = hostLayout(runtimeDir);
	const cwd = record.cwd;
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
		env: {
			...piDurableHostEnv(),
			AGENTIC_CODING_CONFIG_DIR: resolveConfigRoot(options.configDir),
		},
	});
	// Rewritten from immutable session defaults, never current shell cwd/model;
	// the host rereads this file during exact recovery.
	const runEnvPath = writeAgentRunEnv({
		cwd,
		runDirectory: runtimeDir,
		runId: name,
		environment:
			record.toolPolicy === "collection"
				? {
						HERDR_DIGEST_GITLAB_HOSTS: JSON.stringify(record.gitlabHosts ?? []),
						HERDR_DIGEST_GITLAB_TOOL_HOST: record.gitlabToolHost ?? "",
						HERDR_DIGEST_REPOSITORY_ROOTS: JSON.stringify(
							record.repositoryRoots ?? [record.cwd],
						),
					}
				: {},
	});
	const client = new HostClient(layout.socketPath);
	const hostId = await client.scheduledIdentity();
	if (record.binding && record.binding.hostId !== hostId)
		throw new Error(
			"Durable session store identity changed; refusing replacement.",
		);
	const request = {
		runId: name,
		cwd,
		runEnvPath,
		name,
		toolPolicy: record.toolPolicy ?? "default",
		...(record.model ? { model: record.model } : {}),
		...(record.thinking ? { thinking: record.thinking } : {}),
	};
	const existingId =
		record.binding?.conversationId ?? (await client.resolveSession(name));
	if (!existingId && record.operationId === "legacy-adoption")
		throw new Error(
			"Legacy durable conversation is unavailable; no replacement was created.",
		);
	const opened = existingId
		? await client.recoverRun({
				...request,
				expectedConversationId: existingId,
			})
		: await client.ensureRun(request);
	bindDurableSession(runtimeDir, record.id, owner, {
		hostId,
		conversationId: opened.conversationId,
	});
	return {
		runId: name,
		hostSocket: layout.socketPath,
		sessionId: record.id,
		name: record.name,
	};
}
