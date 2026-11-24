import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { createDockerInspectionAdapter } from "../adapters/docker/container-inspection.ts";
import { createRuntimeExecutor } from "../adapters/process/runtime-executor.ts";
import type { parseSharedServerOptions } from "../cli/shared-options.ts";
import { readPrivateTokenFile } from "../configuration/private-token.ts";
import { readConfigurationJson } from "../configuration/read-json.ts";
import { loadSecretSource } from "../configuration/secrets.ts";
import { identifier } from "../configuration/server-manifest.ts";
import { readV2Configuration } from "../configuration/v2-configuration.ts";
import { serveMcpHttp } from "../mcp/serve-http.ts";
import { openDiagnosticsLog } from "../persistence/diagnostics-log.ts";
import { createCatalogService } from "./catalog-service.ts";
import { createConfigurationRefresh } from "./configuration-refresh.ts";
import { createEnvironmentEventBus } from "./event-bus.ts";
import { createExecutionService } from "./execution-service.ts";
import { createIdleReaper } from "./idle-reaper.ts";
import {
	closeIdleRepository,
	createMultiRepositoryExecutionSession,
	createRepositoryRuntime,
} from "./multi-repository-session.ts";
import { openOperationJournal } from "./operation-journal.ts";

const clientsSchema = z.strictObject({
	version: z.literal(1),
	clients: z
		.array(
			z
				.strictObject({
					id: identifier,
					repository: z.string().min(1).max(4096).optional(),
					repositories: z
						.array(z.string().min(1).max(4096))
						.min(1)
						.max(64)
						.optional(),
					tokenEnv: z
						.string()
						.regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
						.optional(),
					tokenFile: z.string().min(1).max(4096).optional(),
				})
				.refine(
					(client) =>
						Boolean(client.repository) !== Boolean(client.repositories),
					{
						message: "Exactly one repository or repositories list is required",
					},
				)
				.refine(
					(client) => Boolean(client.tokenEnv) !== Boolean(client.tokenFile),
					{ message: "Exactly one client credential reference is required" },
				),
		)
		.min(1)
		.max(32),
});

/** One environment authority and one authenticated MCP listener. */
export async function startSharedServer(
	options: ReturnType<typeof parseSharedServerOptions>,
) {
	const manifest = readV2Configuration(options.configDir);
	if (manifest.repositories.some((root) => fs.realpathSync(root) !== root))
		throw new Error("Shared mode requires canonical repository paths");
	const clients = clientsSchema.parse(
		readConfigurationJson(options.clients),
	).clients;
	if (new Set(clients.map((client) => client.id)).size !== clients.length)
		throw new Error("Duplicate client identity");
	const authenticatedClients = clients.map((client) => {
		const token = client.tokenEnv
			? process.env[client.tokenEnv]
			: client.tokenFile
				? readPrivateTokenFile(client.tokenFile)
				: undefined;
		const repositories =
			client.repositories ?? (client.repository ? [client.repository] : []);
		if (
			!repositories.length ||
			new Set(repositories).size !== repositories.length ||
			repositories.some(
				(repository) =>
					typeof repository !== "string" ||
					!manifest.repositories.includes(repository),
			) ||
			!token ||
			!/^[A-Za-z0-9_-]{32,128}$/.test(token)
		)
			throw new Error("Invalid client binding or missing credential reference");
		return { ...client, repositories, token };
	});
	if (
		new Set(authenticatedClients.map((client) => client.token)).size !==
		authenticatedClients.length
	)
		throw new Error("Duplicate client credential");
	const journal = openOperationJournal(
		options.directory,
		manifest.repositories,
	);
	let mcp: ReturnType<typeof serveMcpHttp> | undefined;
	let stopSessions: (() => Promise<void>) | undefined;
	let diagnostics: ReturnType<typeof openDiagnosticsLog> | undefined;
	const idleAbort = new AbortController();
	let idleTimer: ReturnType<typeof setInterval> | undefined;
	try {
		diagnostics = openDiagnosticsLog(options.directory);
		const events = createEnvironmentEventBus();
		const execution = createExecutionService(
			manifest,
			journal,
			createDockerInspectionAdapter(),
			createRuntimeExecutor(),
			loadSecretSource(options.configDir),
			{
				telemetryDirectory: options.directory,
				configDir: options.configDir,
				onEvent: (event) => events.publish(event),
			},
		);
		const bindings = authenticatedClients.map((client) => {
			const runtimes = client.repositories.map((repository) =>
				createRepositoryRuntime({
					repository,
					create: () => {
						const scope = journal.createScope(
							client.id,
							repository,
							randomUUID(),
						);
						return {
							repository,
							scopeId: scope.id,
							scope,
							execution: execution.bind(client.id, scope.id),
						};
					},
				}),
			);
			const primary = runtimes[0];
			if (!primary) throw new Error("Client binding has no repository");
			const boundExecution = createMultiRepositoryExecutionSession(
				manifest,
				journal,
				runtimes,
			);
			const activity = { at: Date.now() };
			return {
				isRefreshIdle: () =>
					runtimes.every((runtime) =>
						runtime
							.all()
							.every(
								(binding) =>
									!journal.scopeHasOpenWork(binding.scopeId) &&
									!binding.execution.isBusy() &&
									binding.execution.status().owned.length === 0,
							),
					),
				token: client.token,
				repositories: client.repositories,
				execution: boundExecution,
				activity,
				touch: () => {
					activity.at = Date.now();
				},
				onAction: (action: string, code?: string) => {
					diagnostics?.append({
						event: "capability",
						action,
						scope: primary.current.scope.id,
						...(code ? { code } : {}),
					});
				},
				idle: {
					lastActivity: () => activity.at,
					touch: (now: number) => {
						activity.at = now;
					},
					isBusy: () => boundExecution.isBusy(),
					ownedApps: () => [
						...new Set(boundExecution.status().owned.map((item) => item.app)),
					],
					stopApp: async (app: string, signal: AbortSignal) => {
						const stopped = [];
						for (const runtime of runtimes) {
							if (runtime.current.scope.state !== "active") continue;
							if (
								!runtime.current.execution
									.status()
									.owned.some((item) => item.app === app)
							)
								continue;
							stopped.push(await runtime.current.execution.stop(app, signal));
						}
						return stopped;
					},
					close: async () => {
						for (const runtime of runtimes)
							await closeIdleRepository(runtime, journal);
					},
				},
			};
		});
		stopSessions = async () => {
			await Promise.allSettled(
				bindings.map((binding) => binding.execution.shutdown()),
			);
		};
		if (options.idleTimeoutSec > 0) {
			const reaper = createIdleReaper(
				bindings.map((binding) => binding.idle),
				options.idleTimeoutSec * 1000,
				{ signal: idleAbort.signal },
			);
			idleTimer = setInterval(
				() => void reaper.tick(),
				Math.min(
					30_000,
					Math.max(1_000, Math.floor(options.idleTimeoutSec * 500)),
				),
			);
			idleTimer.unref?.();
		}
		mcp = serveMcpHttp(
			createCatalogService({
				file: path.join(options.configDir, "environments.json"),
				format: "v2-config",
				repositories: [],
			}),
			bindings,
			{
				port: options.port,
				events,
				refresh: createConfigurationRefresh({
					configDir: options.configDir,
					repositories: [...manifest.repositories],
					isIdle: () => bindings.every((binding) => binding.isRefreshIdle()),
					apply: (next) => execution.refresh(next),
				}),
			},
		);
		diagnostics.append({ event: "startup", count: bindings.length });
		let stopping: Promise<void> | undefined;
		return {
			url: mcp.url,
			stop() {
				stopping ??= (async () => {
					if (idleTimer) clearInterval(idleTimer);
					idleAbort.abort();
					await stopSessions?.();
					diagnostics?.append({ event: "shutdown" });
					const listeners = await Promise.allSettled([mcp?.stop()]);
					diagnostics?.close();
					journal.close();
					if (listeners.some((result) => result.status === "rejected"))
						throw new Error("Listener shutdown failed");
				})();
				return stopping;
			},
		};
	} catch (error) {
		if (idleTimer) clearInterval(idleTimer);
		idleAbort.abort();
		await stopSessions?.();
		diagnostics?.append({ event: "error", code: "startup-failed" });
		await Promise.allSettled([mcp?.stop()]);
		diagnostics?.close();
		journal.close();
		throw error;
	}
}
